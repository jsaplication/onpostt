'use strict';

/**
 * Acompanha o feed em tempo real via WebSocket.
 *
 * Uso:
 *   node examples/watch-feed.js [http://localhost:3000]
 *
 * Este exemplo usa o pacote `ws` diretamente para poder enviar o cabeçalho
 * `Origin` (exigido pelo relay). No navegador, use `onpostt.sub()`.
 *
 * Encerra após 30 segundos ou com Ctrl+C.
 */

const WebSocket = require('ws');

const host = (process.env.ONPOSTT_HOST || process.argv[2] || 'http://localhost:3000')
  .replace(/\/+$/, '');
const app = process.env.ONPOSTT_APP || 'examples';
const wsUrl = host.replace(/^http/i, 'ws');

const ws = new WebSocket(wsUrl, { origin: host });

console.log('conectando em', wsUrl);

ws.on('open', () => {
  ws.send(
    JSON.stringify({
      request: 'get_blocks_sub',
      subscription: 'feed',
      filter: { mode: 'post', app: app, limit: 20 },
    })
  );
});

ws.on('message', (raw) => {
  let data;
  try {
    data = JSON.parse(raw.toString());
  } catch {
    return;
  }

  if (data.response === 'hello') {
    console.log(`hello: ${data.name} (relay ${data.relay})`);
    return;
  }

  if (data.response === 'subscribed') {
    console.log('assinatura ativa:', data.subscription);
    return;
  }

  if (data.response === 'blocks' && Array.isArray(data.blocks)) {
    for (const block of data.blocks) {
      console.log(
        `${data.live ? 'live' : 'inicial'}  ${block.id.slice(0, 12)}…  ${String(block.content)}`
      );
    }
    return;
  }

  if (data.status === 'erro') {
    console.error('erro do relay:', data.code, data.message);
  }
});

ws.on('error', (error) => {
  console.error('websocket:', error.message);
  process.exitCode = 1;
});

ws.on('close', (code, reason) => {
  console.log('conexão encerrada:', code, reason.toString());
});

const timer = setTimeout(() => {
  ws.close(1000, 'exemplo concluído');
}, 30000);
timer.unref();

process.on('SIGINT', () => {
  ws.close(1000, 'interrompido');
});
