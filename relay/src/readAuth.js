'use strict';

/**
 * Autenticação de leitura por posse de chave.
 *
 * O cliente assina um token curto com a própria chave privada e o envia no
 * campo `reader` das consultas. O relay verifica a assinatura e usa a pubkey
 * como identidade do leitor para aplicar as regras de bloqueio.
 *
 * O token não substitui autenticação de conta: ele prova apenas que quem fez a
 * requisição possui a chave privada daquela pubkey. Quem cria outra pubkey
 * passa a ser outra identidade (limitação de Sybil inerente ao protocolo).
 */

const config = require('./config');
const { ValidationError } = require('./errors');
const {
  isValidPublicKey,
  isValidSignature,
  verifySignature,
} = require('./crypto');

const READER_PREFIX = 'onpostt-read-v1:';
const READER_KEYS = new Set(['viewer', 'created_at', 'sig']);

function invalidReader(message, code = 'invalid_reader') {
  return new ValidationError(message, { code });
}

function readerMessage(viewer, createdAt) {
  return `${READER_PREFIX}${String(viewer).toLowerCase()}:${createdAt}`;
}

/**
 * Valida o token `reader`.
 *
 * Retorna `{ viewer: null }` quando o token não foi enviado; nesse caso a
 * consulta continua pública, mas o relay aplica uma proteção conservadora:
 * autores que participam de algum bloqueio ativo não aparecem para anônimos.
 *
 * @param {unknown} input
 * @returns {{ viewer: string | null }}
 */
function parseReader(input) {
  if (input === undefined || input === null) return { viewer: null };

  if (typeof input !== 'object' || Array.isArray(input)) {
    throw invalidReader('Campo "reader" deve ser um objeto.');
  }

  const keys = Object.keys(input);
  if (keys.length !== READER_KEYS.size || keys.some((key) => !READER_KEYS.has(key))) {
    throw invalidReader('Campo "reader" deve conter apenas viewer, created_at e sig.');
  }

  const { viewer, created_at: createdAt, sig } = input;
  if (!isValidPublicKey(viewer)) {
    throw invalidReader('Campo "reader.viewer" não é uma pubkey válida.');
  }
  if (!Number.isSafeInteger(createdAt) || createdAt <= 0) {
    throw invalidReader('Campo "reader.created_at" deve ser um timestamp Unix inteiro.');
  }
  if (!isValidSignature(sig)) {
    throw invalidReader('Campo "reader.sig" não é uma assinatura válida.');
  }

  const now = Math.floor(Date.now() / 1000);
  if (createdAt > now + config.limits.maxFutureSkewSeconds) {
    throw invalidReader('Token de leitura está no futuro.', 'reader_not_yet_valid');
  }
  if (now - createdAt > config.limits.readerTokenTtlSeconds) {
    throw invalidReader('Token de leitura expirou. Atualize a página e tente novamente.', 'reader_expired');
  }

  const normalizedViewer = viewer.toLowerCase();
  const message = readerMessage(normalizedViewer, createdAt);
  if (!verifySignature(viewer, message, sig)) {
    throw invalidReader('Assinatura do token de leitura inválida.', 'invalid_reader_signature');
  }

  return { viewer: normalizedViewer };
}

module.exports = {
  READER_PREFIX,
  parseReader,
  readerMessage,
};
