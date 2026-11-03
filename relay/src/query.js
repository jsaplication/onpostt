'use strict';

const config = require('./config');
const { ValidationError } = require('./errors');
const { NOTIFICATION_KINDS, isValidMode } = require('./modes');
const { validateQuery, isPlainObject, isForbiddenKey } = require('./protocol');
const { isValidPublicKey, isValidBlockId } = require('./crypto');
const { normalizeTopic } = require('./topics');

const FILTER_KEYS = new Set([
  'mode',
  'pubkey',
  'query',
  'topic',
  'since',
  'until',
  'app',
  'id',
  'limit',
  'offset',
]);

const CONTROL_RE = /[\u0000-\u001F\u007F]/;

function assertInteger(value, name, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new ValidationError(`Campo "${name}" deve ser um inteiro entre ${min} e ${max}.`, {
      code: 'invalid_filter',
    });
  }
}

/**
 * Normaliza e valida um filtro de consulta/assinatura.
 * Nunca aceita `privatekey`: chaves privadas não devem sair do cliente.
 */
function normalizeFilter(input) {
  if (!isPlainObject(input)) {
    throw new ValidationError('Filtro deve ser um objeto JSON.', { code: 'invalid_filter' });
  }

  for (const key of Object.keys(input)) {
    if (isForbiddenKey(key)) {
      throw new ValidationError(
        `Campo reservado "${key}" não é aceito em filtros. Envie apenas a pubkey.`,
        {
          code: key.toLowerCase() === 'privatekey' ? 'private_key_forbidden' : 'invalid_filter',
        }
      );
    }
    if (!FILTER_KEYS.has(key)) {
      throw new ValidationError(`Campo de filtro não suportado: ${key}`, { code: 'invalid_filter' });
    }
  }

  if (Array.isArray(input.query)) {
    for (const pair of input.query) {
      if (Array.isArray(pair) && isForbiddenKey(pair[0])) {
        throw new ValidationError('A query do filtro contém uma chave reservada.', {
          code: pair[0].toLowerCase() === 'privatekey' ? 'private_key_forbidden' : 'invalid_filter',
        });
      }
    }
  }

  if (!isValidMode(input.mode)) {
    throw new ValidationError(`Campo "mode" inválido ou ausente.`, { code: 'invalid_mode' });
  }

  const filter = { mode: input.mode };

  if (input.pubkey !== undefined && input.pubkey !== null) {
    if (!isValidPublicKey(input.pubkey)) {
      throw new ValidationError('Campo "pubkey" inválido.', { code: 'invalid_filter' });
    }
    filter.pubkey = input.pubkey;
  }

  if (input.app !== undefined && input.app !== null) {
    if (typeof input.app !== 'string' || !input.app.length || input.app.length > config.limits.maxAppLength) {
      throw new ValidationError('Campo "app" inválido.', { code: 'invalid_filter' });
    }
    if (CONTROL_RE.test(input.app)) {
      throw new ValidationError('Campo "app" contém caracteres inválidos.', { code: 'invalid_filter' });
    }
    filter.app = input.app;
  }

  if (input.id !== undefined && input.id !== null) {
    if (!isValidBlockId(input.id)) {
      throw new ValidationError('Campo "id" inválido.', { code: 'invalid_filter' });
    }
    filter.id = input.id;
  }

  if (input.topic !== undefined && input.topic !== null) {
    if (filter.mode !== 'post') {
      throw new ValidationError('Campo "topic" só é aceito em filtros de post.', {
        code: 'invalid_filter',
      });
    }
    const topic = normalizeTopic(input.topic);
    if (!topic) {
      throw new ValidationError('Campo "topic" inválido.', { code: 'invalid_filter' });
    }
    filter.topic = topic;
  }

  if (input.since !== undefined && input.since !== null) {
    assertInteger(input.since, 'since', { min: 0 });
    filter.since = input.since;
  }

  if (input.until !== undefined && input.until !== null) {
    assertInteger(input.until, 'until', { min: 0 });
    filter.until = input.until;
  }

  if (
    filter.since !== undefined &&
    filter.until !== undefined &&
    filter.since > filter.until
  ) {
    throw new ValidationError('Campo "since" não pode ser maior que "until".', {
      code: 'invalid_filter',
    });
  }

  if (input.query !== undefined && input.query !== null) {
    // Filtros aceitam qualquer subconjunto de pares da query do bloco.
    const result = validateQuery(input.query, 'post');
    if (result.error) {
      throw new ValidationError(result.error, { code: 'invalid_filter' });
    }
    filter.query = input.query.map(([key, value]) => [key, value]);
  }

  if (input.limit !== undefined && input.limit !== null) {
    assertInteger(input.limit, 'limit', { min: 1, max: config.limits.maxBlocksPerRequest });
    filter.limit = input.limit;
  }

  if (input.offset !== undefined && input.offset !== null) {
    assertInteger(input.offset, 'offset', { min: 0, max: 1000000 });
    filter.offset = input.offset;
  }

  if (filter.mode === 'notification') {
    const pairs = Array.isArray(filter.query) ? filter.query : [];
    const valueOf = (name) => pairs.find(([key]) => key === name)?.[1];
    const to = valueOf('to');
    const target = valueOf('block');
    const interaction = valueOf('interaction');
    const kind = valueOf('kind');

    if (to === undefined && !filter.id) {
      throw new ValidationError('Filtros de notification exigem o par "to" ou o campo "id".', {
        code: 'invalid_filter',
      });
    }
    if (to !== undefined && !isValidPublicKey(to)) {
      throw new ValidationError('Campo "to" de notification inválido.', { code: 'invalid_filter' });
    }
    if (target !== undefined && !isValidBlockId(target)) {
      throw new ValidationError('Campo "block" de notification inválido.', { code: 'invalid_filter' });
    }
    if (interaction !== undefined && !isValidBlockId(interaction)) {
      throw new ValidationError('Campo "interaction" de notification inválido.', {
        code: 'invalid_filter',
      });
    }
    if (kind !== undefined && !NOTIFICATION_KINDS.includes(kind)) {
      throw new ValidationError('Campo "kind" de notification inválido.', { code: 'invalid_filter' });
    }
  }

  // Confirmações de leitura só fazem sentido para uma pubkey específica.
  // Exigimos a pubkey ou o id para evitar varredura global.
  if (
    (filter.mode === 'notification_read' || filter.mode === 'message_read') &&
    !filter.pubkey &&
    !filter.id
  ) {
    throw new ValidationError(
      `Filtros de ${filter.mode} exigem "pubkey" ou o campo "id".`,
      { code: 'invalid_filter' }
    );
  }

  // Mensagens são privadas: exigimos ao menos uma restrição para evitar
  // varredura global de metadados de conversas.
  if (filter.mode === 'message') {
    const hasFromTo =
      Array.isArray(filter.query) &&
      filter.query.some(([key]) => key === 'from') &&
      filter.query.some(([key]) => key === 'to');
    if (!filter.pubkey && !hasFromTo && !filter.id) {
      throw new ValidationError(
        'Filtros de message exigem "pubkey" ou os pares "from"/"to".',
        { code: 'invalid_filter' }
      );
    }
  }

  return filter;
}

// Valor do par `blocked` dentro de um bloco de bloqueio. Usado para descobrir
// se o autor de uma publicação está bloqueado pelo leitor (ou vice-versa).
const BLOCKED_QUERY_VALUE =
  `lower(jsonb_path_query_first(rel.query, 'strict $[*] ? (@[0] == "blocked")') ->> 1)`;

/**
 * Monta a query SQL parametrizada para listar blocos.
 * Todos os valores são passados por parâmetros; nada é interpolado.
 *
 * `viewer` é a pubkey autenticada do leitor, quando houver. Sem ela, a consulta
 * é anônima e esconde autores que participam de qualquer bloqueio ativo. Isso
 * impede que um usuário bloqueado simplesmente omita o token para ver o perfil
 * ou as publicações de quem o bloqueou.
 *
 * @param {object} input
 * @param {string | null | undefined} viewer
 */
function buildBlocksQuery(input, viewer) {
  const filter = normalizeFilter(input);
  const viewerKey = viewer ? String(viewer).toLowerCase() : null;
  if (viewerKey && !isValidPublicKey(viewerKey)) {
    throw new ValidationError('Pubkey do leitor inválida.', { code: 'invalid_reader' });
  }

  const conditions = [];
  const params = [];
  let index = 1;

  const add = (sql, value) => {
    conditions.push(sql.replace(/\?/g, `$${index++}`));
    params.push(value);
  };

  add('b.mode = ?', filter.mode);

  if (filter.pubkey) add('lower(b.pubkey) = lower(?)', filter.pubkey);
  if (filter.app) add('b.app = ?', filter.app);
  if (filter.id) add('b.id = ?', filter.id);

  if (filter.topic) {
    const topicParam = `$${index++}`;
    const legacyParam = `$${index++}`;
    conditions.push(
      `(b.content->'topics' @> jsonb_build_array(${topicParam}::text) ` +
        `OR b.query @> ${legacyParam}::jsonb)`
    );
    params.push(filter.topic, JSON.stringify([['topic', filter.topic]]));
  }

  if (filter.since !== undefined) add('b.created_at >= ?', filter.since);
  if (filter.until !== undefined) add('b.created_at <= ?', filter.until);

  if (Array.isArray(filter.query)) {
    for (const [key, value] of filter.query) {
      // O destinatário é uma pubkey e deve ser comparado sem diferenciar caixa.
      if (filter.mode === 'notification' && key === 'to') {
        add(
          "lower((SELECT p.value->>1 FROM jsonb_array_elements(b.query) AS p(value) WHERE p.value->>0 = 'to' LIMIT 1)) = lower(?)",
          value
        );
        continue;
      }
      add('b.query @> ?::jsonb', JSON.stringify([[key, value]]));
    }

    // Índices compostos para conversas (from/to).
    if (filter.mode === 'message') {
      const from = filter.query.find(([key]) => key === 'from')?.[1];
      const to = filter.query.find(([key]) => key === 'to')?.[1];
      if (typeof from === 'string' && typeof to === 'string') {
        add('lower(b."from") = lower(?)', from);
        add('lower(b."to") = lower(?)', to);

        // Sem `pubkey`, a conversa existe em duas linhas (original + cópia
        // "_rcp"). Limitamos à linha original para não duplicar mensagens.
        if (!filter.pubkey) add('lower(b.pubkey) = lower(?)', from);
      }
    }
  }

  // Bloqueio é uma relação bidirecional para leitura: se A bloqueou B, nem A
  // nem B devem enxergar o conteúdo um do outro por consultas públicas.
  // Blocos do modo `block` ficam fora do filtro para que o cliente consiga
  // detectar o bloqueio e exibir o estado correto na interface.
  if (filter.mode !== 'block') {
    if (viewerKey) {
      const viewerParam = `$${index++}`;
      params.push(viewerKey);

      if (filter.mode === 'message') {
        conditions.push(`
          NOT EXISTS (
            SELECT 1
            FROM blocks rel
            WHERE rel.mode = 'block'
              AND (
                (lower(rel.pubkey) = ${viewerParam}
                  AND ${BLOCKED_QUERY_VALUE} IN (lower(b."from"), lower(b."to")))
                OR
                (${BLOCKED_QUERY_VALUE} = ${viewerParam}
                  AND lower(rel.pubkey) IN (lower(b."from"), lower(b."to")))
              )
          )
        `);
      } else {
        conditions.push(`
          NOT EXISTS (
            SELECT 1
            FROM blocks rel
            WHERE rel.mode = 'block'
              AND (
                (lower(rel.pubkey) = ${viewerParam}
                  AND ${BLOCKED_QUERY_VALUE} = lower(b.pubkey))
                OR
                (${BLOCKED_QUERY_VALUE} = ${viewerParam}
                  AND lower(rel.pubkey) = lower(b.pubkey))
              )
          )
        `);
      }
    } else if (filter.mode === 'message') {
      conditions.push(`
        NOT EXISTS (
          SELECT 1
          FROM blocks rel
          WHERE rel.mode = 'block'
            AND (
              lower(rel.pubkey) IN (lower(b."from"), lower(b."to"))
              OR ${BLOCKED_QUERY_VALUE} IN (lower(b."from"), lower(b."to"))
            )
        )
      `);
    } else {
      conditions.push(`
        NOT EXISTS (
          SELECT 1
          FROM blocks rel
          WHERE rel.mode = 'block'
            AND (
              lower(rel.pubkey) = lower(b.pubkey)
              OR ${BLOCKED_QUERY_VALUE} = lower(b.pubkey)
            )
        )
      `);
    }
  }

  // Tombstones: um bloco excluído pelo próprio autor não deve aparecer.
  // A cópia de mensagem ("<id>_rcp") também é ocultada pelo id original.
  conditions.push(`
    NOT EXISTS (
      SELECT 1
      FROM blocks d
      WHERE d.mode = 'delete'
        AND lower(d.pubkey) = lower(CASE WHEN b.mode = 'message' THEN b."from" ELSE b.pubkey END)
        AND d.query @> jsonb_build_array(
          jsonb_build_array(
            'block'::text,
            CASE WHEN b.id LIKE '%\\_rcp' ESCAPE '\\'
                 THEN left(b.id, length(b.id) - 4)
                 ELSE b.id
            END
          )
        )
    )
  `);

  // Notificações são derivadas de uma interação assinada. Só aparecem enquanto
  // a interação e o bloco alvo existirem e não tiverem tombstone. Isso evita
  // notificações órfãs depois de descurtir/desreagir ou excluir um comentário.
  if (filter.mode === 'notification') {
    conditions.push(`
      EXISTS (
        SELECT 1
        FROM blocks i
        WHERE i.id = (
                jsonb_path_query_first(
                  b.query,
                  'strict $[*] ? (@[0] == "interaction")'
                ) ->> 1
              )
          AND lower(i.pubkey) = lower(b.pubkey)
          AND (
            (
              (
                jsonb_path_query_first(
                  b.query,
                  'strict $[*] ? (@[0] == "kind")'
                ) ->> 1
              ) <> 'follow'
              AND i.mode = (
                jsonb_path_query_first(
                  b.query,
                  'strict $[*] ? (@[0] == "kind")'
                ) ->> 1
              )
              AND i.mode IN ('like', 'reaction', 'comment', 'repost')
              AND i.query @> jsonb_build_array(
                jsonb_build_array(
                  'block'::text,
                  (
                    jsonb_path_query_first(
                      b.query,
                      'strict $[*] ? (@[0] == "block")'
                    ) ->> 1
                  )
                )
              )
            )
            OR
            (
              (
                jsonb_path_query_first(
                  b.query,
                  'strict $[*] ? (@[0] == "kind")'
                ) ->> 1
              ) = 'follow'
              AND i.mode = 'follow'
              AND i.id = (
                jsonb_path_query_first(
                  b.query,
                  'strict $[*] ? (@[0] == "block")'
                ) ->> 1
              )
              AND lower((
                jsonb_path_query_first(
                  i.query,
                  'strict $[*] ? (@[0] == "following")'
                ) ->> 1
              )) = lower((
                jsonb_path_query_first(
                  b.query,
                  'strict $[*] ? (@[0] == "to")'
                ) ->> 1
              ))
            )
          )
          AND NOT EXISTS (
            SELECT 1
            FROM blocks di
            WHERE di.mode = 'delete'
              AND lower(di.pubkey) = lower(i.pubkey)
              AND di.query @> jsonb_build_array(
                jsonb_build_array('block'::text, i.id)
              )
          )
      )
    `);

    conditions.push(`
      EXISTS (
        SELECT 1
        FROM blocks t
        WHERE t.id = (
                jsonb_path_query_first(
                  b.query,
                  'strict $[*] ? (@[0] == "block")'
                ) ->> 1
              )
          AND t.mode <> 'delete'
          AND (
            (
              (
                jsonb_path_query_first(
                  b.query,
                  'strict $[*] ? (@[0] == "kind")'
                ) ->> 1
              ) <> 'follow'
              AND lower(t.pubkey) = lower((
                jsonb_path_query_first(
                  b.query,
                  'strict $[*] ? (@[0] == "to")'
                ) ->> 1
              ))
            )
            OR
            (
              (
                jsonb_path_query_first(
                  b.query,
                  'strict $[*] ? (@[0] == "kind")'
                ) ->> 1
              ) = 'follow'
              AND t.mode = 'follow'
              AND lower(t.pubkey) = lower(b.pubkey)
            )
          )
          AND NOT EXISTS (
            SELECT 1
            FROM blocks dt
            WHERE dt.mode = 'delete'
              AND lower(dt.pubkey) = lower(t.pubkey)
              AND dt.query @> jsonb_build_array(
                jsonb_build_array('block'::text, t.id)
              )
          )
      )
    `);
  }

  const whereClause = `WHERE ${conditions.join('\n  AND ')}`;
  const limit = filter.limit ?? config.limits.maxBlocksPerRequest;
  const offset = filter.offset ?? 0;

  const columns = 'b.id, b.app, b.content, b.created_at, b.mode, b.pubkey, b.query, b.sig';

  let text;
  if (filter.mode === 'profile') {
    // Último perfil por pubkey, com paginação sobre o resultado final.
    const limitParam = `$${index++}`;
    const offsetParam = `$${index++}`;
    params.push(limit, offset);
    text = `
      SELECT latest.id, latest.app, latest.content, latest.created_at, latest.mode, latest.pubkey, latest.query, latest.sig
      FROM (
        SELECT DISTINCT ON (lower(b.pubkey)) ${columns}
        FROM blocks b
        ${whereClause}
        ORDER BY lower(b.pubkey), b.created_at DESC, b.id DESC
      ) AS latest
      ORDER BY latest.created_at DESC, latest.id DESC
      LIMIT ${limitParam} OFFSET ${offsetParam}
    `;
  } else {
    const limitParam = `$${index++}`;
    const offsetParam = `$${index++}`;
    params.push(limit, offset);
    text = `
      SELECT ${columns}
      FROM blocks b
      ${whereClause}
      ORDER BY b.created_at DESC, b.id DESC
      LIMIT ${limitParam} OFFSET ${offsetParam}
    `;
  }

  return { text, params, filter };
}

module.exports = {
  normalizeFilter,
  buildBlocksQuery,
  FILTER_KEYS,
};
