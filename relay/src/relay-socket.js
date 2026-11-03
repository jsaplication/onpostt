'use strict';

/**
 * Relay WebSocket do onpostt.
 *
 * Modelo:
 * - o cliente abre um socket e cria assinaturas (`get_blocks_sub`) com filtros;
 * - o servidor envia os blocos iniciais e depois blocos em tempo real;
 * - mensagens (`mode: "message"`) podem ser gravadas pelo próprio socket;
 * - todos os demais modos usam HTTP (`/save_block`).
 *
 * Segurança:
 * - origem validada no upgrade (mesma origem é permitida automaticamente);
 * - limite de conexões, de payload, de assinaturas e de pubkeys;
 * - rate limit por conexão;
 * - heartbeat ping/pong e timeout de inatividade;
 * - nenhum bloco é entregue a uma assinatura que não case com o filtro.
 */

const crypto = require('node:crypto');
const { WebSocketServer, WebSocket } = require('ws');

const config = require('./config');
const logger = require('./logger');
const stats = require('./stats');
const { normalizeFilter } = require('./query');
const { getBlocksPage } = require('./getBlocks');
const { saveBlock } = require('./saveBlock');
const { blockMatchesFilter } = require('./protocol');
const { parseReader } = require('./readAuth');
const { participantKeys, isVisibleTo } = require('./visibility');
const { isPublicError } = require('./errors');

const MAX_SEEN_PER_SUBSCRIPTION = 2000;

const wss = new WebSocketServer({
  noServer: true,
  perMessageDeflate: false,
  clientTracking: false,
  maxPayload: config.ws.maxMessageSize,
});

/** @type {Map<import('ws').WebSocket, object>} */
const clients = new Map();
let subscriptionSeq = 0;
let heartbeatTimer = null;
let cleanupTimer = null;
let started = false;

function sendJson(ws, payload) {
  if (ws.readyState !== WebSocket.OPEN) return false;
  try {
    ws.send(JSON.stringify(payload));
    return true;
  } catch (err) {
    logger.warn('Falha ao enviar mensagem WebSocket', { message: err.message });
    return false;
  }
}

function closeSocket(ws, code, reason) {
  try {
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
      ws.close(code, reason);
    }
  } catch {
    /* ignore */
  }
}

function refreshStats() {
  const users = new Set();
  let subscriptions = 0;

  for (const state of clients.values()) {
    subscriptions += state.subscriptions.size;
    for (const pubkey of state.pubkeys) users.add(pubkey.toLowerCase());
  }

  stats.setWs({
    connections: clients.size,
    users: users.size,
    subscriptions,
  });
}

function sanitizeSubscriptionId(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 64) return null;
  if (!/^[A-Za-z0-9_.:-]+$/.test(trimmed)) return null;
  return trimmed;
}

function requestIdOf(data) {
  return sanitizeSubscriptionId(data?.requestId || data?.id) || undefined;
}

function errorPayload(message, code = 'invalid_request', requestId) {
  return {
    status: 'erro',
    code,
    message,
    ...(requestId ? { requestId } : {}),
  };
}

function rememberBlock(subscription, id) {
  if (!id || subscription.seen.has(id)) return false;
  subscription.seen.add(id);
  subscription.order.push(id);
  while (subscription.order.length > MAX_SEEN_PER_SUBSCRIPTION) {
    const oldest = subscription.order.shift();
    subscription.seen.delete(oldest);
  }
  return true;
}

function pubkeysFromSubscriptions(subscriptions, skipId) {
  const keys = new Set();
  for (const [id, subscription] of subscriptions) {
    if (skipId && id === skipId) continue;
    const pubkey = subscription.filter?.pubkey;
    if (pubkey) keys.add(pubkey.toLowerCase());
  }
  return keys;
}

function resetInactivity(state) {
  if (state.inactivityTimer) clearTimeout(state.inactivityTimer);
  state.inactivityTimer = setTimeout(() => {
    logger.debug('WebSocket encerrado por inatividade', { connection: state.id });
    state.ws.terminate();
  }, config.ws.inactivityTimeout);
  if (typeof state.inactivityTimer.unref === 'function') state.inactivityTimer.unref();
}

function consumeRate(state) {
  const now = Date.now();
  if (now >= state.rate.reset) {
    state.rate.count = 0;
    state.rate.reset = now + config.rateLimit.windowMs;
  }
  state.rate.count += 1;
  return state.rate.count <= config.rateLimit.maxWs;
}

function addSubscription(ws, state, data) {
  const requestId = requestIdOf(data);
  const input = data.filter;

  let reader;
  try {
    reader = parseReader(data.reader);
  } catch (err) {
    if (!isPublicError(err)) logger.error('Erro ao validar token de leitura WS', logger.errorMeta(err));
    sendJson(
      ws,
      errorPayload(
        isPublicError(err) ? err.message : 'Token de leitura inválido.',
        isPublicError(err) ? err.code : 'invalid_reader',
        requestId
      )
    );
    return;
  }

  let filter;
  try {
    filter = normalizeFilter(input);
  } catch (err) {
    if (!isPublicError(err)) logger.error('Erro ao validar filtro WS', logger.errorMeta(err));
    sendJson(
      ws,
      errorPayload(
        isPublicError(err) ? err.message : 'Filtro inválido.',
        isPublicError(err) ? err.code : 'invalid_filter',
        requestId
      )
    );
    return;
  }

  const id =
    sanitizeSubscriptionId(data.subscription) ||
    sanitizeSubscriptionId(data.subId) ||
    `sub_${++subscriptionSeq}`;

  if (state.subscriptions.size >= config.ws.maxSubscriptions && !state.subscriptions.has(id)) {
    sendJson(
      ws,
      errorPayload(
        `Limite de ${config.ws.maxSubscriptions} assinaturas por conexão atingido.`,
        'too_many_subscriptions',
        requestId
      )
    );
    return;
  }

  // A pubkey antiga de uma assinatura substituída deixa de contar para o limite.
  const nextPubkeys = pubkeysFromSubscriptions(state.subscriptions, id);
  if (filter.pubkey) nextPubkeys.add(filter.pubkey.toLowerCase());
  if (nextPubkeys.size > config.ws.maxPubkeys) {
    sendJson(
      ws,
      errorPayload(
        `Limite de ${config.ws.maxPubkeys} pubkeys por conexão atingido.`,
        'too_many_pubkeys',
        requestId
      )
    );
    return;
  }

  const subscription = {
    id,
    filter,
    viewer: reader.viewer,
    seen: new Set(),
    order: [],
    createdAt: Date.now(),
  };

  state.subscriptions.set(id, subscription);
  state.pubkeys = nextPubkeys;
  refreshStats();

  sendJson(ws, {
    response: 'subscribed',
    subscription: id,
    ...(requestId ? { requestId } : {}),
  });

  getBlocksPage(filter, subscription.viewer)
    .then((page) => {
      if (ws.readyState !== WebSocket.OPEN) return;
      const fresh = page.blocks.filter((block) => rememberBlock(subscription, block.id));
      sendJson(ws, {
        response: 'blocks',
        subscription: id,
        blocks: fresh,
        truncated: page.truncated,
        initial: true,
        ...(requestId ? { requestId } : {}),
      });
    })
    .catch((err) => {
      if (!isPublicError(err)) {
        logger.error('Falha ao carregar blocos iniciais', logger.errorMeta(err));
      }
      sendJson(
        ws,
        errorPayload(
          isPublicError(err) ? err.message : 'Falha ao carregar blocos iniciais.',
          isPublicError(err) ? err.code : 'internal_error',
          requestId
        )
      );
    });
}

function removeSubscription(ws, state, data) {
  const id = sanitizeSubscriptionId(data.subscription || data.subId || data.id);
  const requestId = requestIdOf(data);

  if (!id || !state.subscriptions.has(id)) {
    sendJson(ws, errorPayload('Assinatura não encontrada.', 'subscription_not_found', requestId));
    return;
  }

  state.subscriptions.delete(id);
  state.pubkeys = pubkeysFromSubscriptions(state.subscriptions);
  refreshStats();
  sendJson(ws, {
    response: 'unsubscribed',
    subscription: id,
    ...(requestId ? { requestId } : {}),
  });
}

async function saveFromSocket(ws, state, block, requestId) {
  if (!block || typeof block !== 'object' || Array.isArray(block)) {
    sendJson(ws, errorPayload('Bloco inválido.', 'invalid_block', requestId));
    return;
  }

  if (block.mode !== 'message') {
    sendJson(
      ws,
      errorPayload(
        'Apenas o modo "message" é aceito via WebSocket. Use POST /save_block para os demais modos.',
        'use_http',
        requestId
      )
    );
    return;
  }

  let result;
  try {
    result = await saveBlock(block);
  } catch (err) {
    logger.error('Erro inesperado ao salvar mensagem via WebSocket', logger.errorMeta(err));
    sendJson(ws, errorPayload('Erro interno ao salvar mensagem.', 'internal_error', requestId));
    return;
  }

  sendJson(ws, { ...result, ...(requestId ? { requestId } : {}) });

  if (result.status === 'success' && result.action === 'created') {
    broadcastBlock(block, { source: 'ws', connection: state.id });
  }
}

async function handleMessage(ws, state, raw) {
  resetInactivity(state);

  if (!consumeRate(state)) {
    sendJson(ws, errorPayload('Muitas mensagens. Aguarde um instante.', 'rate_limited'));
    return;
  }

  const size = Buffer.isBuffer(raw) ? raw.byteLength : Buffer.byteLength(String(raw));
  if (size > config.ws.maxMessageSize) {
    sendJson(ws, errorPayload('Mensagem muito grande.', 'payload_too_large'));
    return;
  }

  let data;
  try {
    data = JSON.parse(raw.toString());
  } catch {
    sendJson(ws, errorPayload('JSON inválido.', 'invalid_json'));
    return;
  }

  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    sendJson(ws, errorPayload('Mensagem deve ser um objeto JSON.', 'invalid_request'));
    return;
  }

  const request = data.request;

  if (request === 'ping') {
    sendJson(ws, { response: 'pong', ts: Date.now(), ...(data.requestId ? { requestId: String(data.requestId).slice(0, 64) } : {}) });
    return;
  }

  if (request === 'get_blocks_sub' || request === 'subscribe') {
    addSubscription(ws, state, data);
    return;
  }

  if (request === 'unsubscribe') {
    removeSubscription(ws, state, data);
    return;
  }

  if (request === 'get_status') {
    sendJson(ws, {
      response: 'status',
      stats: stats.snapshot(),
      connection: {
        id: state.id,
        subscriptions: state.subscriptions.size,
        pubkeys: state.pubkeys.size,
      },
      requestId: requestIdOf(data),
    });
    return;
  }

  if (request === 'save_block') {
    await saveFromSocket(ws, state, data.block, requestIdOf(data));
    return;
  }

  sendJson(ws, errorPayload('Requisição desconhecida.', 'unknown_request', requestIdOf(data)));
}

/* -------------------------------------------------------------------------- */
/* Ciclo de vida                                                              */
/* -------------------------------------------------------------------------- */

function connectionState(ws, req) {
  return {
    id: crypto.randomUUID(),
    ws,
    ip: req.socket?.remoteAddress || 'unknown',
    subscriptions: new Map(),
    pubkeys: new Set(),
    rate: { count: 0, reset: Date.now() + config.rateLimit.windowMs },
    inactivityTimer: null,
  };
}

function startTimers() {
  heartbeatTimer = setInterval(() => {
    for (const [ws, state] of clients) {
      if (state.alive === false) {
        ws.terminate();
        continue;
      }
      state.alive = false;
      if (ws.readyState === WebSocket.OPEN) {
        try {
          ws.ping();
        } catch {
          ws.terminate();
        }
      }
    }
  }, config.ws.heartbeatInterval);
  if (typeof heartbeatTimer.unref === 'function') heartbeatTimer.unref();

  cleanupTimer = setInterval(() => {
    refreshStats();
  }, 60000);
  if (typeof cleanupTimer.unref === 'function') cleanupTimer.unref();
}

function setupWebSocket(server) {
  if (started) throw new Error('WebSocket já inicializado.');
  started = true;

  server.on('upgrade', (req, socket, head) => {
    let pathname = '/';
    try {
      pathname = new URL(req.url, 'http://localhost').pathname;
    } catch {
      pathname = req.url || '/';
    }

    if (config.ws.path !== '/' && pathname !== config.ws.path) {
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }

    const origin = req.headers.origin;
    if (!config.isOriginAllowed(origin, req.headers.host)) {
      logger.warn('Upgrade WebSocket rejeitado por origem', {
        origin: origin || '(ausente)',
        host: req.headers.host,
      });
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }

    if (clients.size >= config.ws.maxConnections) {
      logger.warn('Upgrade WebSocket rejeitado: limite de conexões', {
        connections: clients.size,
        limit: config.ws.maxConnections,
      });
      socket.write('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  });

  wss.on('connection', (ws, req) => {
    const state = connectionState(ws, req);
    state.alive = true;
    clients.set(ws, state);
    refreshStats();
    resetInactivity(state);

    logger.debug('WebSocket conectado', {
      connection: state.id,
      connections: clients.size,
    });

    sendJson(ws, {
      response: 'hello',
      name: config.protocol.name,
      relay: config.relayName,
      heartbeatIntervalMs: config.ws.heartbeatInterval,
    });

    ws.on('pong', () => {
      state.alive = true;
      resetInactivity(state);
    });

    ws.on('message', (raw) => {
      handleMessage(ws, state, raw).catch((err) => {
        logger.error('Erro ao processar mensagem WebSocket', logger.errorMeta(err));
        sendJson(ws, errorPayload('Erro interno ao processar mensagem.', 'internal_error'));
      });
    });

    ws.on('close', () => {
      if (state.inactivityTimer) clearTimeout(state.inactivityTimer);
      clients.delete(ws);
      refreshStats();
      logger.debug('WebSocket desconectado', {
        connection: state.id,
        connections: clients.size,
      });
    });

    ws.on('error', (err) => {
      logger.warn('Erro no WebSocket', {
        connection: state.id,
        message: err.message,
      });
    });
  });

  startTimers();
  return wss;
}

/**
 * Entrega um bloco às assinaturas que casarem com o filtro.
 * A dedupe é por assinatura, não global: dois clientes diferentes
 * precisam receber o mesmo bloco.
 */
async function broadcastBlock(block, meta = {}) {
  if (!block || typeof block !== 'object') return 0;
  let deliveries = 0;

  try {
    // O mesmo bloqueio/visibilidade pode valer para várias assinaturas.
    // Cacheia apenas durante esta transmissão, sem risco de ficar obsoleto.
    const visibilityCache = new Map();

    for (const [ws, state] of clients) {
      if (ws.readyState !== WebSocket.OPEN) continue;

      for (const subscription of state.subscriptions.values()) {
        if (!blockMatchesFilter(block, subscription.filter)) continue;

        const cacheKey = [
          subscription.viewer || '',
          block.mode || '',
          ...participantKeys(block),
        ].join('|');

        let visible = visibilityCache.get(cacheKey);
        if (visible === undefined) {
          try {
            visible = await isVisibleTo(block, subscription.viewer);
          } catch (err) {
            // Fail closed: em dúvida, não vaza o bloco ao vivo.
            logger.error('Falha ao verificar visibilidade de bloco', logger.errorMeta(err));
            visible = false;
          }
          visibilityCache.set(cacheKey, visible);
        }

        if (!visible) continue;
        if (!rememberBlock(subscription, block.id)) continue;

        const ok = sendJson(ws, {
          response: 'blocks',
          subscription: subscription.id,
          blocks: [block],
          live: true,
        });
        if (ok) deliveries += 1;
      }
    }

    if (deliveries > 0) {
      logger.debug('Bloco transmitido em tempo real', {
        id: block.id?.slice(0, 12),
        mode: block.mode,
        deliveries,
        source: meta.source,
      });
    }
  } catch (err) {
    logger.error('Falha ao transmitir bloco em tempo real', logger.errorMeta(err));
    return 0;
  }

  return deliveries;
}

async function closeWebSocket() {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  if (cleanupTimer) clearInterval(cleanupTimer);
  heartbeatTimer = null;
  cleanupTimer = null;

  for (const [ws, state] of clients) {
    if (state.inactivityTimer) clearTimeout(state.inactivityTimer);
    closeSocket(ws, 1001, 'Servidor encerrando');
  }
  clients.clear();
  refreshStats();

  await new Promise((resolve) => {
    wss.close(() => resolve());
  });
}

function getStats() {
  const users = new Set();
  let subscriptions = 0;
  for (const state of clients.values()) {
    subscriptions += state.subscriptions.size;
    for (const pubkey of state.pubkeys) users.add(pubkey.toLowerCase());
  }
  return {
    connections: clients.size,
    users: users.size,
    subscriptions,
    maxConnections: config.ws.maxConnections,
  };
}

module.exports = {
  setupWebSocket,
  broadcastBlock,
  closeWebSocket,
  getStats,
  wss,
};
