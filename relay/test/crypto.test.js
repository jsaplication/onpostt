'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const {
  ec,
  sha256,
  verifySignature,
  computeBlockId,
  isValidPublicKey,
  isValidSignature,
  isValidBlockId,
} = require('../src/crypto');

function makeKey() {
  const pair = ec.genKeyPair();
  return {
    privateKey: pair.getPrivate('hex').padStart(64, '0'),
    publicKey: pair.getPublic(true, 'hex'),
  };
}

test('sha256 known vector', () => {
  assert.equal(
    sha256('abc'),
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
  );
});

test('verifySignature accepts a valid DER signature and rejects tampering', () => {
  const { privateKey, publicKey } = makeKey();
  const message = JSON.stringify({ hello: 'onpostt' });
  const signature = ec.keyFromPrivate(privateKey, 'hex').sign(sha256(message)).toDER('hex');

  const otherSignature = ec.keyFromPrivate(privateKey, 'hex').sign(sha256('outra mensagem')).toDER('hex');

  assert.equal(verifySignature(publicKey, message, signature), true);
  assert.equal(verifySignature(publicKey, message + 'x', signature), false);
  assert.equal(verifySignature(publicKey, message, otherSignature), false);
  assert.equal(verifySignature(publicKey, message, '00'), false);
});

test('computeBlockId ignores id and sig and preserves order', () => {
  const block = {
    pubkey: '02' + '11'.repeat(32),
    created_at: 1700000000,
    mode: 'post',
    query: [['topic', 'test']],
    content: 'hello',
    app: 'tests',
  };
  const id = computeBlockId(block);
  assert.match(id, /^[0-9a-f]{64}$/);
  assert.equal(computeBlockId({ ...block, id, sig: 'ff' }), id);
  assert.notEqual(computeBlockId({ ...block, content: 'hello!' }), id);
});

test('key, signature and id format validation', () => {
  const { publicKey } = makeKey();
  const sig = ec.keyFromPrivate(sha256('x'), 'hex').sign(sha256('msg')).toDER('hex');

  assert.equal(isValidPublicKey(publicKey), true);
  assert.equal(isValidPublicKey(publicKey.slice(0, -2)), false);
  assert.equal(isValidPublicKey('nao-e-chave'), false);
  assert.equal(isValidSignature(sig), true);
  assert.equal(isValidSignature('zz'), false);
  assert.equal(isValidBlockId('a'.repeat(64)), true);
  assert.equal(isValidBlockId('a'.repeat(63)), false);
  assert.equal(isValidBlockId('g'.repeat(64)), false);
});

test('sha256 is deterministic against node crypto', () => {
  const value = 'onpostt-'.repeat(100);
  const expected = crypto.createHash('sha256').update(value, 'utf8').digest('hex');
  assert.equal(sha256(value), expected);
});
