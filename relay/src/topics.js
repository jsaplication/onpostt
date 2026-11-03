'use strict';

/**
 * Tópicos públicos de posts.
 *
 * Tópicos não são um modo novo: são metadados opcionais do bloco `post`.
 * O formato canônico é um array de slugs minúsculos em `content.topics`.
 * Consultas antigas que usam `query: [["topic", "slug"]]` continuam aceitas
 * como fallback de leitura.
 */

const MAX_TOPICS_PER_POST = 5;
const MAX_TOPIC_LENGTH = 50;
const MAX_TRENDING_LIMIT = 20;
const DEFAULT_TRENDING_LIMIT = 10;
const MIN_TRENDING_WINDOW_SECONDS = 60 * 60;
const MAX_TRENDING_WINDOW_SECONDS = 30 * 24 * 60 * 60;
const DEFAULT_TRENDING_WINDOW_SECONDS = 7 * 24 * 60 * 60;

const TOPIC_RE = /^[a-z0-9](?:[a-z0-9._-]{0,48}[a-z0-9])?$/;
const CONTROL_RE = /[\u0000-\u001F\u007F\u2028\u2029]/;

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Normaliza uma entrada de tópico para o slug canônico usado no relay.
 * Retorna string vazia quando não é possível produzir um slug válido.
 *
 * A mesma regra é usada no cliente. No bloco assinado, o relay não reescreve
 * conteúdo: ele só aceita slugs que já estejam canônicos.
 */
function normalizeTopic(value) {
  if (typeof value !== 'string') return '';
  if (CONTROL_RE.test(value)) return '';

  let topic = value.trim().toLowerCase();
  if (topic.charAt(0) === '#') topic = topic.slice(1);

  try {
    topic = topic.normalize('NFD').replace(/[\u0300-\u036F]/g, '');
  } catch {
    /* motores antigos sem String.normalize: segue com o texto original */
  }

  topic = topic
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[-._]+|[-._]+$/g, '');

  if (topic.length > MAX_TOPIC_LENGTH) {
    topic = topic.slice(0, MAX_TOPIC_LENGTH).replace(/[-._]+$/g, '');
  }

  return TOPIC_RE.test(topic) ? topic : '';
}

function isValidTopic(value) {
  return (
    typeof value === 'string' &&
    value.length >= 1 &&
    value.length <= MAX_TOPIC_LENGTH &&
    !CONTROL_RE.test(value) &&
    TOPIC_RE.test(value)
  );
}

/**
 * Valida o array `content.topics` de um post.
 * Retorna `{ valid: true, topics }` ou `{ valid: false, error }`.
 */
function validateTopics(value) {
  if (!Array.isArray(value)) {
    return { valid: false, error: 'Campo "topics" deve ser uma lista.' };
  }
  if (value.length === 0) {
    return { valid: false, error: 'Campo "topics" não pode ser vazio.' };
  }
  if (value.length > MAX_TOPICS_PER_POST) {
    return {
      valid: false,
      error: `Um post aceita no máximo ${MAX_TOPICS_PER_POST} tópicos.`,
    };
  }

  const topics = [];
  const seen = new Set();

  for (const topic of value) {
    if (!isValidTopic(topic)) {
      return {
        valid: false,
        error:
          `Tópico inválido. Use 1–${MAX_TOPIC_LENGTH} caracteres: ` +
          'letras minúsculas, números, ponto, hífen ou sublinhado.',
      };
    }
    if (seen.has(topic)) {
      return { valid: false, error: `Tópico duplicado: ${topic}.` };
    }
    seen.add(topic);
    topics.push(topic);
  }

  return { valid: true, topics };
}

/**
 * Extrai tópicos de um bloco de post. Inclui o formato novo
 * (`content.topics`) e o formato documentado antigo (`query.topic`).
 */
function topicsFromBlock(block) {
  if (!block || block.mode !== 'post') return [];

  const topics = [];
  const seen = new Set();

  const add = (value) => {
    const normalized = normalizeTopic(value);
    if (!normalized || seen.has(normalized)) return;
    seen.add(normalized);
    topics.push(normalized);
  };

  if (isPlainObject(block.content) && Array.isArray(block.content.topics)) {
    block.content.topics.forEach(add);
  }

  if (Array.isArray(block.query)) {
    block.query.forEach((pair) => {
      if (Array.isArray(pair) && pair[0] === 'topic') add(pair[1]);
    });
  }

  return topics;
}

module.exports = {
  MAX_TOPICS_PER_POST,
  MAX_TOPIC_LENGTH,
  MAX_TRENDING_LIMIT,
  DEFAULT_TRENDING_LIMIT,
  MIN_TRENDING_WINDOW_SECONDS,
  MAX_TRENDING_WINDOW_SECONDS,
  DEFAULT_TRENDING_WINDOW_SECONDS,
  normalizeTopic,
  isValidTopic,
  validateTopics,
  topicsFromBlock,
  isPlainObject,
};
