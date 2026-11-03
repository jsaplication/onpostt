'use strict';

/**
 * Publica um post com foto embutida em base64.
 *
 * Este exemplo gera uma PNG 500x375 em memória (o mesmo formato que o frontend
 * produz depois do redimensionamento) e envia o bloco assinado. O relay valida
 * magic bytes, tamanho e dimensões reais antes de gravar.
 *
 * Uso:
 *   node examples/publish-photo.js http://localhost:3000
 */

const zlib = require('node:zlib');

globalThis.elliptic = require('elliptic');
const onpostt = require('../public/onpostt.js');

const HOST = process.argv[2] || process.env.ONPOSTT_HOST || 'http://localhost:3000';
const APP = process.env.ONPOSTT_APP || 'examples';
const WIDTH = 500;
const HEIGHT = 375;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBytes = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), 0);
  return Buffer.concat([length, typeBytes, data, crc]);
}

function makePng(width, height) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // 8 bits por canal
  header[9] = 2; // RGB

  const raw = Buffer.alloc((width * 3 + 1) * height);
  let offset = 0;
  for (let y = 0; y < height; y += 1) {
    raw[offset += 0] = 0; // filtro "None"
    offset += 1;
    for (let x = 0; x < width; x += 1) {
      raw[offset] = Math.round((x / width) * 255);
      raw[offset + 1] = Math.round((y / height) * 120);
      raw[offset + 2] = 180;
      offset += 3;
    }
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

async function main() {
  const keys = onpostt.generateKeys();
  onpostt.connect({ host: [HOST] });

  const image = makePng(WIDTH, HEIGHT);
  const block = await onpostt.signBlock(
    {
      mode: 'post',
      query: [['topic', 'foto']],
      app: APP,
      content: {
        text: 'Foto de exemplo gerada localmente',
        image: {
          mime: 'image/png',
          data: image.toString('base64'),
          width: WIDTH,
          height: HEIGHT,
        },
      },
    },
    keys.privateKey
  );

  if (typeof block === 'string') throw new Error(block);

  console.log('pubkey:', keys.publicKey);
  console.log('imagem:', WIDTH + 'x' + HEIGHT, Math.round(image.length / 1024) + ' KiB');
  console.log('id:', block.id);

  const responses = await onpostt.sendBlock(block);
  responses.forEach((response) => {
    console.log(response.host || HOST, response.status, response.action || response.code, response.message || '');
  });

  if (!responses.some((response) => response.status === 'success')) {
    process.exitCode = 1;
    return;
  }

  const posts = await onpostt.list({ mode: 'post', app: APP, query: [['topic', 'foto']], limit: 5 });
  const saved = posts.find((post) => post.id === block.id);
  if (!saved || !saved.content || !saved.content.image) {
    throw new Error('O post com foto não apareceu na consulta.');
  }

  console.log('consulta: imagem encontrada em', saved.id.slice(0, 12), '...');
}

main().catch((error) => {
  console.error('falha:', error.message);
  process.exitCode = 1;
});
