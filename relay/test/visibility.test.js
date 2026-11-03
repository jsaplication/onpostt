'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const db = require('../src/db');
const { participantKeys, isVisibleTo } = require('../src/visibility');

const PUBKEY = '03e1feef2dacb22cd151cbbce366b7652c9ef958723e7f0680b40f480391b3e597';
const OTHER_PUBKEY = '02d8e43b5c8202285fb8764fc72e408a0e8f9006d4927e5db45f26b5ffa1febcd9';

async function withQueryStub(stub, fn) {
  const original = db.query;
  db.query = stub;
  try {
    return await fn();
  } finally {
    db.query = original;
  }
}

test('participantKeys includes both message endpoints and ignores block metadata', () => {
  assert.deepEqual(
    participantKeys({
      mode: 'message',
      pubkey: PUBKEY,
      query: [
        ['from', PUBKEY],
        ['to', OTHER_PUBKEY.toUpperCase()],
      ],
    }),
    [PUBKEY, OTHER_PUBKEY]
  );

  assert.deepEqual(participantKeys({ mode: 'block', pubkey: PUBKEY }), []);
  assert.deepEqual(participantKeys({ mode: 'post', pubkey: PUBKEY }), [PUBKEY]);
});

test('anonymous live visibility hides both sides of an active block', async () => {
  let captured;
  const visible = await withQueryStub(
    async (text, params) => {
      captured = { text, params };
      return { rowCount: 0 };
    },
    () => isVisibleTo({ mode: 'post', pubkey: PUBKEY }, null)
  );

  assert.equal(visible, true);
  assert.match(captured.text, /lower\(rel\.pubkey\) = ANY\(\$1::text\[\]\)/);
  assert.match(captured.text, /@\[0\] == "blocked"/);
  assert.match(captured.text, /"blocked"[\s\S]*->> 1\) = ANY\(\$1::text\[\]\)/);
  assert.deepEqual(captured.params, [[PUBKEY]]);
});

test('anonymous live messages hide both participants of an active block', async () => {
  let captured;
  await withQueryStub(
    async (text, params) => {
      captured = { text, params };
      return { rowCount: 0 };
    },
    () =>
      isVisibleTo(
        {
          mode: 'message',
          query: [
            ['from', PUBKEY],
            ['to', OTHER_PUBKEY],
          ],
        },
        null
      )
  );

  assert.match(captured.text, /@\[0\] == "blocked"/);
  assert.deepEqual(captured.params, [[PUBKEY, OTHER_PUBKEY]]);
});

test('authenticated live visibility compares both directions', async () => {
  let captured;
  const visible = await withQueryStub(
    async (text, params) => {
      captured = { text, params };
      return { rowCount: 0 };
    },
    () => isVisibleTo({ mode: 'post', pubkey: PUBKEY }, OTHER_PUBKEY)
  );

  assert.equal(visible, true);
  assert.match(captured.text, /lower\(rel\.pubkey\) = lower\(\$1\)/);
  assert.match(captured.text, /"blocked"[\s\S]*->> 1\) = lower\(\$1\)/);
  assert.deepEqual(captured.params, [OTHER_PUBKEY, [PUBKEY]]);
});

test('live visibility fails closed for an invalid viewer and delivers block metadata', async () => {
  assert.equal(await isVisibleTo({ mode: 'block', pubkey: PUBKEY }, null), true);
  assert.equal(await isVisibleTo({ mode: 'post', pubkey: PUBKEY }, 'invalida'), false);
});
