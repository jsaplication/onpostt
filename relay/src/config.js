'use strict';

/**
 * Configuração central do relay onpostt.
 *
 * Regras:
 * - nenhum segredo é impresso em log;
 * - valores inválidos caem em defaults seguros;
 * - o servidor sobe mesmo sem banco, permitindo exibir a página de status.
 */

const path = require('node:path');
const fs = require('node:fs');

const { MAX_TOPICS_PER_POST, MAX_TOPIC_LENGTH } = require('./topics');

const ROOT_DIR = path.join(__dirname, '..');
const ENV_FILE = path.join(ROOT_DIR, '.env');

// Carrega .env apenas uma vez, independentemente de quem importar primeiro.
if (fs.existsSync(ENV_FILE)) {
  require('dotenv').config({ path: ENV_FILE });
}

const PROTOCOL_NAME = 'onpostt';

function intEnv(name, fallback, { min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
  const value = Number.parseInt(String(raw), 10);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function boolEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
  const value = String(raw).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on', 'sim'].includes(value)) return true;
  if (['0', 'false', 'no', 'off', 'nao', 'não'].includes(value)) return false;
  return fallback;
}

function strEnv(name, fallback = '') {
  const raw = process.env[name];
  return raw === undefined || raw === null ? fallback : String(raw).trim();
}

function listEnv(name) {
  return strEnv(name)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

/**
 * Normaliza uma origem no formato scheme://host[:port].
 * Retorna null quando inválida.
 */
function normalizeOrigin(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const raw = value.trim();

  if (raw === '*') return '*';

  try {
    const url = new URL(raw);
    if (!['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol)) return null;
    const protocol = url.protocol === 'ws:' ? 'http:' : url.protocol === 'wss:' ? 'https:' : url.protocol;
    return `${protocol}//${url.host}`.toLowerCase();
  } catch {
    return null;
  }
}

function parseTrustProxy(value) {
  const raw = String(value ?? '').trim().toLowerCase();
  if (!raw || raw === 'false' || raw === '0' || raw === 'off') return false;
  if (raw === 'true') return true;
  const numeric = Number.parseInt(raw, 10);
  if (Number.isFinite(numeric) && numeric > 0) return numeric;
  return raw; // ex.: "loopback", "linklocal"
}

const ENV = strEnv('NODE_ENV', 'development');
const PORT = intEnv('PORT_HTTP', 3000, { min: 1, max: 65535 });

const hostAllowedRaw = listEnv('HOST_ALLOWED');
const hostAllowed = [];
let allowAllOrigins = false;

for (const entry of hostAllowedRaw) {
  if (entry === '*') {
    allowAllOrigins = true;
    continue;
  }
  const normalized = normalizeOrigin(entry);
  if (normalized && normalized !== '*') hostAllowed.push(normalized);
}

const databaseUrl = strEnv('DATABASE_URL', '');
const dbSslEnabled = boolEnv('DB_SSL', false);
const dbSsl = dbSslEnabled
  ? { rejectUnauthorized: boolEnv('DB_SSL_REJECT_UNAUTHORIZED', true) }
  : false;

const database = databaseUrl
  ? {
      connectionString: databaseUrl,
      ssl: dbSsl,
    }
  : {
      host: strEnv('PGHOST', 'localhost'),
      port: intEnv('PGPORT', 5432, { min: 1, max: 65535 }),
      user: strEnv('PGUSER', 'postgres'),
      password: process.env.PGPASSWORD ?? '',
      database: strEnv('PGDATABASE', 'onpostt'),
      ssl: dbSsl,
    };

const limits = Object.freeze({
  maxBlocksPerRequest: intEnv('MAX_BLOCKS_PER_REQUEST', 1000, { min: 1, max: 5000 }),
  maxResponseBytes: intEnv('MAX_RESPONSE_BYTES', 8 * 1024 * 1024, {
    min: 64 * 1024,
    max: 64 * 1024 * 1024,
  }),
  maxBlockSize: intEnv('MAX_BLOCK_SIZE', 2 * 1024 * 1024, { min: 1024, max: 4 * 1024 * 1024 }),
  maxContentSize: intEnv('MAX_CONTENT_SIZE', 1024 * 1024, { min: 64, max: 1024 * 1024 }),
  maxImageBytes: intEnv('MAX_IMAGE_BYTES', 72 * 1024, { min: 1024, max: 192 * 1024 }),
  maxImageDimension: intEnv('MAX_IMAGE_DIMENSION', 500, { min: 16, max: 2048 }),
  maxImageContentSize: intEnv('MAX_IMAGE_CONTENT_SIZE', 128 * 1024, { min: 4096, max: 256 * 1024 }),
  maxQueryPairs: intEnv('MAX_QUERY_PAIRS', 32, { min: 1, max: 128 }),
  maxQueryKeyLength: intEnv('MAX_QUERY_KEY_LENGTH', 64, { min: 1, max: 256 }),
  maxQueryValueLength: intEnv('MAX_QUERY_VALUE_LENGTH', 2048, { min: 1, max: 16384 }),
  maxAppLength: intEnv('MAX_APP_LENGTH', 190, { min: 1, max: 512 }),
  maxFutureSkewSeconds: intEnv('MAX_FUTURE_SKEW_SECONDS', 600, { min: 0, max: 86400 }),
  readerTokenTtlSeconds: intEnv('READER_TOKEN_TTL_SECONDS', 30 * 24 * 60 * 60, {
    min: 300,
    max: 365 * 24 * 60 * 60,
  }),
  validateBlockId: boolEnv('VALIDATE_BLOCK_ID', true),
  maxTopicsPerPost: MAX_TOPICS_PER_POST,
  maxTopicLength: MAX_TOPIC_LENGTH,
});

const config = {
  env: ENV,
  isProduction: ENV === 'production',
  rootDir: ROOT_DIR,
  publicDir: path.join(ROOT_DIR, 'public'),
  docsDir: path.join(ROOT_DIR, 'docs'),
  relayName: strEnv('RELAY_NAME', `${PROTOCOL_NAME} relay`),
  protocol: Object.freeze({
    name: PROTOCOL_NAME,
  }),
  startedAt: new Date().toISOString(),
  http: Object.freeze({
    port: PORT,
    host: strEnv('HOST', '0.0.0.0'),
    trustProxy: parseTrustProxy(process.env.TRUST_PROXY),
    maxConnections: intEnv('HTTP_MAX_CONNECTIONS', 2000, { min: 1, max: 200000 }),
    maxMessageSize: intEnv('HTTP_MAX_MESSAGE_SIZE', 2 * 1024 * 1024, { min: 1024, max: 16 * 1024 * 1024 }),
    headersTimeout: intEnv('HTTP_HEADERS_TIMEOUT', 20000, { min: 1000, max: 120000 }),
    requestTimeout: intEnv('HTTP_REQUEST_TIMEOUT', 30000, { min: 1000, max: 300000 }),
    keepAliveTimeout: intEnv('HTTP_KEEP_ALIVE_TIMEOUT', 5000, { min: 1000, max: 120000 }),
  }),
  ws: Object.freeze({
    path: strEnv('SOCKET_PATH', '/') || '/',
    maxConnections: intEnv('SOCKET_MAX_CONNECTIONS', 1000, { min: 1, max: 100000 }),
    maxMessageSize: intEnv('SOCKET_MAX_MESSAGE_SIZE', 1024 * 1024, { min: 1024, max: 16 * 1024 * 1024 }),
    inactivityTimeout: intEnv('SOCKET_INACTIVITY_TIMEOUT', 600000, { min: 15000, max: 86400000 }),
    heartbeatInterval: intEnv('SOCKET_HEARTBEAT_INTERVAL', 30000, { min: 5000, max: 120000 }),
    maxSubscriptions: intEnv('SOCKET_MAX_SUBSCRIPTIONS', 25, { min: 1, max: 200 }),
    maxPubkeys: intEnv('SOCKET_MAX_PUBKEYS', 5, { min: 1, max: 50 }),
  }),
  security: Object.freeze({
    hostAllowed: Object.freeze(hostAllowed),
    allowAllOrigins,
    allowNoOrigin: boolEnv('ALLOW_NO_ORIGIN', false),
    enableHsts: boolEnv('ENABLE_HSTS', false),
  }),
  rateLimit: Object.freeze({
    // Cada ação social gera 1 escrita (+ notificação) e o cliente atualiza o
    // estado com cerca de 10 leituras. Os limites padrão precisam acomodar uso
    // interativo normal sem transformar cliques legítimos em 429.
    windowMs: intEnv('RATE_LIMIT_WINDOW_MS', 60000, { min: 1000, max: 3600000 }),
    maxRead: intEnv('RATE_LIMIT_MAX_READ', 1200, { min: 1, max: 100000 }),
    maxWrite: intEnv('RATE_LIMIT_MAX_WRITE', 300, { min: 1, max: 100000 }),
    maxWs: intEnv('RATE_LIMIT_MAX_WS', 600, { min: 1, max: 100000 }),
  }),
  db: Object.freeze({
    ...database,
    max: intEnv('MAX_POOL_SIZE', 20, { min: 1, max: 200 }),
    idleTimeoutMillis: intEnv('DB_IDLE_TIMEOUT_MS', 30000, { min: 1000, max: 600000 }),
    connectionTimeoutMillis: intEnv('DB_CONNECTION_TIMEOUT_MS', 3000, { min: 200, max: 60000 }),
    statement_timeout: intEnv('DB_STATEMENT_TIMEOUT_MS', 10000, { min: 500, max: 120000 }),
    query_timeout: intEnv('DB_STATEMENT_TIMEOUT_MS', 10000, { min: 500, max: 120000 }),
    application_name: 'onpostt-relay',
  }),
  log: Object.freeze({
    level: strEnv('LOG_LEVEL', 'info'),
    toFile: boolEnv('LOG_TO_FILE', true),
    dir: path.resolve(ROOT_DIR, strEnv('LOG_DIR', 'logs')),
  }),
  limits,
  exitOnUncaught: boolEnv('EXIT_ON_UNCAUGHT', false),
  features: Object.freeze({
    encryptedMessages: true,
    liveSubscriptions: true,
    idempotentBlocks: true,
    reactions: true,
    commentReplies: true,
    images: true,
    topics: true,
    trending: true,
    readerAuth: true,
    blockPrivacy: true,
    encryptedAtRest: false,
  }),
};

/**
 * Confere se a origem é a mesma do host da requisição.
 * Usado para permitir a própria aplicação sem configuração extra.
 */
function isSameOrigin(origin, hostHeader) {
  if (!origin || !hostHeader) return false;
  try {
    const parsed = new URL(origin);
    return parsed.host.toLowerCase() === String(hostHeader).toLowerCase();
  } catch {
    return false;
  }
}

/**
 * Verifica se uma origem pode acessar o relay (HTTP CORS / WebSocket).
 */
function isOriginAllowed(origin, hostHeader) {
  if (!origin) return config.security.allowNoOrigin;
  if (config.security.allowAllOrigins) return true;
  if (isSameOrigin(origin, hostHeader)) return true;

  const normalized = normalizeOrigin(origin);
  if (!normalized) return false;
  return config.security.hostAllowed.includes(normalized);
}

module.exports = config;
module.exports.normalizeOrigin = normalizeOrigin;
module.exports.isOriginAllowed = isOriginAllowed;
module.exports.isSameOrigin = isSameOrigin;
