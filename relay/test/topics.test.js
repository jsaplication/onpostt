'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  MAX_TOPICS_PER_POST,
  normalizeTopic,
  isValidTopic,
  validateTopics,
  topicsFromBlock,
} = require('../src/topics');

test('normalizeTopic produces canonical lowercase slugs', () => {
  assert.equal(normalizeTopic('#OnPostt'), 'onpostt');
  assert.equal(normalizeTopic('  São Paulo  '), 'sao-paulo');
  assert.equal(normalizeTopic('node.js'), 'node.js');
  assert.equal(normalizeTopic('a'.repeat(60)), 'a'.repeat(50));
  assert.equal(normalizeTopic('---'), '');
  assert.equal(normalizeTopic('ok\u0000x'), '');
  assert.equal(normalizeTopic(null), '');
});

test('isValidTopic only accepts the canonical wire format', () => {
  assert.equal(isValidTopic('onpostt'), true);
  assert.equal(isValidTopic('a'), true);
  assert.equal(isValidTopic('node.js'), true);
  assert.equal(isValidTopic('OnPostt'), false);
  assert.equal(isValidTopic('com espaço'), false);
  assert.equal(isValidTopic(''), false);
  assert.equal(isValidTopic('a'.repeat(51)), false);
});

test('validateTopics enforces count, uniqueness and canonical values', () => {
  assert.deepEqual(validateTopics(['onpostt', 'dev']), {
    valid: true,
    topics: ['onpostt', 'dev'],
  });

  assert.equal(validateTopics('onpostt').valid, false);
  assert.equal(validateTopics([]).valid, false);
  assert.equal(validateTopics(['onpostt', 'onpostt']).valid, false);
  assert.equal(validateTopics(['OnPostt']).valid, false);
  assert.equal(
    validateTopics(Array.from({ length: MAX_TOPICS_PER_POST + 1 }, (_, i) => `t${i}`)).valid,
    false
  );
});

test('topicsFromBlock supports content.topics and legacy query.topic', () => {
  assert.deepEqual(
    topicsFromBlock({
      mode: 'post',
      content: { text: 'x', topics: ['onpostt', 'dev', 'OnPostt'] },
      query: [],
    }),
    ['onpostt', 'dev']
  );

  assert.deepEqual(
    topicsFromBlock({
      mode: 'post',
      content: 'texto',
      query: [
        ['topic', 'Boas-Vindas'],
        ['lang', 'pt-BR'],
      ],
    }),
    ['boas-vindas']
  );

  assert.deepEqual(
    topicsFromBlock({
      mode: 'comment',
      content: { topics: ['onpostt'] },
      query: [['topic', 'onpostt']],
    }),
    []
  );
});
