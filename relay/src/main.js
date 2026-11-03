'use strict';

/**
 * Ponto de entrada do relay onpostt.
 *
 * Sobe um único servidor HTTP que:
 * - serve a API e os arquivos estáticos (Express);
 * - aceita upgrade para WebSocket no mesmo host/porta.
 */

const http = require('node:http');

const config = require('./config');
const logger = require('./logger');
const db = require('./db');
const app = require('./relay-http');
const { setupWebSocket, closeWebSocket } = require('./relay-socket');

const server = http.createServer(app);

server.maxConnections = config.http.maxConnections;
server.headersTimeout = config.http.headersTimeout;
server.requestTimeout = config.http.requestTimeout;
server.keepAliveTimeout = config.http.keepAliveTimeout;

setupWebSocket(server);

server.on('clientError', (err, socket) => {
  if (!socket.writable || socket.destroyed) return;
  const status = err.code === 'HPE_HEADER_OVERFLOW' ? '431 Request Header Fields Too Large' : '400 Bad Request';
  socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`);
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    logger.error(`Porta ${config.http.port} já está em uso.`, { code: err.code });
  } else {
    logger.error('Erro no servidor HTTP', logger.errorMeta(err));
  }
  process.exitCode = 1;
});

let shuttingDown = false;

async function shutdown(signal, exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;

  logger.info('Encerrando relay', { signal, exitCode });

  const force = setTimeout(() => {
    logger.error('Encerramento forçado após timeout.');
    process.exit(exitCode || 1);
  }, 10000);
  if (typeof force.unref === 'function') force.unref();

  try {
    if (typeof closeWebSocket === 'function') await closeWebSocket();
  } catch (err) {
    logger.warn('Falha ao fechar WebSocket', logger.errorMeta(err));
  }

  try {
    await new Promise((resolve) => {
      server.close(() => resolve());
      // Encerra conexões keep-alive ociosas para o close concluir.
      if (typeof server.closeIdleConnections === 'function') server.closeIdleConnections();
    });
  } catch (err) {
    logger.warn('Falha ao fechar servidor HTTP', logger.errorMeta(err));
  }

  try {
    await db.close();
  } catch (err) {
    logger.warn('Falha ao fechar pool do banco', logger.errorMeta(err));
  }

  clearTimeout(force);
  logger.info('Relay encerrado.');
  process.exit(exitCode);
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    shutdown(signal, 0);
  });
}

process.on('uncaughtException', (err) => {
  logger.error('Exceção não capturada', logger.errorMeta(err));
  if (config.exitOnUncaught) shutdown('uncaughtException', 1);
});

process.on('unhandledRejection', (reason) => {
  const err = reason instanceof Error ? reason : new Error(String(reason));
  logger.error('Promise rejeitada sem tratamento', logger.errorMeta(err));
  if (config.exitOnUncaught) shutdown('unhandledRejection', 1);
});

function banner() {
  const lines = [
    '',
    `  ${config.relayName}`,
    `  protocolo .......... ${config.protocol.name}`,
    `  ambiente ........... ${config.env}`,
    `  escutando .......... http://${config.http.host}:${config.http.port}`,
    `  dashboard .......... http://localhost:${config.http.port}/`,
    `  documentação ....... http://localhost:${config.http.port}/doc.html`,
    `  demo ............... http://localhost:${config.http.port}/demo/`,
    `  WebSocket .......... ws://localhost:${config.http.port}${config.ws.path === '/' ? '/' : config.ws.path}`,
    `  banco .............. ${config.db.connectionString ? 'DATABASE_URL' : `${config.db.host}:${config.db.port}/${config.db.database}`}`,
    `  modos .............. ${require('./modes').list.join(', ')}`,
    '',
  ];
  process.stdout.write(`${lines.join('\n')}\n`);
}

server.listen(config.http.port, config.http.host, () => {
  banner();
  logger.info('Relay iniciado', {
    name: config.relayName,
    protocol: config.protocol.name,
    port: config.http.port,
    env: config.env,
  });
});

module.exports = { server, app, shutdown };
