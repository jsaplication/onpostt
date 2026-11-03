'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const config = require('../src/config');
const { normalizeFilter, buildBlocksQuery } = require('../src/query');
const { ValidationError } = require('../src/errors');
const { ec } = require('../src/crypto');

const PUBKEY = ec.genKeyPair().getPublic(true, 'hex');
const OTHER_PUBKEY = ec.genKeyPair().getPublic(true, 'hex');

function assertCode(fn, code) {
  assert.throws(fn, (error) => {
    assert.ok(error instanceof ValidationError, 'esperava ValidationError');
    assert.equal(error.code, code);
    return true;
  });
}

test('normalizeFilter rejects non-object input', () => {
  for (const value of [null, 'x', 1, [], true]) {
    assertCode(() => normalizeFilter(value), 'invalid_filter');
  }
});

test('normalizeFilter never accepts privatekey', () => {
  assertCode(
    () =>
      normalizeFilter({
        mode: 'post',
        privatekey: 'a'.repeat(64),
      }),
    'private_key_forbidden'
  );
  assertCode(
    () =>
      normalizeFilter({
        mode: 'post',
        query: [['privatekey', 'a'.repeat(64)]],
      }),
    'private_key_forbidden'
  );
  assertCode(
    () =>
      normalizeFilter({
        mode: 'post',
        PrivateKey: 'a'.repeat(64),
      }),
    'private_key_forbidden'
  );
});

test('normalizeFilter rejects unknown fields', () => {
  assertCode(() => normalizeFilter({ mode: 'post', sql: '1=1' }), 'invalid_filter');
});

test('normalizeFilter requires a supported mode', () => {
  assertCode(() => normalizeFilter({}), 'invalid_mode');
  assertCode(() => normalizeFilter({ mode: 'invented' }), 'invalid_mode');
});

test('normalizeFilter validates pubkey, id, app, since and until', () => {
  assertCode(() => normalizeFilter({ mode: 'post', pubkey: 'nao-e-chave' }), 'invalid_filter');
  assertCode(() => normalizeFilter({ mode: 'post', id: 'a'.repeat(63) }), 'invalid_filter');
  assertCode(() => normalizeFilter({ mode: 'post', app: '' }), 'invalid_filter');
  assertCode(() => normalizeFilter({ mode: 'post', app: 'x\u0000y' }), 'invalid_filter');
  assertCode(() => normalizeFilter({ mode: 'post', since: -1 }), 'invalid_filter');
  assertCode(() => normalizeFilter({ mode: 'post', until: 1.5 }), 'invalid_filter');
  assertCode(
    () => normalizeFilter({ mode: 'post', since: 200, until: 100 }),
    'invalid_filter'
  );
});

test('normalizeFilter enforces pagination limits', () => {
  assertCode(() => normalizeFilter({ mode: 'post', limit: 0 }), 'invalid_filter');
  assertCode(
    () =>
      normalizeFilter({
        mode: 'post',
        limit: config.limits.maxBlocksPerRequest + 1,
      }),
    'invalid_filter'
  );
  assertCode(() => normalizeFilter({ mode: 'post', offset: 1000001 }), 'invalid_filter');
});

test('normalizeFilter validates query pairs', () => {
  assertCode(() => normalizeFilter({ mode: 'post', query: 'x' }), 'invalid_filter');
  assertCode(() => normalizeFilter({ mode: 'post', query: [['a']] }), 'invalid_filter');
  assertCode(
    () => normalizeFilter({ mode: 'post', query: [['__proto__', 'x']] }),
    'invalid_filter'
  );
  assertCode(
    () =>
      normalizeFilter({
        mode: 'post',
        query: [
          ['topic', 'a'],
          ['topic', 'b'],
        ],
      }),
    'invalid_filter'
  );
});

test('message filters require a restriction', () => {
  assertCode(() => normalizeFilter({ mode: 'message' }), 'invalid_filter');

  const byPubkey = normalizeFilter({ mode: 'message', pubkey: PUBKEY });
  assert.equal(byPubkey.pubkey, PUBKEY);

  const byConversation = normalizeFilter({
    mode: 'message',
    query: [
      ['from', PUBKEY],
      ['to', OTHER_PUBKEY],
    ],
  });
  assert.deepEqual(byConversation.query, [
    ['from', PUBKEY],
    ['to', OTHER_PUBKEY],
  ]);
});

test('buildBlocksQuery parameterizes values and adds tombstones', () => {
  const injection = "x' OR 1=1 --";
  const { text, params, filter } = buildBlocksQuery({
    mode: 'post',
    app: injection,
    since: 10,
    until: 20,
    limit: 5,
    offset: 2,
  });

  assert.equal(filter.mode, 'post');
  assert.equal(params[0], 'post');
  assert.equal(params[1], injection);
  assert.ok(params.includes(10));
  assert.ok(params.includes(20));
  assert.ok(params.includes(5));
  assert.ok(params.includes(2));

  assert.ok(!text.includes(injection), 'valor não deve ser interpolado no SQL');
  assert.match(text, /\$1/);
  assert.match(text, /b\.created_at >= \$/);
  assert.match(text, /NOT EXISTS/);
  assert.match(text, /d\.mode = 'delete'/);
  assert.match(text, /jsonb_build_array\(\s*jsonb_build_array\(/, 'tombstone deve conter um par [block, id]');
  assert.match(text, /LIMIT \$/);
  assert.match(text, /OFFSET \$/);
});

test('message conversation query de-duplicates _rcp copies only without pubkey', () => {
  const conversation = buildBlocksQuery({
    mode: 'message',
    query: [
      ['from', PUBKEY],
      ['to', OTHER_PUBKEY],
    ],
  });

  assert.match(conversation.text, /lower\(b\."from"\) = lower\(\$/);
  assert.match(conversation.text, /lower\(b\."to"\) = lower\(\$/);
  assert.match(conversation.text, /lower\(b\.pubkey\) = lower\(\$/);
  assert.ok(conversation.params.includes(PUBKEY));
  assert.ok(conversation.params.includes(OTHER_PUBKEY));

  const byPubkey = buildBlocksQuery({
    mode: 'message',
    pubkey: OTHER_PUBKEY,
    query: [
      ['from', PUBKEY],
      ['to', OTHER_PUBKEY],
    ],
  });

  // Com pubkey explícita não adicionamos o filtro extra de autor.
  const pubkeyFilters = (byPubkey.text.match(/lower\(b\.pubkey\) = lower\(\$/g) || []).length;
  assert.equal(pubkeyFilters, 1);
});

test('reaction filters parameterize the target and emoji', () => {
  const target = 'a'.repeat(64);
  const { text, params, filter } = buildBlocksQuery({
    mode: 'reaction',
    app: 'tests',
    query: [
      ['block', target],
      ['reaction', '🔥'],
    ],
    limit: 10,
  });

  assert.equal(filter.mode, 'reaction');
  assert.deepEqual(filter.query, [
    ['block', target],
    ['reaction', '🔥'],
  ]);
  assert.ok(params.includes(JSON.stringify([['block', target]])));
  assert.ok(params.includes(JSON.stringify([['reaction', '🔥']])));
  assert.match(text, /b\.query @> \$/);
});

test('repost filters parameterize the target block', () => {
  const target = 'a'.repeat(64);
  const { text, params, filter } = buildBlocksQuery({
    mode: 'repost',
    app: 'tests',
    query: [['block', target]],
    limit: 10,
  });

  assert.equal(filter.mode, 'repost');
  assert.deepEqual(filter.query, [['block', target]]);
  assert.ok(params.includes(JSON.stringify([['block', target]])));
  assert.match(text, /b\.query @> \$/);
});

test('profile query returns the latest profile per lower-case pubkey', () => {
  const { text } = buildBlocksQuery({ mode: 'profile', pubkey: PUBKEY });
  assert.match(text, /DISTINCT ON \(lower\(b\.pubkey\)\)/);
  assert.match(text, /ORDER BY lower\(b\.pubkey\), b\.created_at DESC/);
  assert.match(text, /ORDER BY latest\.created_at DESC/);
});

test('notification filters require a recipient and validate interaction fields', () => {
  assertCode(() => normalizeFilter({ mode: 'notification' }), 'invalid_filter');
  assertCode(
    () => normalizeFilter({ mode: 'notification', query: [['to', 'invalida']] }),
    'invalid_filter'
  );
  assertCode(
    () =>
      normalizeFilter({
        mode: 'notification',
        query: [
          ['to', PUBKEY],
          ['block', 'a'.repeat(63)],
        ],
      }),
    'invalid_filter'
  );
  assertCode(
    () =>
      normalizeFilter({
        mode: 'notification',
        query: [
          ['to', PUBKEY],
          ['interaction', 'a'.repeat(63)],
        ],
      }),
    'invalid_filter'
  );
  assertCode(
    () =>
      normalizeFilter({
        mode: 'notification',
        query: [
          ['to', PUBKEY],
          ['kind', 'mention'],
        ],
      }),
    'invalid_filter'
  );

  const follow = normalizeFilter({
    mode: 'notification',
    query: [
      ['to', PUBKEY],
      ['kind', 'follow'],
    ],
  });
  assert.deepEqual(follow.query[1], ['kind', 'follow']);

  const byId = normalizeFilter({ mode: 'notification', id: 'a'.repeat(64) });
  assert.equal(byId.id, 'a'.repeat(64));

  const repost = normalizeFilter({
    mode: 'notification',
    query: [
      ['to', PUBKEY],
      ['kind', 'repost'],
    ],
  });
  assert.deepEqual(repost.query[1], ['kind', 'repost']);
});

test('notification_read filters require a pubkey or id', () => {
  assertCode(() => normalizeFilter({ mode: 'notification_read' }), 'invalid_filter');

  const byPubkey = buildBlocksQuery({ mode: 'notification_read', pubkey: PUBKEY });
  assert.equal(byPubkey.filter.pubkey, PUBKEY);
  assert.match(byPubkey.text, /lower\(b\.pubkey\) = lower\(\$/);
  assert.match(byPubkey.text, /b\.mode = \$/);

  const byId = normalizeFilter({ mode: 'notification_read', id: 'a'.repeat(64) });
  assert.equal(byId.id, 'a'.repeat(64));
});

test('message_read filters require a pubkey or id', () => {
  assertCode(() => normalizeFilter({ mode: 'message_read' }), 'invalid_filter');

  const byPubkey = buildBlocksQuery({ mode: 'message_read', pubkey: PUBKEY });
  assert.equal(byPubkey.filter.pubkey, PUBKEY);
  assert.match(byPubkey.text, /lower\(b\.pubkey\) = lower\(\$/);
  assert.match(byPubkey.text, /b\.mode = \$/);

  const byId = normalizeFilter({ mode: 'message_read', id: 'a'.repeat(64) });
  assert.equal(byId.id, 'a'.repeat(64));
});

test('notification query uses lower-case recipient and hides stale interactions', () => {
  const target = 'a'.repeat(64);
  const interaction = 'b'.repeat(64);
  const { text, params } = buildBlocksQuery({
    mode: 'notification',
    app: 'tests',
    query: [
      ['to', OTHER_PUBKEY],
      ['block', target],
      ['interaction', interaction],
      ['kind', 'comment'],
    ],
  });

  assert.ok(params.includes(OTHER_PUBKEY));
  assert.ok(params.includes(JSON.stringify([['block', target]])));
  assert.ok(params.includes(JSON.stringify([['interaction', interaction]])));
  assert.ok(params.includes(JSON.stringify([['kind', 'comment']])));
  assert.match(text, /jsonb_array_elements\(b\.query\)/);
  assert.match(text, /strict \$\[\*\] \? \(@\[0\] == "interaction"\)/);
  assert.match(text, /strict \$\[\*\] \? \(@\[0\] == "kind"\)/);
  assert.match(text, /di\.mode = 'delete'/);
  assert.match(text, /t\.id =/);
  assert.match(text, /lower\(t\.pubkey\) = lower\(/);
  assert.match(text, /i\.mode IN \('like', 'reaction', 'comment', 'repost'\)/);
});

test('follow notifications use the follow block as both target and interaction', () => {
  const followId = 'a'.repeat(64);
  const { text, params } = buildBlocksQuery({
    mode: 'notification',
    app: 'tests',
    query: [
      ['to', OTHER_PUBKEY],
      ['block', followId],
      ['interaction', followId],
      ['kind', 'follow'],
    ],
  });

  assert.ok(params.includes(JSON.stringify([['block', followId]])));
  assert.ok(params.includes(JSON.stringify([['interaction', followId]])));
  assert.match(text, /i\.mode = 'follow'/);
  assert.match(text, /strict \$\[\*\] \? \(@\[0\] == "following"\)/);
  assert.match(text, /t\.mode = 'follow'/);
  assert.match(text, /lower\(t\.pubkey\) = lower\(b\.pubkey\)/);
});

test('block filters accept blocker and blocked pairs', () => {
  const { text, params } = buildBlocksQuery({
    mode: 'block',
    app: 'tests',
    query: [
      ['blocker', PUBKEY],
      ['blocked', OTHER_PUBKEY],
    ],
  });

  assert.ok(params.includes(JSON.stringify([['blocker', PUBKEY]])));
  assert.ok(params.includes(JSON.stringify([['blocked', OTHER_PUBKEY]])));
  assert.match(text, /b\.query @> \$\d+::jsonb/);
});

test('since and until are optional and omitted when absent', () => {
  const { text } = buildBlocksQuery({ mode: 'post' });
  assert.ok(!text.includes('b.created_at >='));
  assert.ok(!text.includes('b.created_at <='));
});

test('topic filters normalize input and parameterize both storage formats', () => {
  const normalized = normalizeFilter({ mode: 'post', topic: '#São Paulo' });
  assert.equal(normalized.topic, 'sao-paulo');

  const { text, params, filter } = buildBlocksQuery({
    mode: 'post',
    topic: '#OnPostt',
    limit: 5,
  });

  assert.equal(filter.topic, 'onpostt');
  assert.ok(params.includes('onpostt'));
  assert.ok(params.includes(JSON.stringify([['topic', 'onpostt']])));
  assert.match(text, /b\.content->'topics' @> jsonb_build_array\(\$\d+::text\)/);
  assert.match(text, /b\.query @> \$\d+::jsonb/);
  assert.ok(!text.includes('onpostt'));
});

test('topic filters reject invalid values and non-post modes', () => {
  assertCode(() => normalizeFilter({ mode: 'post', topic: '' }), 'invalid_filter');
  assertCode(() => normalizeFilter({ mode: 'post', topic: '---' }), 'invalid_filter');
  assertCode(() => normalizeFilter({ mode: 'post', topic: 'ok\u0000x' }), 'invalid_filter');
  assertCode(() => normalizeFilter({ mode: 'comment', topic: 'onpostt' }), 'invalid_filter');
});

test('authenticated reads hide both directions of a block', () => {
  const { text, params } = buildBlocksQuery({ mode: 'post' }, OTHER_PUBKEY);

  assert.match(text, /NOT EXISTS \(/);
  assert.match(text, /rel\.mode = 'block'/);
  assert.match(text, /lower\(rel\.pubkey\)/);
  assert.match(text, /@\[0\] == "blocked"/);
  assert.ok(params.includes(OTHER_PUBKEY.toLowerCase()));
});

test('anonymous reads hide both sides of an active block', () => {
  const { text } = buildBlocksQuery({ mode: 'profile' });

  assert.match(text, /rel\.mode = 'block'/);
  assert.match(text, /lower\(rel\.pubkey\) = lower\(b\.pubkey\)/);
  assert.match(text, /@\[0\] == "blocked"/);
  assert.match(text, /"blocked"[\s\S]*->> 1\) = lower\(b\.pubkey\)/);
});

test('anonymous message reads hide both participants of an active block', () => {
  const { text } = buildBlocksQuery({
    mode: 'message',
    query: [
      ['from', PUBKEY],
      ['to', OTHER_PUBKEY],
    ],
  });

  assert.match(text, /rel\.mode = 'block'/);
  assert.match(text, /lower\(rel\.pubkey\) IN \(lower\(b\."from"\), lower\(b\."to"\)\)/);
  assert.match(
    text,
    /"blocked"[\s\S]*->> 1\) IN \(lower\(b\."from"\), lower\(b\."to"\)\)/
  );
});

test('block metadata queries stay visible for block detection', () => {
  const { text } = buildBlocksQuery({
    mode: 'block',
    query: [
      ['blocker', PUBKEY],
      ['blocked', OTHER_PUBKEY],
    ],
  });

  assert.ok(!text.includes("rel.mode = 'block'"), 'modo block não deve se auto-filtrar');
});

test('message visibility compares both participants', () => {
  const { text, params } = buildBlocksQuery(
    {
      mode: 'message',
      query: [
        ['from', PUBKEY],
        ['to', OTHER_PUBKEY],
      ],
    },
    PUBKEY
  );

  assert.match(text, /lower\(b\."from"\)/);
  assert.match(text, /lower\(b\."to"\)/);
  assert.ok(params.includes(PUBKEY.toLowerCase()));
});

test('buildBlocksQuery rejects an invalid viewer key', () => {
  assertCode(
    () => buildBlocksQuery({ mode: 'post' }, 'nao-e-chave'),
    'invalid_reader'
  );
});
