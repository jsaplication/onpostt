'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { capBlocks } = require('../src/getBlocks');

test('capBlocks keeps every block that fits', () => {
  const rows = [{ id: 'a' }, { id: 'b' }];
  const page = capBlocks(rows, 1024);

  assert.equal(page.blocks.length, 2);
  assert.equal(page.truncated, false);
  assert.equal(page.bytes, Buffer.byteLength(JSON.stringify(rows[0])) + 1 + Buffer.byteLength(JSON.stringify(rows[1])));
});

test('capBlocks truncates before exceeding the response budget', () => {
  const rows = [
    { id: 'a', content: 'x'.repeat(40) },
    { id: 'b', content: 'x'.repeat(40) },
    { id: 'c', content: 'x'.repeat(40) },
  ];
  const first = Buffer.byteLength(JSON.stringify(rows[0]));
  const page = capBlocks(rows, first + 1 + 10);

  assert.equal(page.blocks.length, 1);
  assert.equal(page.truncated, true);
  assert.equal(page.blocks[0].id, 'a');
});

test('capBlocks always returns at least one block, even when oversized', () => {
  const rows = [{ id: 'a', content: 'x'.repeat(1000) }, { id: 'b' }];
  const page = capBlocks(rows, 64);

  assert.equal(page.blocks.length, 1);
  assert.equal(page.truncated, true);
  assert.ok(page.bytes > 64);
});

test('capBlocks handles empty results', () => {
  assert.deepEqual(capBlocks([], 1024), { blocks: [], truncated: false, bytes: 0 });
});
