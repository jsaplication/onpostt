'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { parseTrendingParams, buildTrendingQuery } = require('../src/trending');
const { ValidationError } = require('../src/errors');
const {
  DEFAULT_TRENDING_LIMIT,
  DEFAULT_TRENDING_WINDOW_SECONDS,
} = require('../src/topics');

function assertCode(fn, code) {
  assert.throws(fn, (error) => {
    assert.ok(error instanceof ValidationError);
    assert.equal(error.code, code);
    return true;
  });
}

test('parseTrendingParams applies safe defaults', () => {
  assert.deepEqual(parseTrendingParams({}), {
    app: null,
    limit: DEFAULT_TRENDING_LIMIT,
    windowSeconds: DEFAULT_TRENDING_WINDOW_SECONDS,
  });

  assert.deepEqual(parseTrendingParams({ app: '  onpostt-demo  ', limit: '5', window: '3600' }), {
    app: 'onpostt-demo',
    limit: 5,
    windowSeconds: 3600,
  });

  assert.equal(parseTrendingParams({ app: '' }).app, null);
});

test('parseTrendingParams rejects out-of-range and invalid values', () => {
  assertCode(() => parseTrendingParams({ limit: '0' }), 'invalid_trending');
  assertCode(() => parseTrendingParams({ limit: '21' }), 'invalid_trending');
  assertCode(() => parseTrendingParams({ window: '3599' }), 'invalid_trending');
  assertCode(() => parseTrendingParams({ window: '2592001' }), 'invalid_trending');
  assertCode(() => parseTrendingParams({ app: 42 }), 'invalid_trending');
  assertCode(() => parseTrendingParams({ app: 'ok\u0000x' }), 'invalid_trending');
});

test('buildTrendingQuery parameterizes app, window and limit', () => {
  const { text, params, since } = buildTrendingQuery({
    app: "onpostt-demo' OR 1=1 --",
    limit: 7,
    windowSeconds: 3600,
    now: 10000,
  });

  assert.equal(since, 6400);
  assert.deepEqual(params, [6400, "onpostt-demo' OR 1=1 --", 7]);
  assert.match(text, /b\.created_at >= \$1/);
  assert.match(text, /b\.app = \$2/);
  assert.match(text, /LIMIT \$3/);
  assert.match(text, /jsonb_array_elements_text/);
  assert.match(text, /d\.mode = 'delete'/);
  assert.ok(!text.includes("OR 1=1"));
});

test('buildTrendingQuery omits app and renumbers limit when no app is supplied', () => {
  const { text, params } = buildTrendingQuery({
    app: null,
    limit: 3,
    windowSeconds: 7200,
    now: 20000,
  });

  assert.deepEqual(params, [12800, 3]);
  assert.match(text, /LIMIT \$2/);
  assert.ok(!text.includes('b.app ='));
});

test('buildTrendingQuery excludes authors participating in active blocks', () => {
  const { text } = buildTrendingQuery({
    app: null,
    limit: 3,
    windowSeconds: 7200,
    now: 20000,
  });

  assert.match(text, /rel\.mode = 'block'/);
  assert.match(text, /lower\(rel\.pubkey\) = lower\(b\.pubkey\)/);
  assert.match(text, /@\[0\] == "blocked"/);
  assert.match(text, /\) ->> 1\) = lower\(b\.pubkey\)/);
});
