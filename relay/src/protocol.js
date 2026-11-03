'use strict';

const config = require('./config');
const { MODES, NOTIFICATION_KINDS, isValidMode } = require('./modes');
const {
  computeBlockId,
  verifySignature,
  isValidPublicKey,
  isValidSignature,
  isValidBlockId,
} = require('./crypto');
const { validateImageContent, validateProfileContent } = require('./image');
const { validateTopics, topicsFromBlock } = require('./topics');

const QUERY_KEY_RE = /^[A-Za-z0-9_.:-]+$/;
const HEX_RE = /^[0-9a-f]+$/i;
const CONTROL_RE = /[\u0000-\u001F\u007F]/;
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype', 'privatekey']);
const MAX_TOP_LEVEL_KEYS = 32;
const REACTION_CONTROL_RE = /[\u0000-\u001F\u007F\u2028\u2029]/;
const MAX_REACTION_LENGTH = 32;
const MAX_NOTIFICATION_READ_IDS = 500;
const MAX_MESSAGE_READ_IDS = 500;

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function eqHex(a, b) {
  return typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
}

function isForbiddenKey(key) {
  if (typeof key !== 'string') return false;
  return FORBIDDEN_KEYS.has(key.toLowerCase());
}

function fail(error, code = 'invalid_block') {
  return { valid: false, error, code };
}

function jsonSize(value) {
  const json = JSON.stringify(value);
  return { json, bytes: Buffer.byteLength(json, 'utf8') };
}

/**
 * Valida o envelope de mensagem cifrada.
 * Formato esperado:
 *   { forRecipient?: { ciphertext, iv, senderPubKey }, forSender?: {...} }
 */
function validateEncryptedContent(content) {
  let payload = content;
  if (typeof payload === 'string') {
    try {
      payload = JSON.parse(payload);
    } catch {
      return 'Conteúdo de message deve ser um JSON cifrado válido.';
    }
  }

  if (!isPlainObject(payload)) return 'Conteúdo de message deve ser um objeto cifrado.';

  const parts = ['forRecipient', 'forSender'].filter((key) => payload[key] !== undefined);
  if (parts.length === 0) return 'Mensagem deve conter forRecipient e/ou forSender.';

  for (const part of parts) {
    const entry = payload[part];
    if (!isPlainObject(entry)) return `${part} inválido.`;
    if (typeof entry.ciphertext !== 'string' || entry.ciphertext.length < 32 || entry.ciphertext.length % 2 !== 0 || !HEX_RE.test(entry.ciphertext)) {
      return `${part}.ciphertext inválido.`;
    }
    if (typeof entry.iv !== 'string' || entry.iv.length !== 24 || !HEX_RE.test(entry.iv)) {
      return `${part}.iv inválido (esperado 12 bytes em hex).`;
    }
    if (!isValidPublicKey(entry.senderPubKey)) {
      return `${part}.senderPubKey inválido.`;
    }
  }

  const size = jsonSize(payload).bytes;
  if (size > config.limits.maxContentSize) {
    return `Conteúdo cifrado excede ${config.limits.maxContentSize} bytes.`;
  }

  return null;
}

/**
 * Valida `query`: array de pares [chave, valor] com valores primitivos.
 */
function validateQuery(query, mode) {
  if (!Array.isArray(query)) return { error: 'query deve ser um array.' };
  if (query.length > config.limits.maxQueryPairs) {
    return { error: `query excede ${config.limits.maxQueryPairs} pares.` };
  }

  const seen = new Map();

  for (const pair of query) {
    if (!Array.isArray(pair) || pair.length !== 2) {
      return { error: 'Cada item de query deve ser [chave, valor].' };
    }

    const [key, value] = pair;

    if (typeof key !== 'string' || !key.length) {
      return { error: 'Chave de query inválida.' };
    }
    if (key.length > config.limits.maxQueryKeyLength) {
      return { error: `Chave de query excede ${config.limits.maxQueryKeyLength} caracteres.` };
    }
    if (!QUERY_KEY_RE.test(key) || CONTROL_RE.test(key)) {
      return { error: `Chave de query inválida: ${key}` };
    }
    if (isForbiddenKey(key)) {
      return { error: 'Chave de query reservada.' };
    }
    if (seen.has(key)) {
      return { error: `Chave duplicada em query: ${key}` };
    }

    const valueType = typeof value;
    if (!['string', 'number', 'boolean'].includes(valueType)) {
      return { error: `Valor inválido em query para "${key}".` };
    }
    if (valueType === 'number' && !Number.isFinite(value)) {
      return { error: `Número inválido em query para "${key}".` };
    }
    if (valueType === 'string' && value.length > config.limits.maxQueryValueLength) {
      return { error: `Valor de query excede ${config.limits.maxQueryValueLength} caracteres.` };
    }

    seen.set(key, value);
  }

  const rule = MODES[mode] && MODES[mode].query;
  if (rule && !rule.free) {
    const allowed = new Set([...rule.required, ...rule.optional]);
    for (const key of seen.keys()) {
      if (!allowed.has(key)) {
        return {
          error: `query de "${mode}" não aceita "${key}". Permitidas: ${[...allowed].join(', ')}.`,
        };
      }
    }
    for (const key of rule.required) {
      if (!seen.has(key)) return { error: `Campo "${key}" obrigatório em query.` };
    }
  }

  return { map: seen };
}

/**
 * Reação é um emoji curto, sem caracteres de controle ou espaços vazios.
 */
function isValidReaction(value) {
  if (typeof value !== 'string') return false;
  if (!value.length || value.trim().length === 0) return false;
  if (REACTION_CONTROL_RE.test(value)) return false;
  return Array.from(value).length <= MAX_REACTION_LENGTH;
}

/**
 * Validação completa de um bloco, incluindo id, assinatura e regras por modo.
 *
 * @returns {{valid: true} | {valid: false, error: string, code: string}}
 */
function validateBlockDetailed(block) {
  if (!isPlainObject(block)) return fail('Bloco deve ser um objeto JSON.');

  const keys = Object.keys(block);
  if (keys.length > MAX_TOP_LEVEL_KEYS) return fail('Bloco possui campos demais.');
  for (const key of keys) {
    if (isForbiddenKey(key)) return fail('Bloco contém campo reservado.');
  }

  let blockSize;
  try {
    blockSize = jsonSize(block);
  } catch {
    return fail('Bloco não é serializável em JSON.');
  }
  if (blockSize.bytes > config.limits.maxBlockSize) {
    return fail(`Bloco excede ${config.limits.maxBlockSize} bytes.`, 'block_too_large');
  }

  if (!isValidBlockId(block.id)) return fail('Campo "id" inválido (esperado sha256 hex de 64 caracteres).');
  if (!isValidPublicKey(block.pubkey)) return fail('Campo "pubkey" inválido.');
  if (!Number.isSafeInteger(block.created_at) || block.created_at <= 0) {
    return fail('Campo "created_at" deve ser um timestamp Unix inteiro.');
  }

  const maxCreatedAt = Math.floor(Date.now() / 1000) + config.limits.maxFutureSkewSeconds;
  if (block.created_at > maxCreatedAt) {
    return fail('Campo "created_at" está no futuro.', 'invalid_timestamp');
  }

  if (!isValidMode(block.mode)) {
    return fail(`Modo inválido. Permitidos: ${Object.keys(MODES).join(', ')}.`, 'invalid_mode');
  }

  const modeRule = MODES[block.mode];

  if (block.app !== undefined && typeof block.app !== 'string') {
    return fail('Campo "app" deve ser uma string.');
  }
  if (modeRule.appRequired && typeof block.app !== 'string') {
    return fail('Campo "app" é obrigatório.');
  }
  if (typeof block.app === 'string') {
    if (!block.app.length || block.app.length > config.limits.maxAppLength) {
      return fail(`Campo "app" deve ter entre 1 e ${config.limits.maxAppLength} caracteres.`);
    }
    if (CONTROL_RE.test(block.app)) return fail('Campo "app" contém caracteres inválidos.');
  }

  const queryResult = validateQuery(block.query, block.mode);
  if (queryResult.error) return fail(queryResult.error, 'invalid_query');
  const queryMap = queryResult.map;

  const contentMissing = block.content === undefined || block.content === null;
  if (contentMissing && modeRule.contentRequired) {
    return fail('Campo "content" ausente.');
  }

  if (!contentMissing) {
    if (typeof block.content === 'string') {
      if (Buffer.byteLength(block.content, 'utf8') > config.limits.maxContentSize) {
        return fail(`Conteúdo excede ${config.limits.maxContentSize} bytes.`, 'content_too_large');
      }
    } else if (typeof block.content === 'object') {
      if (!Array.isArray(block.content) && !isPlainObject(block.content)) {
        return fail('Campo "content" inválido.');
      }

      const imageResult =
        block.mode === 'profile'
          ? validateProfileContent(block.content)
          : validateImageContent(block.content);
      if (imageResult) return fail(imageResult.error, imageResult.code);

      const hasImage = isPlainObject(block.content) && block.content.image !== undefined;
      const contentLimit = hasImage
        ? config.limits.maxImageContentSize
        : config.limits.maxContentSize;

      let contentSize;
      try {
        contentSize = jsonSize(block.content).bytes;
      } catch {
        return fail('Campo "content" não é serializável.');
      }
      if (contentSize > contentLimit) {
        return fail(`Conteúdo excede ${contentLimit} bytes.`, 'content_too_large');
      }
    } else {
      return fail('Campo "content" deve ser string ou objeto.');
    }
  }

  if (block.mode === 'post' && isPlainObject(block.content) && block.content.topics !== undefined) {
    const topicsResult = validateTopics(block.content.topics);
    if (!topicsResult.valid) {
      return fail(topicsResult.error, 'invalid_topics');
    }
  }

  if (!isValidSignature(block.sig)) return fail('Campo "sig" inválido.');

  // Regras específicas por modo
  if (block.mode === 'follow') {
    const follower = queryMap.get('follower');
    const following = queryMap.get('following');
    if (!isValidPublicKey(following)) return fail('Campo "following" deve ser uma pubkey válida.');
    if (!eqHex(follower, block.pubkey)) return fail('Campo "follower" deve ser igual à pubkey do autor.');
    if (eqHex(follower, following)) return fail('Um usuário não pode seguir a si mesmo.');
  }

  if (block.mode === 'block') {
    const blocker = queryMap.get('blocker');
    const blocked = queryMap.get('blocked');
    if (!isValidPublicKey(blocked)) return fail('Campo "blocked" deve ser uma pubkey válida.');
    if (!eqHex(blocker, block.pubkey)) return fail('Campo "blocker" deve ser igual à pubkey do autor.');
    if (eqHex(blocker, blocked)) return fail('Um usuário não pode bloquear a si mesmo.');
  }

  if (['like', 'reaction', 'comment', 'repost', 'delete'].includes(block.mode)) {
    const target = queryMap.get('block');
    if (!isValidBlockId(target)) return fail('Campo "block" deve ser um id de bloco válido.');
  }

  if (block.mode === 'reaction' && !isValidReaction(queryMap.get('reaction'))) {
    return fail(`Campo "reaction" deve ser um emoji de 1 a ${MAX_REACTION_LENGTH} caracteres.`);
  }

  if (block.mode === 'comment') {
    if (typeof block.content !== 'string') {
      return fail('Comentário deve ter conteúdo em texto.');
    }
    if (queryMap.has('parent')) {
      const parent = queryMap.get('parent');
      if (!isValidBlockId(parent)) return fail('Campo "parent" deve ser um id de bloco válido.');
      if (eqHex(parent, queryMap.get('block'))) {
        return fail('Campo "parent" não pode ser igual ao bloco alvo.');
      }
    }
  }

  if (block.mode === 'message') {
    const from = queryMap.get('from');
    const to = queryMap.get('to');
    if (!eqHex(from, block.pubkey)) return fail('Campo "from" deve ser igual à pubkey do autor.');
    if (!isValidPublicKey(to)) return fail('Campo "to" deve ser uma pubkey válida.');
    const encryptedError = validateEncryptedContent(block.content);
    if (encryptedError) return fail(encryptedError, 'invalid_message');
  }

  if (block.mode === 'notification_read') {
    if (!isPlainObject(block.content)) {
      return fail('Confirmação de leitura deve ter conteúdo objeto.', 'invalid_notification_read');
    }

    const keys = Object.keys(block.content);
    if (keys.length !== 1 || keys[0] !== 'read') {
      return fail(
        'Confirmação de leitura aceita apenas o campo "read".',
        'invalid_notification_read'
      );
    }

    const read = block.content.read;
    if (!Array.isArray(read) || read.length === 0) {
      return fail('Campo "read" deve ser uma lista não vazia.', 'invalid_notification_read');
    }
    if (read.length > MAX_NOTIFICATION_READ_IDS) {
      return fail(
        `Campo "read" aceita no máximo ${MAX_NOTIFICATION_READ_IDS} notificações.`,
        'invalid_notification_read'
      );
    }

    const seenRead = new Set();
    for (const id of read) {
      if (!isValidBlockId(id)) {
        return fail('Campo "read" contém um id de notificação inválido.', 'invalid_notification_read');
      }
      const key = id.toLowerCase();
      if (seenRead.has(key)) {
        return fail('Campo "read" contém ids duplicados.', 'invalid_notification_read');
      }
      seenRead.add(key);
    }
  }

  if (block.mode === 'message_read') {
    if (!isPlainObject(block.content)) {
      return fail('Confirmação de leitura de mensagens deve ter conteúdo objeto.', 'invalid_message_read');
    }

    const keys = Object.keys(block.content);
    if (keys.length !== 1 || keys[0] !== 'read') {
      return fail(
        'Confirmação de leitura de mensagens aceita apenas o campo "read".',
        'invalid_message_read'
      );
    }

    const read = block.content.read;
    if (!Array.isArray(read) || read.length === 0) {
      return fail('Campo "read" deve ser uma lista não vazia.', 'invalid_message_read');
    }
    if (read.length > MAX_MESSAGE_READ_IDS) {
      return fail(
        `Campo "read" aceita no máximo ${MAX_MESSAGE_READ_IDS} mensagens.`,
        'invalid_message_read'
      );
    }

    const seenRead = new Set();
    for (const id of read) {
      if (!isValidBlockId(id)) {
        return fail('Campo "read" contém um id de mensagem inválido.', 'invalid_message_read');
      }
      const key = id.toLowerCase();
      if (seenRead.has(key)) {
        return fail('Campo "read" contém ids duplicados.', 'invalid_message_read');
      }
      seenRead.add(key);
    }
  }

  if (block.mode === 'notification') {
    if (!contentMissing) {
      return fail('Notificação não aceita "content"; os dados vêm do bloco de interação.');
    }

    const to = queryMap.get('to');
    const target = queryMap.get('block');
    const interaction = queryMap.get('interaction');
    const kind = queryMap.get('kind');

    if (!isValidPublicKey(to)) return fail('Campo "to" deve ser uma pubkey válida.');
    if (!isValidBlockId(target)) return fail('Campo "block" deve ser um id de bloco válido.');
    if (!isValidBlockId(interaction)) {
      return fail('Campo "interaction" deve ser um id de bloco válido.');
    }
    if (!NOTIFICATION_KINDS.includes(kind)) {
      return fail(`Campo "kind" deve ser: ${NOTIFICATION_KINDS.join(', ')}.`);
    }
    if (eqHex(to, block.pubkey)) {
      return fail('Não é possível enviar uma notificação para a própria pubkey.');
    }
    if (kind === 'follow' && !eqHex(target, interaction)) {
      return fail('Notificação de follow deve apontar para o próprio bloco follow.');
    }
    if (kind !== 'follow' && eqHex(target, interaction)) {
      return fail('O bloco de interação não pode ser o próprio bloco alvo.');
    }
  }

  // Assinatura: exatamente JSON.stringify(bloco sem sig)
  const unsigned = { ...block };
  delete unsigned.sig;
  if (!verifySignature(block.pubkey, JSON.stringify(unsigned), block.sig)) {
    return fail('Assinatura inválida. Bloco rejeitado.', 'invalid_signature');
  }

  // Id: sha256 do bloco sem id e sem sig
  if (config.limits.validateBlockId) {
    const expectedId = computeBlockId(block);
    if (block.id.toLowerCase() !== expectedId) {
      return fail('Id do bloco não corresponde ao conteúdo assinado.', 'invalid_id');
    }
  }

  return { valid: true };
}

/**
 * Retorna apenas booleano para validações rápidas.
 */
function validateBlock(block) {
  return validateBlockDetailed(block).valid === true;
}

/**
 * Extrai participantes de uma mensagem.
 */
function messageParticipants(block) {
  if (!block || block.mode !== 'message' || !Array.isArray(block.query)) return null;
  let from = null;
  let to = null;
  for (const pair of block.query) {
    if (!Array.isArray(pair) || pair.length !== 2) continue;
    if (pair[0] === 'from') from = pair[1];
    if (pair[0] === 'to') to = pair[1];
  }
  if (typeof from !== 'string' || typeof to !== 'string') return null;
  return { from, to };
}

function queryPairs(block) {
  return Array.isArray(block?.query) ? block.query : [];
}

/**
 * Verifica se um bloco atende a um filtro de assinatura.
 * Usado para entregar blocos em tempo real aos subscribers.
 */
function blockMatchesFilter(block, filter) {
  if (!block || !filter || block.mode !== filter.mode) return false;

  if (filter.id && block.id !== filter.id) return false;
  if (filter.app && block.app !== filter.app) return false;
  if (filter.since !== undefined && filter.since !== null && block.created_at < filter.since) return false;
  if (filter.until !== undefined && filter.until !== null && block.created_at > filter.until) return false;

  if (filter.pubkey) {
    if (block.mode === 'message') {
      const participants = messageParticipants(block);
      if (!participants) return false;
      if (![participants.from, participants.to].some((key) => eqHex(key, filter.pubkey))) return false;
    } else if (!eqHex(block.pubkey, filter.pubkey)) {
      return false;
    }
  }

  if (filter.topic) {
    if (block.mode !== 'post') return false;
    if (!topicsFromBlock(block).includes(filter.topic)) return false;
  }

  if (Array.isArray(filter.query)) {
    for (const pair of filter.query) {
      if (!Array.isArray(pair) || pair.length !== 2) return false;
      const [key, value] = pair;

      // Destinatários de notificação são pubkeys: compare sem diferenciar caixa.
      if (block.mode === 'notification' && key === 'to') {
        const foundTo = queryPairs(block).some(
          ([blockKey, blockValue]) => blockKey === 'to' && eqHex(blockValue, value)
        );
        if (!foundTo) return false;
        continue;
      }

      const found = queryPairs(block).some(
        ([blockKey, blockValue]) => blockKey === key && Object.is(blockValue, value)
      );
      if (!found) return false;
    }
  }

  return true;
}

module.exports = {
  validateBlock,
  validateBlockDetailed,
  validateEncryptedContent,
  validateQuery,
  isValidReaction,
  blockMatchesFilter,
  messageParticipants,
  isPlainObject,
  isForbiddenKey,
  eqHex,
};
