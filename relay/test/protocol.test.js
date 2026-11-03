'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

globalThis.elliptic = require('elliptic');

const onpostt = require('../public/onpostt.js');
const {
  validateBlockDetailed,
  blockMatchesFilter,
  validateEncryptedContent,
  validateQuery,
} = require('../src/protocol');
const { computeBlockId, ec, sha256 } = require('../src/crypto');

const keys = onpostt.generateKeys();
const now = () => Math.floor(Date.now() / 1000);

const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64'
);

function pngWithDimensions(width, height) {
  const bytes = Buffer.from(PNG_1X1);
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}

function imageBlock(data, { mime = 'image/png', width = 1, height = 1, text } = {}) {
  const image = { mime, data: data.toString('base64'), width, height };
  const content = { image };
  if (text !== undefined) content.text = text;
  return manualSign({ mode: 'post', query: [], content, app: 'tests' });
}

async function manualSign(block) {
  const unsigned = { ...block };
  delete unsigned.sig;
  delete unsigned.id;
  if (!unsigned.created_at) unsigned.created_at = now();
  if (!unsigned.pubkey) unsigned.pubkey = keys.publicKey;
  unsigned.id = computeBlockId(unsigned);
  const text = JSON.stringify(unsigned);
  const sig = ec.keyFromPrivate(keys.privateKey, 'hex').sign(sha256(text)).toDER('hex');
  return { ...unsigned, sig };
}

test('a block produced by the library is valid', async () => {
  const block = await onpostt.signBlock(
    {
      mode: 'post',
      query: [['topic', 'onpostt']],
      content: 'olá',
      app: 'tests',
    },
    keys.privateKey
  );

  assert.equal(typeof block, 'object');
  assert.deepEqual(validateBlockDetailed(block), { valid: true });
});

test('tampered content is rejected by signature', async () => {
  const block = await onpostt.signBlock(
    { mode: 'post', query: [], content: 'original', app: 'tests' },
    keys.privateKey
  );
  block.content = 'adulterado';

  const result = validateBlockDetailed(block);
  assert.equal(result.valid, false);
  assert.equal(result.code, 'invalid_signature');
});

test('a mismatched id is rejected', async () => {
  // Assinatura válida sobre um bloco cujo id não corresponde ao conteúdo.
  const unsigned = {
    pubkey: keys.publicKey,
    created_at: now(),
    mode: 'post',
    query: [],
    content: 'id errado',
    app: 'tests',
    id: 'f'.repeat(64),
  };
  const signature = ec
    .keyFromPrivate(keys.privateKey, 'hex')
    .sign(sha256(JSON.stringify(unsigned)))
    .toDER('hex');
  const block = { ...unsigned, sig: signature };

  const result = validateBlockDetailed(block);
  assert.equal(result.valid, false);
  assert.equal(result.code, 'invalid_id');
});

test('follow requires follower === pubkey and a valid target', async () => {
  const other = onpostt.generateKeys().publicKey;

  const wrongFollower = await manualSign({
    mode: 'follow',
    query: [
      ['follower', other],
      ['following', other],
    ],
    content: '',
    app: 'tests',
  });
  assert.equal(validateBlockDetailed(wrongFollower).code, 'invalid_block');

  const selfFollow = await manualSign({
    mode: 'follow',
    query: [
      ['follower', keys.publicKey],
      ['following', keys.publicKey],
    ],
    content: '',
    app: 'tests',
  });
  assert.match(validateBlockDetailed(selfFollow).error, /seguir a si mesmo/);
});

test('block requires blocker === pubkey and a different valid target', async () => {
  const other = onpostt.generateKeys().publicKey;

  const valid = await manualSign({
    mode: 'block',
    query: [
      ['blocker', keys.publicKey],
      ['blocked', other],
    ],
    app: 'tests',
  });
  assert.deepEqual(validateBlockDetailed(valid), { valid: true });

  const wrongBlocker = await manualSign({
    mode: 'block',
    query: [
      ['blocker', other],
      ['blocked', keys.publicKey],
    ],
    app: 'tests',
  });
  assert.equal(validateBlockDetailed(wrongBlocker).code, 'invalid_block');

  const selfBlock = await manualSign({
    mode: 'block',
    query: [
      ['blocker', keys.publicKey],
      ['blocked', keys.publicKey],
    ],
    app: 'tests',
  });
  assert.match(validateBlockDetailed(selfBlock).error, /bloquear a si mesmo/);
});

test('message requires an encrypted envelope and from === pubkey', async () => {
  const peer = onpostt.generateKeys().publicKey;

  const plain = await manualSign({
    mode: 'message',
    query: [
      ['from', keys.publicKey],
      ['to', peer],
    ],
    content: 'texto aberto',
    app: 'tests',
  });
  assert.equal(validateBlockDetailed(plain).code, 'invalid_message');

  const wrongFrom = await manualSign({
    mode: 'message',
    query: [
      ['from', peer],
      ['to', peer],
    ],
    content: JSON.stringify({
      forRecipient: {
        ciphertext: 'aa'.repeat(32),
        iv: 'bb'.repeat(12),
        senderPubKey: peer,
      },
    }),
    app: 'tests',
  });
  assert.match(validateBlockDetailed(wrongFrom).error, /from/);

  const valid = await onpostt.signBlock(
    {
      mode: 'message',
      query: [
        ['from', keys.publicKey],
        ['to', peer],
      ],
      content: 'segredo',
      app: 'tests',
    },
    keys.privateKey
  );
  assert.deepEqual(validateBlockDetailed(valid), { valid: true });
});

test('delete accepts missing content', async () => {
  const block = await manualSign({
    mode: 'delete',
    query: [['block', 'a'.repeat(64)]],
    app: 'tests',
  });

  assert.deepEqual(validateBlockDetailed(block), { valid: true });
});

test('like, follow and reaction accept missing content', async () => {
  const other = onpostt.generateKeys().publicKey;

  const like = await manualSign({
    mode: 'like',
    query: [['block', 'a'.repeat(64)]],
    app: 'tests',
  });
  assert.deepEqual(validateBlockDetailed(like), { valid: true });

  const follow = await manualSign({
    mode: 'follow',
    query: [
      ['follower', keys.publicKey],
      ['following', other],
    ],
    app: 'tests',
  });
  assert.deepEqual(validateBlockDetailed(follow), { valid: true });

  const reaction = await manualSign({
    mode: 'reaction',
    query: [
      ['block', 'a'.repeat(64)],
      ['reaction', '🔥'],
    ],
    app: 'tests',
  });
  assert.deepEqual(validateBlockDetailed(reaction), { valid: true });

  const repost = await manualSign({
    mode: 'repost',
    query: [['block', 'a'.repeat(64)]],
    app: 'tests',
  });
  assert.deepEqual(validateBlockDetailed(repost), { valid: true });
});

test('repost requires a valid target block id', async () => {
  const missing = await manualSign({
    mode: 'repost',
    query: [],
    app: 'tests',
  });
  assert.equal(validateBlockDetailed(missing).code, 'invalid_query');

  const invalid = await manualSign({
    mode: 'repost',
    query: [['block', 'não-é-id']],
    app: 'tests',
  });
  assert.equal(validateBlockDetailed(invalid).code, 'invalid_block');
});

test('reaction requires a short emoji and no extra query keys', async () => {
  const block = await onpostt.signBlock(
    {
      mode: 'reaction',
      query: [
        ['block', 'a'.repeat(64)],
        ['reaction', '🔥'],
      ],
      app: 'tests',
    },
    keys.privateKey
  );
  assert.deepEqual(validateBlockDetailed(block), { valid: true });

  const missing = await manualSign({
    mode: 'reaction',
    query: [['block', 'a'.repeat(64)]],
    app: 'tests',
  });
  assert.equal(validateBlockDetailed(missing).code, 'invalid_query');

  const empty = await manualSign({
    mode: 'reaction',
    query: [
      ['block', 'a'.repeat(64)],
      ['reaction', '   '],
    ],
    app: 'tests',
  });
  assert.equal(validateBlockDetailed(empty).code, 'invalid_block');

  const tooLong = await manualSign({
    mode: 'reaction',
    query: [
      ['block', 'a'.repeat(64)],
      ['reaction', '🔥'.repeat(33)],
    ],
    app: 'tests',
  });
  assert.equal(validateBlockDetailed(tooLong).code, 'invalid_block');

  const extra = await manualSign({
    mode: 'reaction',
    query: [
      ['block', 'a'.repeat(64)],
      ['reaction', '🔥'],
      ['topic', 'x'],
    ],
    app: 'tests',
  });
  assert.equal(validateBlockDetailed(extra).code, 'invalid_query');
});

test('comment accepts an optional parent and rejects invalid extras', async () => {
  const parent = await onpostt.signBlock(
    {
      mode: 'comment',
      query: [
        ['block', 'a'.repeat(64)],
        ['parent', 'b'.repeat(64)],
      ],
      content: 'resposta',
      app: 'tests',
    },
    keys.privateKey
  );
  assert.deepEqual(validateBlockDetailed(parent), { valid: true });

  const invalidParent = await manualSign({
    mode: 'comment',
    query: [
      ['block', 'a'.repeat(64)],
      ['parent', 'não-é-id'],
    ],
    content: 'resposta',
    app: 'tests',
  });
  assert.equal(validateBlockDetailed(invalidParent).code, 'invalid_block');

  const selfParent = await manualSign({
    mode: 'comment',
    query: [
      ['block', 'a'.repeat(64)],
      ['parent', 'a'.repeat(64)],
    ],
    content: 'resposta',
    app: 'tests',
  });
  assert.equal(validateBlockDetailed(selfParent).code, 'invalid_block');

  const extra = await manualSign({
    mode: 'comment',
    query: [
      ['block', 'a'.repeat(64)],
      ['parent', 'b'.repeat(64)],
      ['topic', 'x'],
    ],
    content: 'resposta',
    app: 'tests',
  });
  assert.equal(validateBlockDetailed(extra).code, 'invalid_query');
});

test('notification references a recipient, target, interaction and kind', async () => {
  const owner = onpostt.generateKeys().publicKey;
  const target = 'a'.repeat(64);
  const interaction = 'b'.repeat(64);

  const valid = await manualSign({
    mode: 'notification',
    query: [
      ['to', owner],
      ['block', target],
      ['interaction', interaction],
      ['kind', 'like'],
    ],
    app: 'tests',
  });
  assert.deepEqual(validateBlockDetailed(valid), { valid: true });

  const self = await manualSign({
    mode: 'notification',
    query: [
      ['to', keys.publicKey],
      ['block', target],
      ['interaction', interaction],
      ['kind', 'like'],
    ],
    app: 'tests',
  });
  assert.equal(validateBlockDetailed(self).code, 'invalid_block');

  const badKind = await manualSign({
    mode: 'notification',
    query: [
      ['to', owner],
      ['block', target],
      ['interaction', interaction],
      ['kind', 'mention'],
    ],
    app: 'tests',
  });
  assert.equal(validateBlockDetailed(badKind).code, 'invalid_block');

  const follow = await manualSign({
    mode: 'notification',
    query: [
      ['to', owner],
      ['block', target],
      ['interaction', target],
      ['kind', 'follow'],
    ],
    app: 'tests',
  });
  assert.deepEqual(validateBlockDetailed(follow), { valid: true });

  const followWithDistinctTarget = await manualSign({
    mode: 'notification',
    query: [
      ['to', owner],
      ['block', target],
      ['interaction', interaction],
      ['kind', 'follow'],
    ],
    app: 'tests',
  });
  assert.equal(validateBlockDetailed(followWithDistinctTarget).code, 'invalid_block');

  const withContent = await manualSign({
    mode: 'notification',
    query: [
      ['to', owner],
      ['block', target],
      ['interaction', interaction],
      ['kind', 'comment'],
    ],
    content: 'texto arbitrário',
    app: 'tests',
  });
  assert.equal(validateBlockDetailed(withContent).code, 'invalid_block');

  const sameTarget = await manualSign({
    mode: 'notification',
    query: [
      ['to', owner],
      ['block', target],
      ['interaction', target],
      ['kind', 'like'],
    ],
    app: 'tests',
  });
  assert.equal(validateBlockDetailed(sameTarget).code, 'invalid_block');

  const extra = await manualSign({
    mode: 'notification',
    query: [
      ['to', owner],
      ['block', target],
      ['interaction', interaction],
      ['kind', 'like'],
      ['topic', 'x'],
    ],
    app: 'tests',
  });
  assert.equal(validateBlockDetailed(extra).code, 'invalid_query');
});

test('notification accepts repost as an interaction kind', async () => {
  const block = await manualSign({
    mode: 'notification',
    query: [
      ['to', onpostt.generateKeys().publicKey],
      ['block', 'a'.repeat(64)],
      ['interaction', 'b'.repeat(64)],
      ['kind', 'repost'],
    ],
    app: 'tests',
  });

  assert.deepEqual(validateBlockDetailed(block), { valid: true });
});

test('notification_read requires a non-empty list of valid notification ids', async () => {
  const valid = await manualSign({
    mode: 'notification_read',
    query: [],
    content: { read: ['a'.repeat(64), 'b'.repeat(64)] },
    app: 'tests',
  });
  assert.deepEqual(validateBlockDetailed(valid), { valid: true });

  const missing = await manualSign({
    mode: 'notification_read',
    query: [],
    content: { read: [] },
    app: 'tests',
  });
  assert.equal(validateBlockDetailed(missing).code, 'invalid_notification_read');

  const extra = await manualSign({
    mode: 'notification_read',
    query: [],
    content: { read: ['a'.repeat(64)], cursor: 1 },
    app: 'tests',
  });
  assert.equal(validateBlockDetailed(extra).code, 'invalid_notification_read');

  const duplicate = await manualSign({
    mode: 'notification_read',
    query: [],
    content: { read: ['a'.repeat(64), 'A'.repeat(64)] },
    app: 'tests',
  });
  assert.equal(validateBlockDetailed(duplicate).code, 'invalid_notification_read');

  const invalid = await manualSign({
    mode: 'notification_read',
    query: [],
    content: { read: ['não-é-id'] },
    app: 'tests',
  });
  assert.equal(validateBlockDetailed(invalid).code, 'invalid_notification_read');

  const withQuery = await manualSign({
    mode: 'notification_read',
    query: [['to', keys.publicKey]],
    content: { read: ['a'.repeat(64)] },
    app: 'tests',
  });
  assert.equal(validateBlockDetailed(withQuery).code, 'invalid_query');
});

test('message_read requires a non-empty list of valid message ids', async () => {
  const valid = await manualSign({
    mode: 'message_read',
    query: [],
    content: { read: ['a'.repeat(64), 'b'.repeat(64)] },
    app: 'tests',
  });
  assert.deepEqual(validateBlockDetailed(valid), { valid: true });

  const missing = await manualSign({
    mode: 'message_read',
    query: [],
    content: { read: [] },
    app: 'tests',
  });
  assert.equal(validateBlockDetailed(missing).code, 'invalid_message_read');

  const extra = await manualSign({
    mode: 'message_read',
    query: [],
    content: { read: ['a'.repeat(64)], cursor: 1 },
    app: 'tests',
  });
  assert.equal(validateBlockDetailed(extra).code, 'invalid_message_read');

  const duplicate = await manualSign({
    mode: 'message_read',
    query: [],
    content: { read: ['a'.repeat(64), 'A'.repeat(64)] },
    app: 'tests',
  });
  assert.equal(validateBlockDetailed(duplicate).code, 'invalid_message_read');

  const invalid = await manualSign({
    mode: 'message_read',
    query: [],
    content: { read: ['não-é-id'] },
    app: 'tests',
  });
  assert.equal(validateBlockDetailed(invalid).code, 'invalid_message_read');

  const withQuery = await manualSign({
    mode: 'message_read',
    query: [['to', keys.publicKey]],
    content: { read: ['a'.repeat(64)] },
    app: 'tests',
  });
  assert.equal(validateBlockDetailed(withQuery).code, 'invalid_query');
});

test('notification filters compare recipient pubkeys case-insensitively', () => {
  const filter = {
    mode: 'notification',
    query: [['to', keys.publicKey.toUpperCase()]],
  };
  const block = {
    mode: 'notification',
    pubkey: keys.publicKey,
    query: [
      ['to', keys.publicKey.toLowerCase()],
      ['block', 'a'.repeat(64)],
      ['interaction', 'b'.repeat(64)],
      ['kind', 'like'],
    ],
  };

  assert.equal(blockMatchesFilter(block, filter), true);
  assert.equal(
    blockMatchesFilter(block, {
      mode: 'notification',
      query: [['to', onpostt.generateKeys().publicKey]],
    }),
    false
  );
});

test('content is required for post, profile, comment and message', async () => {
  for (const mode of ['post', 'profile', 'comment', 'notification_read', 'message_read']) {
    const block = await manualSign({
      mode,
      query: mode === 'comment' ? [['block', 'a'.repeat(64)]] : [],
      app: 'tests',
    });
    assert.equal(validateBlockDetailed(block).error, 'Campo "content" ausente.', mode);
  }
});

test('privatekey is forbidden in blocks and query pairs', async () => {
  const topLevel = await manualSign({
    mode: 'post',
    query: [],
    content: 'x',
    app: 'tests',
    privatekey: keys.privateKey,
  });
  const topResult = validateBlockDetailed(topLevel);
  assert.equal(topResult.valid, false);
  assert.match(topResult.error, /reservado/);

  const inQuery = await manualSign({
    mode: 'post',
    query: [['privatekey', keys.privateKey]],
    content: 'x',
    app: 'tests',
  });
  assert.equal(validateBlockDetailed(inQuery).code, 'invalid_query');
  assert.match(validateQuery([['privatekey', keys.privateKey]], 'post').error, /reservada/);
});

test('duplicate query keys and invalid query pairs are rejected', async () => {
  const block = await manualSign({
    mode: 'post',
    query: [
      ['topic', 'a'],
      ['topic', 'b'],
    ],
    content: 'x',
    app: 'tests',
  });
  assert.equal(validateBlockDetailed(block).code, 'invalid_query');

  const nested = await manualSign({
    mode: 'post',
    query: [['topic', { nested: true }]],
    content: 'x',
    app: 'tests',
  });
  assert.equal(validateBlockDetailed(nested).code, 'invalid_query');
});

test('future timestamps are rejected', async () => {
  const block = await manualSign({
    mode: 'post',
    query: [],
    content: 'futuro',
    app: 'tests',
    created_at: now() + 86400,
  });

  assert.equal(validateBlockDetailed(block).code, 'invalid_timestamp');
});

test('encrypted content validator rejects malformed envelopes', () => {
  assert.match(validateEncryptedContent({ forRecipient: {} }), /ciphertext/);
  assert.match(validateEncryptedContent('nao-json'), /JSON/);
  assert.equal(validateEncryptedContent({}), 'Mensagem deve conter forRecipient e/ou forSender.');
});

test('post images validate bytes, base64, dimensions and size', async () => {
  const valid = await imageBlock(PNG_1X1, { text: 'foto' });
  assert.deepEqual(validateBlockDetailed(valid), { valid: true });

  const declaredImage = await manualSign({
    mode: 'post',
    query: [],
    app: 'tests',
    content: {
      text: 'foto',
      image: {
        mime: 'image/png',
        data: PNG_1X1.toString('base64'),
        width: 1,
        height: 1,
      },
    },
  });
  assert.deepEqual(validateBlockDetailed(declaredImage), { valid: true });

  const wrongMime = await imageBlock(PNG_1X1, { mime: 'image/jpeg' });
  assert.equal(validateBlockDetailed(wrongMime).code, 'invalid_image');

  const forgedDimensions = await imageBlock(PNG_1X1, { width: 2, height: 2 });
  assert.equal(validateBlockDetailed(forgedDimensions).code, 'invalid_image_dimensions');

  const tooWide = await imageBlock(pngWithDimensions(501, 1), { width: 1, height: 1 });
  assert.equal(validateBlockDetailed(tooWide).code, 'invalid_image_dimensions');

  const invalidBase64Signed = await manualSign({
    mode: 'post',
    query: [],
    app: 'tests',
    content: {
      image: {
        mime: 'image/png',
        data: '%%%',
        width: 1,
        height: 1,
      },
    },
  });
  assert.equal(validateBlockDetailed(invalidBase64Signed).code, 'invalid_image');
});

test('oversized image payload is rejected before decoding', async () => {
  const data = Buffer.alloc(73 * 1024);
  const block = await imageBlock(data, { width: 1, height: 1 });
  assert.equal(validateBlockDetailed(block).code, 'image_too_large');
});

test('profile images accept name, bio and image but reject extra fields', async () => {
  const image = {
    mime: 'image/png',
    data: PNG_1X1.toString('base64'),
    width: 1,
    height: 1,
  };

  const valid = await manualSign({
    mode: 'profile',
    query: [],
    app: 'tests',
    content: { name: 'Ana', bio: 'Olá', image },
  });
  assert.deepEqual(validateBlockDetailed(valid), { valid: true });

  const extra = await manualSign({
    mode: 'profile',
    query: [],
    app: 'tests',
    content: { name: 'Ana', bio: 'Olá', image, extra: 'x' },
  });
  assert.equal(validateBlockDetailed(extra).code, 'invalid_profile');

  const badName = await manualSign({
    mode: 'profile',
    query: [],
    app: 'tests',
    content: { name: 123, bio: 'Olá', image },
  });
  assert.equal(validateBlockDetailed(badName).code, 'invalid_profile');

  const forgedDimensions = await manualSign({
    mode: 'profile',
    query: [],
    app: 'tests',
    content: { name: 'Ana', bio: 'Olá', image: { ...image, width: 2, height: 2 } },
  });
  assert.equal(validateBlockDetailed(forgedDimensions).code, 'invalid_image_dimensions');
});

test('live filter matching understands message participants', async () => {
  const peer = onpostt.generateKeys().publicKey;
  const timestamp = now();

  const block = await onpostt.signBlock(
    {
      mode: 'message',
      query: [
        ['from', keys.publicKey],
        ['to', peer],
      ],
      content: 'oi',
      app: 'tests',
    },
    keys.privateKey
  );

  assert.equal(
    blockMatchesFilter(block, { mode: 'message', pubkey: peer }),
    true
  );
  assert.equal(
    blockMatchesFilter(block, { mode: 'message', pubkey: onpostt.generateKeys().publicKey }),
    false
  );
  assert.equal(
    blockMatchesFilter(block, {
      mode: 'message',
      query: [
        ['from', keys.publicKey],
        ['to', peer],
      ],
      since: timestamp - 10,
    }),
    true
  );
});

test('post topics accept canonical slugs and reject unsafe values', async () => {
  const valid = await manualSign({
    mode: 'post',
    query: [],
    content: { text: 'tópicos', topics: ['onpostt', 'seguranca'] },
    app: 'tests',
  });
  assert.deepEqual(validateBlockDetailed(valid), { valid: true });

  const invalidCases = [
    { topics: 'onpostt' },
    { topics: [] },
    { topics: ['OnPostt'] },
    { topics: ['onpostt', 'onpostt'] },
    { topics: ['a'.repeat(51)] },
    { topics: ['com espaço'] },
    { topics: ['a', 'b', 'c', 'd', 'e', 'f'] },
    { topics: ['ok', 'com\u0000controle'] },
  ];

  for (const content of invalidCases) {
    const block = await manualSign({
      mode: 'post',
      query: [],
      content: { text: 'x', ...content },
      app: 'tests',
    });
    assert.equal(validateBlockDetailed(block).code, 'invalid_topics');
  }
});

test('post image content can carry topics', async () => {
  const block = await manualSign({
    mode: 'post',
    query: [],
    content: {
      text: 'foto com tópico',
      topics: ['fotografia'],
      image: {
        mime: 'image/png',
        data: PNG_1X1.toString('base64'),
        width: 1,
        height: 1,
      },
    },
    app: 'tests',
  });

  assert.deepEqual(validateBlockDetailed(block), { valid: true });
});

test('live filter matching understands content topics and legacy query topics', () => {
  const contentBlock = {
    mode: 'post',
    pubkey: keys.publicKey,
    query: [],
    content: { topics: ['onpostt', 'dev'] },
  };
  const legacyBlock = {
    mode: 'post',
    pubkey: keys.publicKey,
    query: [['topic', 'boas-vindas']],
    content: 'olá',
  };

  assert.equal(blockMatchesFilter(contentBlock, { mode: 'post', topic: 'onpostt' }), true);
  assert.equal(blockMatchesFilter(contentBlock, { mode: 'post', topic: 'dev' }), true);
  assert.equal(blockMatchesFilter(contentBlock, { mode: 'post', topic: 'outro' }), false);
  assert.equal(blockMatchesFilter(legacyBlock, { mode: 'post', topic: 'boas-vindas' }), true);
  assert.equal(blockMatchesFilter(legacyBlock, { mode: 'comment', topic: 'boas-vindas' }), false);
  assert.equal(
    blockMatchesFilter(contentBlock, {
      mode: 'post',
      query: [['topic', 'onpostt']],
    }),
    false,
    'query.topic continua sendo um filtro independente do content.topics'
  );
});
