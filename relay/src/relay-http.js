'use strict';

/**
 * Relay HTTP do onpostt.
 *
 * Responsabilidades:
 * - expor a API de blocos (`/get_blocks_list`, `/save_block`);
 * - servir a dashboard, a documentação e o demo a partir de `public/`;
 * - aplicar cabeçalhos de segurança, CORS restrito e rate limit;
 * - entregar a superfície pública de status sem vazar configuração sensível.
 *
 * A aplicação Express é exportada pronta para ser montada em um servidor HTTP
 * (`src/main.js`) que também hospeda o WebSocket.
 */

const crypto = require('node:crypto');
const express = require('express');

const config = require('./config');
const logger = require('./logger');
const db = require('./db');
const stats = require('./stats');
const { publicModes } = require('./modes');
const { getBlocksPage } = require('./getBlocks');
const { saveBlock } = require('./saveBlock');
const { getTrendingTopics } = require('./trending');
const { parseReader } = require('./readAuth');
const { isPublicError } = require('./errors');

const app = express();

app.disable('x-powered-by');
app.set('trust proxy', config.http.trustProxy);
app.set('etag', 'strong');

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

function requestId() {
  return crypto.randomUUID();
}

function isJsonRequest(req) {
  const matched = req.is(['application/json', 'application/*+json']);
  return matched === null ? true : Boolean(matched);
}

function setCommonHeaders(req, res) {
  res.setHeader('X-Request-Id', req.id);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader(
    'Permissions-Policy',
    'camera=(), microphone=(self), geolocation=(), payment=(), usb=()'
  );
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "base-uri 'self'",
      "object-src 'none'",
      "frame-ancestors 'none'",
      "form-action 'self'",
      "img-src 'self' data: blob:",
      "media-src 'self' data: blob:",
      "font-src 'self'",
      "style-src 'self'",
      "script-src 'self'",
      // 'self' não cobre ws:// em todos os navegadores; os esquemas abaixo
      // continuam restritos ao host servido pela página na prática.
      "connect-src 'self' ws: wss:",
    ].join('; ')
  );
  if (config.security.enableHsts) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
}

function applyCors(req, res, origin) {
  if (!origin) return;
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept, X-Request-Id');
  res.setHeader('Access-Control-Max-Age', '600');
}

/**
 * Rate limit fixo em memória, por IP e por tipo de operação.
 * Em cluster/múltiplas instâncias, use um limitador compartilhado (Redis).
 */
function createRateLimiter(name, max) {
  const buckets = new Map();

  function sweep() {
    const now = Date.now();
    for (const [key, bucket] of buckets) {
      if (bucket.reset <= now) buckets.delete(key);
    }
  }

  const sweeper = setInterval(sweep, Math.max(config.rateLimit.windowMs, 30000));
  if (typeof sweeper.unref === 'function') sweeper.unref();

  return function rateLimiter(req, res, next) {
    const ip = req.ip || req.socket?.remoteAddress || 'unknown';
    const now = Date.now();
    let bucket = buckets.get(ip);

    if (!bucket || bucket.reset <= now) {
      bucket = { count: 0, reset: now + config.rateLimit.windowMs };
      buckets.set(ip, bucket);
    }

    bucket.count += 1;
    if (bucket.count <= max) return next();

    const retryAfter = Math.max(1, Math.ceil((bucket.reset - now) / 1000));
    res.setHeader('Retry-After', String(retryAfter));
    stats.incHttpRejected();
    logger.warn('Rate limit HTTP atingido', {
      limiter: name,
      ip,
      path: req.path,
    });
    return res.status(429).json({
      status: 'erro',
      code: 'rate_limited',
      message: 'Muitas requisições. Tente novamente em instantes.',
      requestId: req.id,
    });
  };
}

function requireJson(req, res, next) {
  if (!isJsonRequest(req)) {
    return res.status(415).json({
      status: 'erro',
      code: 'unsupported_media_type',
      message: 'Envie o corpo como application/json.',
      requestId: req.id,
    });
  }
  if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
    return res.status(400).json({
      status: 'erro',
      code: 'invalid_body',
      message: 'Corpo JSON deve ser um objeto.',
      requestId: req.id,
    });
  }
  return next();
}

function errorStatus(err) {
  if (!isPublicError(err)) return 500;
  if (err.code === 'rate_limited') return 429;
  return err.statusCode || 400;
}

function errorPayload(err) {
  if (isPublicError(err)) {
    return {
      status: 'erro',
      message: err.message,
      code: err.code,
    };
  }
  logger.error('Erro interno em requisição HTTP', logger.errorMeta(err));
  return {
    status: 'erro',
    message: 'Erro interno no servidor.',
    code: 'internal_error',
  };
}

/** Carrega o WebSocket sob demanda para evitar dependência circular. */
function broadcastBlock(block, meta) {
  try {
    const socket = require('./relay-socket');
    if (typeof socket.broadcastBlock === 'function') {
      const result = socket.broadcastBlock(block, meta);
      if (result && typeof result.catch === 'function') {
        result.catch((err) => {
          logger.error('Falha ao transmitir bloco em tempo real', logger.errorMeta(err));
        });
      }
    }
  } catch (err) {
    logger.error('Falha ao transmitir bloco em tempo real', logger.errorMeta(err));
  }
}

function saveStatus(result) {
  if (!result || result.status === 'success') return 200;
  if (result.code === 'rate_limited') return 429;
  if (result.code === 'internal_error') return 500;
  return 400;
}

async function statusSnapshot() {
  const database = await db.healthCheck();
  const snapshot = stats.snapshot();
  return {
    name: config.protocol.name,
    protocol: {
      name: config.protocol.name,
    },
    relay: {
      name: config.relayName,
      environment: config.env,
      port: config.http.port,
      startedAt: config.startedAt,
      uptimeSeconds: snapshot.uptime,
    },
    database: {
      ok: database.ok,
      latencyMs: database.latencyMs,
      error: database.error,
    },
    modes: publicModes(),
    stats: {
      users: snapshot.ws.users,
      connections: snapshot.ws.connections,
      subscriptions: snapshot.ws.subscriptions,
      httpActive: snapshot.http.active,
      httpTotal: snapshot.http.total,
      httpRejected: snapshot.http.rejected,
      blocksSaved: snapshot.blocks.saved,
      blocksRejected: snapshot.blocks.rejected,
      duplicates: snapshot.blocks.duplicates,
      lastBlockAt: snapshot.blocks.lastAt,
      memoryRss: snapshot.memory.rss,
      heapUsed: snapshot.memory.heapUsed,
    },
    limits: {
      maxBlocksPerRequest: config.limits.maxBlocksPerRequest,
      maxResponseBytes: config.limits.maxResponseBytes,
      maxBlockSize: config.limits.maxBlockSize,
      maxContentSize: config.limits.maxContentSize,
      maxImageBytes: config.limits.maxImageBytes,
      maxImageDimension: config.limits.maxImageDimension,
      maxImageContentSize: config.limits.maxImageContentSize,
      maxTopicsPerPost: config.limits.maxTopicsPerPost,
      maxTopicLength: config.limits.maxTopicLength,
      rateLimitWindowMs: config.rateLimit.windowMs,
      rateLimitMaxRead: config.rateLimit.maxRead,
      rateLimitMaxWrite: config.rateLimit.maxWrite,
      readerTokenTtlSeconds: config.limits.readerTokenTtlSeconds,
    },
    features: config.features,
    now: new Date().toISOString(),
  };
}

/* -------------------------------------------------------------------------- */
/* Middlewares globais                                                         */
/* -------------------------------------------------------------------------- */

app.use((req, res, next) => {
  req.id = requestId();
  stats.incHttpActive();
  setCommonHeaders(req, res);

  let finished = false;
  const done = () => {
    if (finished) return;
    finished = true;
    stats.decHttpActive();
  };
  res.on('finish', done);
  res.on('close', done);

  const origin = req.get('origin');
  if (origin && !config.isOriginAllowed(origin, req.get('host'))) {
    stats.incHttpRejected();
    return res.status(403).json({
      status: 'erro',
      code: 'forbidden_origin',
      message: 'Origem não permitida.',
      requestId: req.id,
    });
  }

  applyCors(req, res, origin);
  if (origin) res.setHeader('Vary', 'Origin');

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  return next();
});

app.use(
  express.json({
    limit: config.http.maxMessageSize,
    strict: true,
    type: ['application/json', 'application/*+json'],
  })
);

const readLimiter = createRateLimiter('read', config.rateLimit.maxRead);
const writeLimiter = createRateLimiter('write', config.rateLimit.maxWrite);

/* -------------------------------------------------------------------------- */
/* API                                                                         */
/* -------------------------------------------------------------------------- */

app.get('/health', async (req, res) => {
  const database = await db.healthCheck();
  const healthy = database.ok;
  res.status(healthy ? 200 : 503).json({
    status: healthy ? 'ok' : 'degraded',
    name: config.protocol.name,
    database: {
      ok: database.ok,
      latencyMs: database.latencyMs,
    },
    uptimeSeconds: Math.floor(process.uptime()),
    requestId: req.id,
    now: new Date().toISOString(),
  });
});

app.get('/status', async (req, res) => {
  res.json(await statusSnapshot());
});

app.get('/api/status', async (req, res) => {
  res.json(await statusSnapshot());
});

app.get('/api/modes', (req, res) => {
  res.json({ response: 'modes', modes: publicModes(), requestId: req.id });
});

app.get('/api/trending', readLimiter, async (req, res, next) => {
  try {
    const trending = await getTrendingTopics({
      app: req.query.app,
      limit: req.query.limit,
      window: req.query.window,
    });
    res.json({ response: 'trending', ...trending, requestId: req.id });
  } catch (err) {
    next(err);
  }
});

app.post('/get_blocks_list', readLimiter, requireJson, async (req, res, next) => {
  try {
    // `reader` é autenticação opcional. Sem ele a leitura é anônima e só
    // enxerga autores que não participam de nenhum bloqueio ativo.
    const { reader, ...filter } = req.body;
    const { viewer } = parseReader(reader);
    const page = await getBlocksPage(filter, viewer);
    res.json({
      response: 'blocks',
      blocks: page.blocks,
      truncated: page.truncated,
      requestId: req.id,
    });
  } catch (err) {
    next(err);
  }
});

app.post('/save_block', writeLimiter, requireJson, async (req, res) => {
  const block = req.body;
  const result = await saveBlock(block);
  const payload = { ...result, requestId: req.id };

  if (result.status === 'success' && (result.action === 'created' || result.action === 'removed')) {
    broadcastBlock(block, { source: 'http', requestId: req.id });
  }

  res.status(saveStatus(result)).json(payload);
});

/* -------------------------------------------------------------------------- */
/* Arquivos estáticos                                                          */
/* -------------------------------------------------------------------------- */

// Os arquivos públicos não têm hash no nome. Um cache longo serviria JS/CSS
// antigos depois de uma atualização; `no-cache` mantém a resposta rápida via
// ETag sem impedir que o navegador revalide.
const REVALIDATE_EXTENSIONS = /\.(?:html|js|css|json|svg|webmanifest)$/i;

const staticOptions = {
  dotfiles: 'deny',
  etag: true,
  fallthrough: true,
  index: 'index.html',
  maxAge: 0,
  setHeaders(res, filePath) {
    if (REVALIDATE_EXTENSIONS.test(filePath)) {
      res.setHeader('Cache-Control', 'no-cache');
    }
    res.setHeader('X-Content-Type-Options', 'nosniff');
  },
};

app.use(express.static(config.publicDir, staticOptions));

// Aliases amigáveis para a documentação textual.
app.get('/docs', (req, res) => res.redirect(302, '/doc.html'));

function redirectPreservingQuery(req, res, target) {
  const queryIndex = req.originalUrl.indexOf('?');
  const suffix = queryIndex >= 0 ? req.originalUrl.slice(queryIndex) : '';
  res.redirect(302, target + suffix);
}

// Aliases para a página pública de perfil.
app.get(['/perfil', '/profile', '/profile.html'], (req, res) => {
  redirectPreservingQuery(req, res, '/perfil.html');
});

// Aliases de entrada e cadastro.
app.get(['/entrar', '/login'], (req, res) => {
  redirectPreservingQuery(req, res, '/login.html');
});

app.get(['/cadastro', '/registrar', '/signup'], (req, res) => {
  redirectPreservingQuery(req, res, '/cadastro.html');
});

/* -------------------------------------------------------------------------- */
/* 404 e tratamento de erros                                                   */
/* -------------------------------------------------------------------------- */

app.use((req, res) => {
  const wantsJson =
    req.path.startsWith('/api/') ||
    req.path === '/health' ||
    req.path === '/status' ||
    req.path.endsWith('.json') ||
    req.get('accept')?.includes('application/json');

  if (wantsJson) {
    return res.status(404).json({
      status: 'erro',
      code: 'not_found',
      message: 'Recurso não encontrado.',
      requestId: req.id,
    });
  }

  return res.status(404).type('text/plain; charset=utf-8').send('404 — recurso não encontrado');
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);

  if (err?.type === 'entity.too.large') {
    stats.incHttpRejected();
    return res.status(413).json({
      status: 'erro',
      code: 'payload_too_large',
      message: `Corpo excede ${config.http.maxMessageSize} bytes.`,
      requestId: req.id,
    });
  }

  if (err instanceof SyntaxError && 'body' in err) {
    stats.incHttpRejected();
    return res.status(400).json({
      status: 'erro',
      code: 'invalid_json',
      message: 'JSON inválido no corpo da requisição.',
      requestId: req.id,
    });
  }

  const status = errorStatus(err);
  const payload = { ...errorPayload(err), requestId: req.id };
  if (isPublicError(err) && err.retryAfter) {
    res.setHeader('Retry-After', String(err.retryAfter));
  }

  if (!isPublicError(err)) {
    logger.error('Erro não tratado na rota HTTP', {
      method: req.method,
      path: req.path,
      ...logger.errorMeta(err),
    });
  }

  return res.status(status).json(payload);
});

module.exports = app;
module.exports.statusSnapshot = statusSnapshot;
module.exports.requireJson = requireJson;
