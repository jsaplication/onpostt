'use strict';

/**
 * Ranking de tópicos em alta.
 *
 * O relay não mantém uma tabela de trending. O ranking é calculado sobre os
 * posts recentes visíveis, considerando:
 * - somente posts (`mode = 'post'`);
 * - posts com tombstone do próprio autor são excluídos;
 * - `content.topics` e o fallback legado `query.topic` contam uma vez por post;
 * - ordenação por quantidade de posts na janela e, em empate, pelo post mais
 *   recente.
 */

const config = require('./config');
const { ValidationError } = require('./errors');
const {
  DEFAULT_TRENDING_LIMIT,
  MAX_TRENDING_LIMIT,
  MIN_TRENDING_WINDOW_SECONDS,
  MAX_TRENDING_WINDOW_SECONDS,
  DEFAULT_TRENDING_WINDOW_SECONDS,
} = require('./topics');

const CONTROL_RE = /[\u0000-\u001F\u007F]/;

function integerParam(value, name, { fallback, min, max }) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = typeof value === 'number' ? value : Number(String(value).trim());
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new ValidationError(
      `Parâmetro "${name}" deve ser um inteiro entre ${min} e ${max}.`,
      { code: 'invalid_trending' }
    );
  }
  return parsed;
}

function parseTrendingParams(input = {}) {
  const appInput = input.app;
  let app = null;

  if (appInput !== undefined && appInput !== null && String(appInput).trim() !== '') {
    if (typeof appInput !== 'string') {
      throw new ValidationError('Parâmetro "app" inválido.', { code: 'invalid_trending' });
    }
    app = appInput.trim();
    if (
      app.length < 1 ||
      app.length > config.limits.maxAppLength ||
      CONTROL_RE.test(app)
    ) {
      throw new ValidationError('Parâmetro "app" inválido.', { code: 'invalid_trending' });
    }
  }

  return {
    app,
    limit: integerParam(input.limit, 'limit', {
      fallback: DEFAULT_TRENDING_LIMIT,
      min: 1,
      max: MAX_TRENDING_LIMIT,
    }),
    windowSeconds: integerParam(input.window, 'window', {
      fallback: DEFAULT_TRENDING_WINDOW_SECONDS,
      min: MIN_TRENDING_WINDOW_SECONDS,
      max: MAX_TRENDING_WINDOW_SECONDS,
    }),
  };
}

/**
 * Monta a consulta SQL do ranking. Todos os valores são parametrizados.
 * Exportado para testes unitários sem banco.
 */
function buildTrendingQuery({ app, limit, windowSeconds, now = Math.floor(Date.now() / 1000) }) {
  const since = now - windowSeconds;
  const params = [since, ...(app ? [app] : [])];
  let index = params.length + 1;

  const recentConditions = [
    "b.mode = 'post'",
    `b.created_at >= $1`,
    `NOT EXISTS (
      SELECT 1
      FROM blocks d
      WHERE d.mode = 'delete'
        AND lower(d.pubkey) = lower(b.pubkey)
        AND d.query @> jsonb_build_array(
          jsonb_build_array('block'::text, b.id)
        )
    )`,
    // O ranking é anônimo: pelo mesmo critério conservador das leituras sem
    // token, autores que participam de bloqueio ativo não entram no agregado.
    `NOT EXISTS (
      SELECT 1
      FROM blocks rel
      WHERE rel.mode = 'block'
        AND (
          lower(rel.pubkey) = lower(b.pubkey)
          OR lower(jsonb_path_query_first(
            rel.query,
            'strict $[*] ? (@[0] == "blocked")'
          ) ->> 1) = lower(b.pubkey)
        )
    )`,
  ];

  if (app) {
    recentConditions.push(`b.app = $2`);
  }

  const limitParam = `$${index++}`;
  params.push(limit);

  const text = `
    WITH recent AS (
      SELECT b.id, b.created_at, b.content, b.query
      FROM blocks b
      WHERE ${recentConditions.join('\n        AND ')}
    ),
    topic_rows AS (
      SELECT lower(t.topic) AS topic, r.id, r.created_at
      FROM recent r
      CROSS JOIN LATERAL jsonb_array_elements_text(
        CASE
          WHEN jsonb_typeof(r.content) = 'object'
            AND jsonb_typeof(r.content->'topics') = 'array'
          THEN r.content->'topics'
          ELSE '[]'::jsonb
        END
      ) AS t(topic)
      WHERE t.topic IS NOT NULL

      UNION ALL

      SELECT lower(p.value->>1) AS topic, r.id, r.created_at
      FROM recent r
      CROSS JOIN LATERAL jsonb_array_elements(r.query) AS p(value)
      WHERE p.value->>0 = 'topic'
        AND p.value->>1 IS NOT NULL
    )
    SELECT
      topic,
      COUNT(DISTINCT id)::int AS post_count,
      MAX(created_at)::int AS latest_at
    FROM topic_rows
    WHERE topic ~ '^[a-z0-9](?:[a-z0-9._-]{0,48}[a-z0-9])?$'
    GROUP BY topic
    ORDER BY post_count DESC, latest_at DESC, topic ASC
    LIMIT ${limitParam}
  `;

  return { text, params, since };
}

async function getTrendingTopics(input = {}) {
  const params = parseTrendingParams(input);
  const query = buildTrendingQuery(params);
  // Carregado aqui para que os testes possam importar o módulo sem abrir pool.
  const db = require('./db');
  const result = await db.query(query.text, query.params);

  return {
    app: params.app,
    windowSeconds: params.windowSeconds,
    since: query.since,
    topics: result.rows.map((row) => ({
      topic: row.topic,
      count: row.post_count,
      latestAt: row.latest_at,
    })),
  };
}

module.exports = {
  parseTrendingParams,
  buildTrendingQuery,
  getTrendingTopics,
};
