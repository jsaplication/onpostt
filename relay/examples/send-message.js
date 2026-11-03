'use strict';

/**
 * Envia uma mensagem cifrada e demonstra a descriptografia.
 *
 * Uso:
 *   node examples/send-message.js [http://localhost:3000]
 *
 * Variáveis opcionais:
 *   ONPOSTT_PRIVATE_KEY  chave privada do remetente (64 hex)
 *   ONPOSTT_TO           pubkey do destinatário (66/130 hex)
 *
 * Sem essas variáveis, o exemplo gera duas identidades efêmeras e mostra como
 * remetente e destinatário leem a mesma mensagem. Em um app real, a chave
 * privada nunca sai do dispositivo do usuário.
 *
 * A mensagem é assinada e cifrada pela biblioteca e gravada via HTTP. O envio
 * por WebSocket (`save_block`) também é suportado pelo relay.
 */

globalThis.elliptic = require('elliptic');

const onpostt = require('../public/onpostt.js');

const host = process.env.ONPOSTT_HOST || process.argv[2] || 'http://localhost:3000';
const app = process.env.ONPOSTT_APP || 'examples';

function identityFromEnv() {
  const privateKey = process.env.ONPOSTT_PRIVATE_KEY;
  if (!privateKey) return null;
  const publicKey = onpostt.generatePublicKey(privateKey);
  if (!onpostt.isValidPublicKey(publicKey)) {
    throw new Error('ONPOSTT_PRIVATE_KEY inválida.');
  }
  return { privateKey, publicKey };
}

async function save(block) {
  const response = await fetch(host.replace(/\/+$/, '') + '/save_block', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(block),
  });
  const body = await response.json().catch(() => null);
  return { status: response.status, body };
}

async function main() {
  const sender = identityFromEnv() || onpostt.generateKeys();
  const recipient = process.env.ONPOSTT_TO
    ? { publicKey: process.env.ONPOSTT_TO }
    : onpostt.generateKeys();

  if (!onpostt.isValidPublicKey(recipient.publicKey)) {
    throw new Error('ONPOSTT_TO inválida.');
  }

  console.log('de:', sender.publicKey);
  console.log('para:', recipient.publicKey);

  const block = await onpostt.signBlock(
    {
      mode: 'message',
      query: [
        ['from', sender.publicKey],
        ['to', recipient.publicKey],
      ],
      content: 'mensagem cifrada de examples/send-message.js',
      app: app,
    },
    sender.privateKey
  );

  if (typeof block === 'string') {
    throw new Error(block);
  }

  console.log('id:', block.id);
  const saved = await save(block);
  console.log('resposta:', saved.status, saved.body && (saved.body.action || saved.body.code));

  if (!saved.body || saved.body.status !== 'success') {
    process.exitCode = 1;
    return;
  }

  const asSender = await onpostt.decryptMessage(sender.privateKey, block);
  console.log('remetente leu:', asSender);

  if (recipient.privateKey) {
    const asRecipient = await onpostt.decryptMessage(recipient.privateKey, block);
    console.log('destinatário leu:', asRecipient);
  } else {
    console.log('destinatário usa outra chave privada para descriptografar.');
  }
}

main().catch((error) => {
  console.error('falhou:', error.message);
  process.exitCode = 1;
});
