'use strict';

/**
 * Lista os posts mais recentes da aplicação.
 *
 * Uso:
 *   node examples/read-feed.js [http://localhost:3000]
 */

globalThis.elliptic = require('elliptic');

const onpostt = require('../public/onpostt.js');

const host = process.env.ONPOSTT_HOST || process.argv[2] || 'http://localhost:3000';
const app = process.env.ONPOSTT_APP || 'examples';

function preview(content) {
  if (typeof content === 'string') return content;
  if (content && typeof content === 'object' && content.image) {
    const image = content.image;
    const bytes = Math.round(
      Buffer.byteLength(String(image.data || ''), 'base64') / 1024
    );
    const caption = typeof content.text === 'string' && content.text ? content.text + ' ' : '';
    return `${caption}[foto ${image.width}x${image.height} ${image.mime}, ${bytes} KiB]`;
  }
  return JSON.stringify(content);
}

async function main() {
  onpostt.connect({ host: [host] });

  const blocks = await onpostt.list({ mode: 'post', app: app, limit: 10 });

  if (blocks.length === 0) {
    console.log('nenhum post encontrado para app=' + app);
    return;
  }

  for (const block of blocks) {
    const when = new Date(block.created_at * 1000).toISOString();
    console.log(`${when}  ${block.pubkey.slice(0, 16)}…  ${preview(block.content)}`);
  }
}

main().catch((error) => {
  console.error('falhou:', error.message);
  process.exitCode = 1;
});
