'use strict';

const { Pool } = require('pg');
const config = require('./config');
const logger = require('./logger');

const pool = new Pool({
  ...config.db,
  keepAlive: true,
});

// Um erro em cliente ocioso não deve derrubar o processo.
pool.on('error', (err) => {
  logger.error('Erro inesperado no pool PostgreSQL', logger.errorMeta(err));
});

/**
 * Executa uma query usando o pool. Nunca interpola valores do usuário.
 */
async function query(text, params = []) {
  const started = Date.now();
  try {
    const result = await pool.query(text, params);
    const elapsed = Date.now() - started;
    if (elapsed > 500) {
      logger.warn('Query lenta', { elapsedMs: elapsed, rows: result.rowCount });
    }
    return result;
  } catch (err) {
    logger.error('Falha ao executar query', logger.errorMeta(err));
    throw err;
  }
}

/**
 * Executa uma função dentro de uma transação.
 * @template T
 * @param {(client: import('pg').PoolClient) => Promise<T>} fn
 * @returns {Promise<T>}
 */
async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackError) {
      logger.error('Falha no rollback', logger.errorMeta(rollbackError));
    }
    throw err;
  } finally {
    client.release();
  }
}

let healthCache = { at: 0, ok: false, latencyMs: null, error: null };
const HEALTH_CACHE_MS = 3000;

/**
 * Verifica o banco com cache curto para não sobrecarregar a página de status.
 */
async function healthCheck({ force = false } = {}) {
  const now = Date.now();
  if (!force && now - healthCache.at < HEALTH_CACHE_MS) return { ...healthCache, cached: true };

  const started = Date.now();
  try {
    await pool.query('SELECT 1 AS ok');
    healthCache = {
      at: Date.now(),
      ok: true,
      latencyMs: Date.now() - started,
      error: null,
    };
  } catch (err) {
    healthCache = {
      at: Date.now(),
      ok: false,
      latencyMs: Date.now() - started,
      error: err.code || err.name || 'db_error',
    };
  }
  return { ...healthCache, cached: false };
}

async function close() {
  await pool.end();
}

module.exports = {
  pool,
  query,
  withTransaction,
  healthCheck,
  close,
};
