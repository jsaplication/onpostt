'use strict';

const config = require('./config');
const db = require('./db');
const logger = require('./logger');
const { buildBlocksQuery } = require('./query');
const { isPublicError } = require('./errors');

/**
 * Limita uma lista de blocos pelo tamanho JSON aproximado.
 * Sempre permite o primeiro bloco, mesmo que ele sozinho exceda o limite;
 * nesse caso a resposta é marcada como truncada quando há mais linhas.
 */
function capBlocks(rows, maxBytes = config.limits.maxResponseBytes) {
  const blocks = [];
  let bytes = 0;
  let truncated = false;

  for (const row of rows) {
    const size = Buffer.byteLength(JSON.stringify(row), 'utf8');
    const next = bytes + (blocks.length > 0 ? 1 : 0) + size;
    if (blocks.length > 0 && next > maxBytes) {
      truncated = true;
      break;
    }
    blocks.push(row);
    bytes = next;
  }

  return { blocks, truncated, bytes };
}

/**
 * Busca blocos no PostgreSQL.
 *
 * Erros públicos de validação são propagados para o chamador responder 400.
 * Erros internos são registrados sem detalhes sensíveis.
 *
 * @param {object} filter
 * @param {string | null | undefined} viewer Pubkey autenticada do leitor.
 * @returns {Promise<{blocks: object[], truncated: boolean, bytes: number}>}
 */
async function getBlocksPage(filter, viewer) {
  try {
    const { text, params } = buildBlocksQuery(filter, viewer);
    const result = await db.query(text, params);
    const page = capBlocks(result.rows, config.limits.maxResponseBytes);
    if (page.truncated) {
      logger.debug('Resposta de blocos truncada pelo limite de bytes', {
        returned: page.blocks.length,
        bytes: page.bytes,
        limit: config.limits.maxResponseBytes,
      });
    }
    return page;
  } catch (err) {
    if (!isPublicError(err)) {
      logger.error('Erro ao buscar blocos', logger.errorMeta(err));
    }
    throw err;
  }
}

/**
 * Atalho interno: retorna apenas a lista.
 * Rotas HTTP/WS usam `getBlocksPage` para informar quando truncaram.
 */
async function getBlocks(filter, viewer) {
  const page = await getBlocksPage(filter, viewer);
  return page.blocks;
}

module.exports = { getBlocks, getBlocksPage, capBlocks };
