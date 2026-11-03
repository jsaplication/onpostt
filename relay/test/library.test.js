'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

globalThis.elliptic = require('elliptic');

const onpostt = require('../public/onpostt.js');

const keys = onpostt.generateKeys();
const peer = onpostt.generateKeys();
const now = () => Math.floor(Date.now() / 1000);

function sampleBlock(overrides = {}) {
  return {
    id: 'a'.repeat(64),
    pubkey: keys.publicKey,
    created_at: now(),
    mode: 'post',
    query: [],
    content: 'oi',
    app: 'tests',
    sig: 'b'.repeat(140),
    ...overrides,
  };
}

test('generateKeys returns a valid key pair', () => {
  assert.match(keys.privateKey, /^[0-9a-f]{64}$/);
  assert.equal(onpostt.isValidPrivateKey(keys.privateKey), true);
  assert.equal(onpostt.isValidPrivateKey('curta'), false);
  assert.equal(onpostt.isValidPublicKey(keys.publicKey), true);
  assert.equal(onpostt.isValidPublicKey('02' + '00'.repeat(32)), false);
  assert.equal(onpostt.generatePublicKey(keys.privateKey), keys.publicKey);
  assert.equal(onpostt.generatePublicKey('invalida'), 'Chave privada inválida.');
});

test('generateKeysCustom is deterministic and returns valid keys', async () => {
  const first = await onpostt.generateKeysCustom('onpostt-demo');
  const second = await onpostt.generateKeysCustom('onpostt-demo');
  const other = await onpostt.generateKeysCustom('outra-entrada');

  assert.deepEqual(first, second);
  assert.notDeepEqual(first, other);
  assert.equal(onpostt.isValidPrivateKey(first.privateKey), true);
  assert.equal(onpostt.isValidPublicKey(first.publicKey), true);
  await assert.rejects(() => onpostt.generateKeysCustom(''), /inválida/i);
});

test('sha256 matches the known vector', async () => {
  assert.equal(
    await onpostt.sha256('abc'),
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
  );
});

test('sanitizeFilter rejects privatekey and keeps public filters intact', () => {
  assert.throws(
    () =>
      onpostt.sanitizeFilter({
        mode: 'post',
        privatekey: keys.privateKey,
        limit: 10,
      }),
    /privatekey.*proibido/i
  );

  assert.throws(
    () =>
      onpostt.sanitizeFilter({
        mode: 'post',
        query: [['privatekey', keys.privateKey]],
      }),
    /reservada/i
  );

  const filter = onpostt.sanitizeFilter({
    mode: 'post',
    pubkey: peer.publicKey,
    limit: 10,
  });
  assert.equal(filter.privatekey, undefined);
  assert.equal(filter.pubkey, peer.publicKey);
  assert.equal(filter.limit, 10);

  assert.throws(() => onpostt.sanitizeFilter({ pubkey: keys.publicKey }), /mode/);
});

test('signBlock signs, computes the id and keeps the canonical order', async () => {
  const block = {
    mode: 'post',
    query: [['topic', 'onpostt']],
    content: 'olá',
    app: 'tests',
  };

  const signed = await onpostt.signBlock(block, keys.privateKey);

  assert.equal(signed, block, 'signBlock muta e retorna o mesmo objeto');
  assert.equal(signed.pubkey, keys.publicKey);
  assert.match(signed.id, /^[0-9a-f]{64}$/);
  assert.match(signed.sig, /^[0-9a-f]+$/);
  assert.deepEqual(Object.keys(signed).slice(0, 6), [
    'pubkey',
    'created_at',
    'mode',
    'query',
    'content',
    'app',
  ]);

  const unsigned = { ...signed };
  delete unsigned.sig;
  assert.equal(await onpostt.verifySignature(keys.publicKey, JSON.stringify(unsigned), signed.sig), true);

  unsigned.content = 'adulterado';
  assert.equal(await onpostt.verifySignature(keys.publicKey, JSON.stringify(unsigned), signed.sig), false);
});

test('reaction blocks omit content and validate the emoji', async () => {
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

  assert.equal(typeof block, 'object');
  assert.equal(Object.prototype.hasOwnProperty.call(block, 'content'), false);
  assert.equal(onpostt.isValidReaction('🔥'), true);
  assert.equal(onpostt.isValidReaction('   '), false);
  assert.equal(onpostt.isValidReaction('x'.repeat(33)), false);

  const invalid = await onpostt.signBlock(
    {
      mode: 'reaction',
      query: [
        ['block', 'a'.repeat(64)],
        ['reaction', ''],
      ],
      app: 'tests',
    },
    keys.privateKey
  );
  assert.equal(typeof invalid, 'string');
});

test('toggle blocks get a fresh nonce so repeated actions have distinct ids', async () => {
  const make = () =>
    onpostt.signBlock(
      {
        mode: 'like',
        query: [['block', 'a'.repeat(64)]],
        app: 'tests',
      },
      keys.privateKey
    );

  const first = await make();
  const second = await make();

  assert.match(first.nonce, /^[0-9a-f]{32}$/);
  assert.match(second.nonce, /^[0-9a-f]{32}$/);
  assert.notEqual(first.id, second.id);
});

test('comment blocks preserve the optional parent', async () => {
  const block = await onpostt.signBlock(
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

  assert.deepEqual(block.query, [
    ['block', 'a'.repeat(64)],
    ['parent', 'b'.repeat(64)],
  ]);
});

test('library exposes the social modes and helpers', () => {
  assert.ok(onpostt.modes_list.includes('reaction'));
  assert.ok(onpostt.modes_list.includes('comment'));
  assert.ok(onpostt.modes_list.includes('repost'));
  assert.ok(onpostt.modes_list.includes('block'));
  assert.ok(onpostt.modes_list.includes('notification'));
  assert.ok(onpostt.modes_list.includes('notification_read'));
  assert.ok(onpostt.modes_list.includes('message_read'));
  assert.equal(typeof onpostt.isValidReaction, 'function');
  assert.equal(typeof onpostt.prepareImage, 'function');
  assert.equal(typeof onpostt.setReaderKey, 'function');
  assert.equal(typeof onpostt.createReaderToken, 'function');
});

test('reader tokens are signed by the client and accepted by the relay', async () => {
  const { parseReader } = require('../src/readAuth');
  const token = await onpostt.createReaderToken(keys.privateKey);

  assert.deepEqual(parseReader(token), { viewer: keys.publicKey.toLowerCase() });

  const configured = await onpostt.setReaderKey(keys.privateKey);
  assert.deepEqual(parseReader(configured), { viewer: keys.publicKey.toLowerCase() });
  assert.equal(onpostt.getReaderToken().viewer, keys.publicKey.toLowerCase());
  onpostt.setReaderKey(null);
  assert.equal(onpostt.getReaderToken(), null);
});

test('repost blocks omit content and get a fresh nonce', async () => {
  const make = () =>
    onpostt.signBlock(
      {
        mode: 'repost',
        query: [['block', 'a'.repeat(64)]],
        app: 'tests',
      },
      keys.privateKey
    );

  const first = await make();
  const second = await make();

  assert.equal(typeof first, 'object');
  assert.equal(first.mode, 'repost');
  assert.equal(first.content, undefined);
  assert.match(first.nonce, /^[0-9a-f]{32}$/);
  assert.notEqual(first.id, second.id);
});

test('notification_read signs a list of notification ids', async () => {
  const block = await onpostt.signBlock(
    {
      mode: 'notification_read',
      query: [],
      content: { read: ['a'.repeat(64)] },
      app: 'tests',
    },
    keys.privateKey
  );

  assert.equal(typeof block, 'object');
  assert.equal(block.mode, 'notification_read');
  assert.deepEqual(block.content, { read: ['a'.repeat(64)] });

  const invalid = await onpostt.signBlock(
    {
      mode: 'notification_read',
      query: [],
      content: { read: ['não-é-id'] },
      app: 'tests',
    },
    keys.privateKey
  );
  assert.equal(typeof invalid, 'string');
});

test('message_read signs a list of message ids', async () => {
  const block = await onpostt.signBlock(
    {
      mode: 'message_read',
      query: [],
      content: { read: ['a'.repeat(64)] },
      app: 'tests',
    },
    keys.privateKey
  );

  assert.equal(typeof block, 'object');
  assert.equal(block.mode, 'message_read');
  assert.deepEqual(block.content, { read: ['a'.repeat(64)] });

  const invalid = await onpostt.signBlock(
    {
      mode: 'message_read',
      query: [],
      content: { read: ['não-é-id'] },
      app: 'tests',
    },
    keys.privateKey
  );
  assert.equal(typeof invalid, 'string');
});

test('block blocks get a fresh nonce and validate blocker/blocked', async () => {
  const make = () =>
    onpostt.signBlock(
      {
        mode: 'block',
        query: [
          ['blocker', keys.publicKey],
          ['blocked', peer.publicKey],
        ],
        app: 'tests',
      },
      keys.privateKey
    );

  const first = await make();
  const second = await make();

  assert.equal(typeof first, 'object');
  assert.equal(first.mode, 'block');
  assert.equal(first.content, undefined);
  assert.match(first.nonce, /^[0-9a-f]{32}$/);
  assert.notEqual(first.id, second.id);

  const wrongBlocker = await onpostt.signBlock(
    {
      mode: 'block',
      query: [
        ['blocker', peer.publicKey],
        ['blocked', keys.publicKey],
      ],
      app: 'tests',
    },
    keys.privateKey
  );
  assert.match(wrongBlocker, /blocker/);
});

test('library signs follow notifications without content', async () => {
  const owner = peer.publicKey;
  const follow = await onpostt.signBlock(
    {
      mode: 'follow',
      query: [
        ['follower', keys.publicKey],
        ['following', owner],
      ],
      app: 'tests',
    },
    keys.privateKey
  );
  assert.equal(typeof follow, 'object');

  const notification = await onpostt.signBlock(
    {
      mode: 'notification',
      query: [
        ['to', owner],
        ['block', follow.id],
        ['interaction', follow.id],
        ['kind', 'follow'],
      ],
      app: 'tests',
    },
    keys.privateKey
  );

  assert.equal(typeof notification, 'object');
  assert.equal(notification.mode, 'notification');
  assert.equal(notification.content, undefined);
  assert.equal(notification.query[3][1], 'follow');
});

test('library signs notifications without content', async () => {
  const owner = peer.publicKey;
  const notification = await onpostt.signBlock(
    {
      mode: 'notification',
      query: [
        ['to', owner],
        ['block', 'a'.repeat(64)],
        ['interaction', 'b'.repeat(64)],
        ['kind', 'reaction'],
      ],
      app: 'tests',
    },
    keys.privateKey
  );

  assert.equal(typeof notification, 'object');
  assert.equal(notification.mode, 'notification');
  assert.equal(notification.content, undefined);
  assert.deepEqual(notification.query, [
    ['to', owner],
    ['block', 'a'.repeat(64)],
    ['interaction', 'b'.repeat(64)],
    ['kind', 'reaction'],
  ]);
});

test('prepareImage requires a browser with canvas', async () => {
  await assert.rejects(
    onpostt.prepareImage({ type: 'image/png', size: 10 }),
    /exige um navegador/i
  );
  await assert.rejects(
    onpostt.prepareImage({ type: 'text/plain', size: 10 }),
    /JPEG ou PNG/i
  );
});

test('signBlock reports structural errors as strings', async () => {
  assert.equal(typeof (await onpostt.signBlock(null, keys.privateKey)), 'string');
  assert.equal(typeof (await onpostt.signBlock({}, 'invalida')), 'string');
  assert.match(
    await onpostt.signBlock({ mode: 'message', query: [], content: 'x' }, keys.privateKey),
    /from\/to/
  );
  assert.match(
    await onpostt.signBlock(
      {
        mode: 'message',
        query: [
          ['from', peer.publicKey],
          ['to', peer.publicKey],
        ],
        content: 'x',
      },
      keys.privateKey
    ),
    /from/
  );
  assert.match(
    await onpostt.signBlock({ mode: 'delete', query: [], content: null }, keys.privateKey),
    /block/
  );
  assert.match(
    await onpostt.signBlock(
      { mode: 'post', query: [], content: 'x', privatekey: keys.privateKey },
      keys.privateKey
    ),
    /reservado/
  );
  assert.match(
    await onpostt.signBlock(
      { mode: 'post', query: [['privatekey', keys.privateKey]], content: 'x' },
      keys.privateKey
    ),
    /reservada/
  );
});

test('message blocks are encrypted and decrypt for both participants', async () => {
  const block = await onpostt.signBlock(
    {
      mode: 'message',
      query: [
        ['from', keys.publicKey],
        ['to', peer.publicKey],
      ],
      content: 'segredo compartilhado',
      app: 'tests',
    },
    keys.privateKey
  );

  assert.equal(typeof block.content, 'string');
  const envelope = JSON.parse(block.content);
  assert.ok(envelope.forRecipient);
  assert.ok(envelope.forSender);
  assert.notEqual(block.content.includes('segredo compartilhado'), true);

  assert.equal(await onpostt.decryptMessage(peer.privateKey, block), 'segredo compartilhado');
  assert.equal(await onpostt.decryptMessage(keys.privateKey, block), 'segredo compartilhado');
  await assert.rejects(
    () => onpostt.decryptMessage(onpostt.generateKeys().privateKey, block),
    /descriptografar/
  );
});

test('encryptMessage uses a fresh ephemeral key per message', async () => {
  const first = await onpostt.encryptMessage(peer.publicKey, keys.publicKey, 'a');
  const second = await onpostt.encryptMessage(peer.publicKey, keys.publicKey, 'a');

  assert.notEqual(first.forRecipient.senderPubKey, second.forRecipient.senderPubKey);
  assert.notEqual(first.forRecipient.ciphertext, second.forRecipient.ciphertext);

  const decoded = await onpostt.decryptMessage(peer.privateKey, {
    mode: 'message',
    content: JSON.stringify(first),
  });
  assert.equal(decoded, 'a');
});

test('decryptMessages maps failures to null', async () => {
  const good = await onpostt.signBlock(
    {
      mode: 'message',
      query: [
        ['from', keys.publicKey],
        ['to', peer.publicKey],
      ],
      content: 'ok',
      app: 'tests',
    },
    keys.privateKey
  );

  const bad = { mode: 'message', content: JSON.stringify({ forRecipient: {} }) };
  const result = await onpostt.decryptMessages(peer.privateKey, [good, bad]);

  assert.deepEqual(result, ['ok', null]);
  await assert.rejects(() => onpostt.decryptMessages(peer.privateKey, null), /array/);
});

test('subscriptions deliver each block once and can be cancelled', () => {
  const received = [];
  const unsubscribe = onpostt.sub({ mode: 'post', pubkey: keys.publicKey }, (payload) => {
    received.push(payload);
  });

  try {
    const subscription = unsubscribe.subscription;
    assert.match(subscription, /^c\d+/);

    const block = sampleBlock();
    onpostt._handleMessage(
      JSON.stringify({
        response: 'blocks',
        subscription: subscription,
        blocks: [block, block],
      })
    );

    assert.equal(received.length, 1);
    assert.equal(received[0].blocks.length, 1);
    assert.equal(received[0].blocks[0].id, block.id);

    // Bloco repetido em outro evento continua deduplicado.
    onpostt._handleMessage(
      JSON.stringify({ response: 'blocks', subscription: subscription, blocks: [block] })
    );
    assert.equal(received.length, 1);

    const other = sampleBlock({ id: 'c'.repeat(64), content: 'novo' });
    onpostt._handleMessage(
      JSON.stringify({ response: 'blocks', subscription: subscription, blocks: [other] })
    );
    assert.equal(received.length, 2);
  } finally {
    assert.equal(onpostt.unsubscribe(unsubscribe), true);
    assert.equal(onpostt.unsubscribe(unsubscribe), false);
  }
});

test('subscriptions propagate truncated initial responses', () => {
  const received = [];
  const stop = onpostt.sub({ mode: 'post', pubkey: keys.publicKey }, (payload) => {
    received.push(payload);
  });

  try {
    const block = sampleBlock({ id: 'd'.repeat(64), content: 'grande' });
    onpostt._handleMessage(
      JSON.stringify({
        response: 'blocks',
        subscription: stop.subscription,
        blocks: [block],
        truncated: true,
        initial: true,
      })
    );
    assert.equal(received.length, 1);
    assert.equal(received[0].truncated, true);
  } finally {
    onpostt.unsubscribe(stop);
  }
});

test('blocks without a subscription id are ignored', () => {
  const received = [];
  const stop = onpostt.sub({ mode: 'post', pubkey: keys.publicKey }, (payload) => {
    received.push(payload);
  });

  try {
    onpostt._handleMessage(
      JSON.stringify({ response: 'blocks', blocks: [sampleBlock()] })
    );

    assert.equal(received.length, 0);
  } finally {
    stop();
  }
});

test('event emitter supports on, once and off', () => {
  let total = 0;
  let once = 0;

  const off = onpostt.on('custom', () => {
    total += 1;
  });
  onpostt.once('custom', () => {
    once += 1;
  });

  onpostt.emit('custom');
  onpostt.emit('custom');
  off();
  onpostt.emit('custom');

  assert.equal(total, 2);
  assert.equal(once, 1);
});

test('list returns an empty result without configured hosts', async () => {
  const previousHosts = onpostt.hosts;
  onpostt.hosts = [];
  try {
    const callbackPayloads = [];
    const result = await onpostt.list({ mode: 'post' }, (payload) => callbackPayloads.push(payload));
    assert.deepEqual(result, []);
    assert.equal(result.truncated, false);
    assert.deepEqual(callbackPayloads[0].blocks, []);
    assert.equal(callbackPayloads[0].response, 'blocks');
    assert.equal(callbackPayloads[0].truncated, false);
  } finally {
    onpostt.hosts = previousHosts;
  }
});

test('list propagates truncated responses on the array and callback payload', async () => {
  const previousHosts = onpostt.hosts;
  const previousFetch = globalThis.fetch;
  const block = sampleBlock({ id: 'e'.repeat(64) });
  onpostt.hosts = ['http://relay.test'];

  globalThis.fetch = async (url, options) => {
    assert.equal(url, 'http://relay.test/get_blocks_list');
    assert.equal(options.method, 'POST');
    assert.deepEqual(JSON.parse(options.body), { mode: 'post' });
    return {
      ok: true,
      status: 200,
      json: async () => ({ blocks: [block], truncated: true }),
    };
  };

  try {
    const callbackPayloads = [];
    const result = await onpostt.list({ mode: 'post' }, (payload) => callbackPayloads.push(payload));
    assert.equal(result.length, 1);
    assert.equal(result.truncated, true);
    assert.equal(callbackPayloads.length, 1);
    assert.equal(callbackPayloads[0].truncated, true);
    assert.equal(callbackPayloads[0].blocks[0].id, block.id);
  } finally {
    globalThis.fetch = previousFetch;
    onpostt.hosts = previousHosts;
  }
});
