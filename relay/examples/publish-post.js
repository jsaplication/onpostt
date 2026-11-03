'use strict';

/**
 * Publica um post assinado.
 *
 * Uso:
 *   node examples/publish-post.js [http://localhost:3000]
 *
 * Gera uma chave efêmera em memória. Em um app real, carregue a chave do
 * armazenamento seguro do usuário — nunca a envie ao relay.
 */

globalThis.elliptic = require('elliptic');

const onpostt = require('../public/onpostt.js');

const host = process.env.ONPOSTT_HOST || process.argv[2] || 'http://localhost:3000';
const app = process.env.ONPOSTT_APP || 'examples';

async function main() {
  const keys = onpostt.generateKeys();
  onpostt.connect({ host: [host] });

  console.log('pubkey:', keys.publicKey);

  const block = await onpostt.signBlock(
    {
      mode: 'post',
      query: [['topic', 'onpostt']],
      content: 'Olá de examples/publish-post.js — ' + new Date().toISOString(),
      app: app,
    },
    keys.privateKey
  );

  if (typeof block === 'string') {
    throw new Error(block);
  }

  console.log('id:', block.id);

  const responses = await onpostt.sendBlock(block);
  for (const response of responses) {
    console.log(response.host || host, response.status, response.action || response.code || '');
    if (response.status !== 'success') {
      console.error('resposta:', response);
    }
  }

  if (responses.length === 0 || responses.every((item) => item.status !== 'success')) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error('falhou:', error.message);
  process.exitCode = 1;
});
