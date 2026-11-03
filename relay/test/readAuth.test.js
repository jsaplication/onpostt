'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { ec, sha256 } = require('../src/crypto');
const { parseReader, readerMessage } = require('../src/readAuth');

const now = () => Math.floor(Date.now() / 1000);

function makeKey() {
  const pair = ec.genKeyPair();
  return {
    privateKey: pair.getPrivate('hex').padStart(64, '0'),
    publicKey: pair.getPublic(true, 'hex'),
  };
}

function makeReader(privateKey, createdAt = now()) {
  const viewer = ec.keyFromPrivate(privateKey, 'hex').getPublic(true, 'hex').toLowerCase();
  const signature = ec
    .keyFromPrivate(privateKey, 'hex')
    .sign(sha256(readerMessage(viewer, createdAt)))
    .toDER('hex');
  return { viewer, created_at: createdAt, sig: signature };
}

function assertReaderCode(fn, code) {
  assert.throws(fn, (error) => {
    assert.equal(error.code, code);
    return true;
  });
}

test('parseReader accepts a valid signed token and normalizes the viewer', () => {
  const { privateKey, publicKey } = makeKey();
  const reader = makeReader(privateKey);

  assert.deepEqual(parseReader(reader), { viewer: publicKey.toLowerCase() });

  const upper = { ...reader, viewer: reader.viewer.toUpperCase() };
  assert.deepEqual(parseReader(upper), { viewer: publicKey.toLowerCase() });
});

test('parseReader treats an absent token as anonymous', () => {
  assert.deepEqual(parseReader(undefined), { viewer: null });
  assert.deepEqual(parseReader(null), { viewer: null });
});

test('parseReader rejects malformed token fields', () => {
  const { privateKey } = makeKey();
  const reader = makeReader(privateKey);

  assertReaderCode(() => parseReader('token'), 'invalid_reader');
  assertReaderCode(() => parseReader({ ...reader, extra: true }), 'invalid_reader');
  assertReaderCode(() => parseReader({ ...reader, viewer: 'invalida' }), 'invalid_reader');
  assertReaderCode(() => parseReader({ ...reader, created_at: 1.5 }), 'invalid_reader');
  assertReaderCode(() => parseReader({ ...reader, sig: '00' }), 'invalid_reader');
});

test('parseReader rejects tampered, future and expired tokens', () => {
  const { privateKey } = makeKey();
  const reader = makeReader(privateKey);
  const tampered = { ...reader, created_at: reader.created_at - 1 };

  assertReaderCode(
    () => parseReader(tampered),
    'invalid_reader_signature'
  );
  assertReaderCode(
    () => parseReader(makeReader(privateKey, now() + 86400)),
    'reader_not_yet_valid'
  );
  assertReaderCode(
    () => parseReader(makeReader(privateKey, now() - 400 * 24 * 60 * 60)),
    'reader_expired'
  );
});
