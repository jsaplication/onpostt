'use strict';

const db = require('./db');
const logger = require('./logger');
const stats = require('./stats');
const { ValidationError, isPublicError } = require('./errors');
const { NOTIFICATION_KINDS } = require('./modes');
const { validateBlockDetailed, eqHex } = require('./protocol');
const { verifySignature } = require('./crypto');

const INSERT_SQL = `
  INSERT INTO blocks (id, pubkey, created_at, mode, content, sig, app, query, "from", "to")
  VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8::jsonb, $9, $10)
  ON CONFLICT (id) DO NOTHING
`;

const INSERT_SQL_NO_CHAT = `
  INSERT INTO blocks (id, pubkey, created_at, mode, content, sig, app, query)
  VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8::jsonb)
  ON CONFLICT (id) DO NOTHING
`;

function queryValue(block, key) {
  if (!Array.isArray(block.query)) return undefined;
  const found = block.query.find(([name]) => name === key);
  return found ? found[1] : undefined;
}

function contentParam(block) {
  return block.content === undefined ? null : JSON.stringify(block.content);
}

async function insertBlock(client, block, { id = block.id, pubkey = block.pubkey, withChat = false } = {}) {
  const params = [
    id,
    pubkey,
    block.created_at,
    block.mode,
    contentParam(block),
    block.sig,
    block.app ?? null,
    JSON.stringify(block.query || []),
  ];

  if (withChat) {
    params.push(queryValue(block, 'from') ?? null, queryValue(block, 'to') ?? null);
    return client.query(INSERT_SQL, params);
  }

  return client.query(INSERT_SQL_NO_CHAT, params);
}

async function assertTargetExists(client, block, { requireOwner = false } = {}) {
  const targetId = queryValue(block, 'block');
  if (typeof targetId !== 'string') return null;

  const result = await client.query(
    "SELECT id, pubkey, mode FROM blocks WHERE id = $1 AND mode <> 'delete' LIMIT 1",
    [targetId]
  );
  const target = result.rows[0];

  if (!target) {
    throw new ValidationError(`Bloco alvo (${targetId}) não encontrado.`, { code: 'target_not_found' });
  }

  if (requireOwner && String(target.pubkey).toLowerCase() !== String(block.pubkey).toLowerCase()) {
    throw new ValidationError(
      `Bloco alvo (${targetId}) não pertence ao autor.`,
      { code: 'target_not_owned' }
    );
  }

  return target;
}

async function assertTargetNotDeleted(client, target) {
  if (!target) return;
  const result = await client.query(
    `SELECT 1
     FROM blocks d
     WHERE d.mode = 'delete'
       AND lower(d.pubkey) = lower($1)
       AND d.query @> jsonb_build_array(
         jsonb_build_array('block'::text, $2::text)
       )
     LIMIT 1`,
    [target.pubkey, target.id]
  );
  if (result.rowCount > 0) {
    throw new ValidationError(`Bloco alvo (${target.id}) foi excluído.`, { code: 'target_deleted' });
  }
}

/**
 * Respostas só podem apontar para um comentário do mesmo bloco alvo.
 * O comentário pai precisa existir e não pode ter sido excluído.
 */
async function assertCommentParent(client, block, target) {
  const parentId = queryValue(block, 'parent');
  if (typeof parentId !== 'string') return null;

  const result = await client.query(
    "SELECT id, pubkey, mode, query FROM blocks WHERE id = $1 AND mode = 'comment' LIMIT 1",
    [parentId]
  );
  const parent = result.rows[0];

  if (!parent) {
    throw new ValidationError(`Comentário pai (${parentId}) não encontrado.`, {
      code: 'parent_not_found',
    });
  }

  const parentTarget = Array.isArray(parent.query)
    ? parent.query.find((pair) => Array.isArray(pair) && pair[0] === 'block')?.[1]
    : undefined;

  if (String(parentTarget).toLowerCase() !== String(target.id).toLowerCase()) {
    throw new ValidationError('O comentário pai pertence a outro bloco.', {
      code: 'parent_mismatch',
    });
  }

  await assertTargetNotDeleted(client, parent);
  return parent;
}

async function lockKey(client, block) {
  const target = queryValue(block, 'block') || queryValue(block, 'following') || '';
  const normalizedPubkey = String(block.pubkey).toLowerCase();
  const normalizedTarget = block.mode === 'follow' ? String(target).toLowerCase() : target;
  const parts = [normalizedPubkey, block.mode, normalizedTarget];
  if (block.mode === 'reaction') parts.push(String(queryValue(block, 'reaction') || ''));
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))', [
    'onpostt',
    parts.join(':'),
  ]);
}

async function lockNotification(client, block) {
  const interaction = String(queryValue(block, 'interaction') || '').toLowerCase();
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))', [
    'onpostt:notification',
    interaction,
  ]);
}

/**
 * Serializa bloqueio/desbloqueio e envio de mensagens entre o mesmo par de
 * pubkeys. Sem isso, uma mensagem poderia passar na verificação enquanto um
 * bloqueio concorrente ainda está sendo gravado.
 */
async function lockBlockPair(client, first, second) {
  const left = String(first).toLowerCase();
  const right = String(second).toLowerCase();
  const key = left < right ? `${left}:${right}` : `${right}:${left}`;
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))', [
    'onpostt:blockpair',
    key,
  ]);
}

async function pairIsBlocked(client, blocker, blocked) {
  const result = await client.query(
    `SELECT 1
     FROM blocks
     WHERE mode = 'block'
       AND lower((
             jsonb_path_query_first(
               query,
               'strict $[*] ? (@[0] == "blocker")'
             ) ->> 1
           )) = lower($1)
       AND lower((
             jsonb_path_query_first(
               query,
               'strict $[*] ? (@[0] == "blocked")'
             ) ->> 1
           )) = lower($2)
     LIMIT 1`,
    [blocker, blocked]
  );
  return result.rowCount > 0;
}

async function assertNotBlocked(client, first, second) {
  if ((await pairIsBlocked(client, first, second)) || (await pairIsBlocked(client, second, first))) {
    throw new ValidationError('Mensagem bloqueada pela relação de bloqueio entre os usuários.', {
      code: 'user_blocked',
    });
  }
}

/**
 * Uma notificação só é aceita se apontar para uma interação real:
 * - o bloco alvo existe e pertence a `to`;
 * - a interação existe, foi assinada pelo mesmo autor da notificação;
 * - o modo da interação é igual a `kind`;
 * - a interação aponta para o mesmo bloco alvo;
 * - não há outra notificação para a mesma interação.
 */
async function assertNotification(client, block) {
  const to = queryValue(block, 'to');
  const targetId = queryValue(block, 'block');
  const interactionId = queryValue(block, 'interaction');
  const kind = queryValue(block, 'kind');

  if (!NOTIFICATION_KINDS.includes(kind)) {
    throw new ValidationError(`Campo "kind" inválido para notification.`, {
      code: 'notification_kind_mismatch',
    });
  }
  if (eqHex(block.pubkey, to)) {
    throw new ValidationError('Não é possível notificar a própria pubkey.', {
      code: 'self_notification',
    });
  }

  const targetResult = await client.query(
    "SELECT id, pubkey, mode FROM blocks WHERE id = $1 AND mode <> 'delete' LIMIT 1",
    [targetId]
  );
  const target = targetResult.rows[0];
  if (!target) {
    throw new ValidationError(`Bloco alvo (${targetId}) não encontrado.`, {
      code: 'target_not_found',
    });
  }

  // Notificações de follow são eventos de relação: o alvo é o próprio bloco
  // `follow`, que pertence ao seguidor e tem o destinatário em `following`.
  if (kind !== 'follow' && !eqHex(target.pubkey, to)) {
    throw new ValidationError('O destinatário da notificação não é o dono do bloco alvo.', {
      code: 'notification_recipient_mismatch',
    });
  }
  if (kind === 'follow') {
    if (!eqHex(targetId, interactionId) || target.mode !== 'follow') {
      throw new ValidationError('Notificação de follow deve apontar para o próprio bloco follow.', {
        code: 'notification_target_mismatch',
      });
    }
  }
  await assertTargetNotDeleted(client, target);

  const interactionResult = await client.query(
    'SELECT id, pubkey, mode, query FROM blocks WHERE id = $1 LIMIT 1',
    [interactionId]
  );
  const interaction = interactionResult.rows[0];
  if (!interaction) {
    throw new ValidationError(`Bloco de interação (${interactionId}) não encontrado.`, {
      code: 'interaction_not_found',
    });
  }
  if (!eqHex(interaction.pubkey, block.pubkey)) {
    throw new ValidationError('A interação referida pertence a outro autor.', {
      code: 'interaction_author_mismatch',
    });
  }
  if (interaction.mode !== kind) {
    throw new ValidationError('O tipo da notificação não corresponde à interação.', {
      code: 'notification_kind_mismatch',
    });
  }
  if (kind === 'follow') {
    if (!eqHex(queryValue(interaction, 'follower'), block.pubkey)) {
      throw new ValidationError('O autor do bloco follow não é o seguidor.', {
        code: 'notification_follow_mismatch',
      });
    }
    if (!eqHex(queryValue(interaction, 'following'), to)) {
      throw new ValidationError('O destinatário da notificação não é quem foi seguido.', {
        code: 'notification_recipient_mismatch',
      });
    }
  } else if (!eqHex(queryValue(interaction, 'block'), targetId)) {
    throw new ValidationError('A interação referida pertence a outro bloco.', {
      code: 'interaction_target_mismatch',
    });
  }
  await assertTargetNotDeleted(client, interaction);

  const existing = await client.query(
    `SELECT id
     FROM blocks
     WHERE mode = 'notification'
       AND lower((
             jsonb_path_query_first(
               query,
               'strict $[*] ? (@[0] == "interaction")'
             ) ->> 1
           )) = lower($1)
     LIMIT 1`,
    [interactionId]
  );
  if (existing.rowCount > 0) {
    throw new ValidationError('Já existe uma notificação para esta interação.', {
      code: 'notification_duplicate',
    });
  }

  return { target, interaction };
}

async function handleToggle(client, block, { mode, queryJson }) {
  const removed = await client.query(
    `DELETE FROM blocks
     WHERE lower(pubkey) = lower($1)
       AND mode = $2
       AND query @> $3::jsonb
     RETURNING id`,
    [block.pubkey, mode, queryJson]
  );

  if (removed.rowCount > 0) {
    return { action: 'removed' };
  }

  await insertBlock(client, block);
  return { action: 'created' };
}

/**
 * Curtidas e reações são toggles por autor + alvo (+ emoji, no caso de reação).
 * Se o alvo foi excluído, ainda permitimos remover um toggle antigo, mas não
 * criar um novo.
 */
async function handleTargetToggle(client, block, mode, { targetModes } = {}) {
  const target = await assertTargetExists(client, block);

  if (Array.isArray(targetModes) && !targetModes.includes(target.mode)) {
    throw new ValidationError(`Modo ${mode} não aceita este tipo de bloco como alvo.`, {
      code: 'invalid_target_mode',
    });
  }

  const queryJson = JSON.stringify(block.query);

  const existing = await client.query(
    `SELECT 1 FROM blocks
     WHERE lower(pubkey) = lower($1) AND mode = $2 AND query @> $3::jsonb
     LIMIT 1`,
    [block.pubkey, mode, queryJson]
  );

  if (existing.rowCount === 0) {
    await assertTargetNotDeleted(client, target);
  }

  return handleToggle(client, block, { mode, queryJson });
}

/**
 * Uma confirmação de leitura é válida quando todas as notificações listadas
 * pertencem ao autor do recibo. Qualquer pessoa pode publicar o próprio
 * recibo, mas não pode marcar como lidas notificações de outra pubkey.
 */
async function assertNotificationRead(client, block) {
  const ids = block.content.read.map((id) => String(id).toLowerCase());
  const result = await client.query(
    `SELECT id, query
     FROM blocks
     WHERE id = ANY($1::text[]) AND mode = 'notification'`,
    [ids]
  );

  const notifications = new Map(
    result.rows.map((row) => [String(row.id).toLowerCase(), row])
  );

  if (notifications.size !== ids.length) {
    throw new ValidationError('Uma ou mais notificações não foram encontradas.', {
      code: 'notification_not_found',
    });
  }

  for (const id of ids) {
    const notification = notifications.get(id);
    if (!eqHex(queryValue(notification, 'to'), block.pubkey)) {
      throw new ValidationError('A notificação pertence a outra pubkey.', {
        code: 'notification_read_recipient_mismatch',
      });
    }
  }
}

/**
 * Uma confirmação de leitura de mensagens é válida quando todas as mensagens
 * listadas existem e foram endereçadas ao autor do recibo. O recibo não contém
 * texto, apenas os ids lógicos dos blocos `message`.
 */
async function assertMessageRead(client, block) {
  const ids = block.content.read.map((id) => String(id).toLowerCase());
  const result = await client.query(
    `SELECT id, query
     FROM blocks
     WHERE id = ANY($1::text[]) AND mode = 'message'`,
    [ids]
  );

  const messages = new Map(
    result.rows.map((row) => [String(row.id).toLowerCase(), row])
  );

  if (messages.size !== ids.length) {
    throw new ValidationError('Uma ou mais mensagens não foram encontradas.', {
      code: 'message_not_found',
    });
  }

  for (const id of ids) {
    const message = messages.get(id);
    if (!eqHex(queryValue(message, 'to'), block.pubkey)) {
      throw new ValidationError('A mensagem pertence a outra pubkey.', {
        code: 'message_read_recipient_mismatch',
      });
    }
  }
}

async function persistBlock(block) {
  const validation = validateBlockDetailed(block);
  if (!validation.valid) {
    throw new ValidationError(validation.error, { code: validation.code });
  }

  // Verificação redundante e explícita para deixar a intenção de segurança clara.
  const unsigned = { ...block };
  delete unsigned.sig;
  if (!verifySignature(block.pubkey, JSON.stringify(unsigned), block.sig)) {
    throw new ValidationError('Assinatura inválida. Bloco rejeitado.', {
      code: 'invalid_signature',
    });
  }

  return db.withTransaction(async (client) => {
    // Toggles (`like`, `reaction`, `repost`, `follow`, `block`) são as únicas
    // operações com estado mutável. O advisory lock serializa requisições
    // concorrentes do mesmo autor/alvo. Os demais modos são idempotentes pelo
    // `processed_blocks`.
    if (block.mode === 'block') {
      await lockBlockPair(
        client,
        queryValue(block, 'blocker') || '',
        queryValue(block, 'blocked') || ''
      );
    } else if (
      block.mode === 'like' ||
      block.mode === 'reaction' ||
      block.mode === 'repost' ||
      block.mode === 'follow'
    ) {
      await lockKey(client, block);
    }

    // Idempotência: um id só pode gerar efeitos uma vez.
    const processed = await client.query(
      `INSERT INTO processed_blocks (id, pubkey, mode, created_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (id) DO NOTHING
       RETURNING id`,
      [block.id, block.pubkey, block.mode, block.created_at]
    );

    if (processed.rowCount === 0) {
      stats.incDuplicates();
      return {
        status: 'success',
        message: `Bloco ${block.id} já processado.`,
        action: 'duplicate',
        id: block.id,
        mode: block.mode,
      };
    }

    // Rede de segurança: um bloco pode existir sem registro em processed_blocks.
    const existing = await client.query('SELECT 1 FROM blocks WHERE id = $1 LIMIT 1', [block.id]);
    if (existing.rowCount > 0) {
      stats.incDuplicates();
      return {
        status: 'success',
        message: `Bloco ${block.id} já existe.`,
        action: 'duplicate',
        id: block.id,
        mode: block.mode,
      };
    }

    // A unicidade da notificação é por interação. O lock evita duas
    // notificações concorrentes para o mesmo bloco de interação.
    if (block.mode === 'notification') {
      await lockNotification(client, block);
    }

    let action = 'created';

    switch (block.mode) {
      case 'post':
      case 'profile': {
        await insertBlock(client, block);
        break;
      }

      case 'comment': {
        const target = await assertTargetExists(client, block);
        await assertTargetNotDeleted(client, target);
        await assertCommentParent(client, block, target);
        await insertBlock(client, block);
        break;
      }

      case 'notification': {
        await assertNotification(client, block);
        await insertBlock(client, block);
        break;
      }

      case 'notification_read': {
        await assertNotificationRead(client, block);
        await insertBlock(client, block);
        break;
      }

      case 'message_read': {
        await assertMessageRead(client, block);
        await insertBlock(client, block);
        break;
      }

      case 'delete': {
        await assertTargetExists(client, block, { requireOwner: true });
        await insertBlock(client, block);
        break;
      }

      case 'like': {
        ({ action } = await handleTargetToggle(client, block, 'like'));
        break;
      }

      case 'reaction': {
        ({ action } = await handleTargetToggle(client, block, 'reaction'));
        break;
      }

      case 'repost': {
        ({ action } = await handleTargetToggle(client, block, 'repost', {
          targetModes: ['post'],
        }));
        break;
      }

      case 'follow': {
        ({ action } = await handleToggle(client, block, {
          mode: 'follow',
          queryJson: JSON.stringify(block.query),
        }));
        break;
      }

      case 'block': {
        ({ action } = await handleToggle(client, block, {
          mode: 'block',
          queryJson: JSON.stringify(block.query),
        }));
        break;
      }

      case 'message': {
        const from = queryValue(block, 'from');
        const to = queryValue(block, 'to');

        await lockBlockPair(client, from, to);
        await assertNotBlocked(client, from, to);
        await insertBlock(client, block, { withChat: true });

        // Cópia para a caixa de entrada do destinatário. O id recebe sufixo
        // "_rcp" para não conflitar com o bloco original do remetente.
        // Em conversas consigo mesmo a cópia seria duplicada, então é omitida.
        if (to.toLowerCase() !== from.toLowerCase()) {
          await insertBlock(
            client,
            block,
            {
              id: `${block.id}_rcp`,
              pubkey: to,
              withChat: true,
            }
          );
        }

        logger.debug('Mensagem salva', {
          id: block.id,
          from: from?.slice(0, 12),
          to: to?.slice(0, 12),
        });
        break;
      }

      default:
        throw new ValidationError('Modo não implementado.', { code: 'invalid_mode' });
    }

    stats.incBlocksSaved();

    return {
      status: 'success',
      message:
        action === 'removed'
          ? `Bloco ${block.id} removido.`
          : `Bloco ${block.id} publicado.`,
      action,
      id: block.id,
      mode: block.mode,
    };
  });
}

function errorResponse(err) {
  stats.incBlocksRejected();

  if (isPublicError(err)) {
    return {
      status: 'erro',
      message: err.message,
      code: err.code,
    };
  }

  logger.error('Erro ao salvar bloco', logger.errorMeta(err));
  return {
    status: 'erro',
    message: 'Erro interno ao salvar bloco.',
    code: 'internal_error',
  };
}

/**
 * Valida e persiste um bloco assinado.
 *
 * Sempre resolve com a resposta pública; erros de validação não viram
 * exceções para o chamador HTTP/WebSocket.
 */
async function saveBlock(block) {
  try {
    return await persistBlock(block);
  } catch (err) {
    return errorResponse(err);
  }
}

module.exports = { saveBlock };
