-- ============================================================================
-- onpostt relay — schema canônico (PostgreSQL 13+)
--
-- Execute com:
--   psql "$DATABASE_URL" -f database/schema.sql
-- ou:
--   npm run db:init
--
-- O script é idempotente: pode ser aplicado mais de uma vez.
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- Blocos assinados
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.blocks (
  id          text PRIMARY KEY,
  pubkey      text NOT NULL,
  created_at  integer NOT NULL,
  mode        text NOT NULL,
  content     jsonb,
  sig         text NOT NULL,
  app         text,
  query       jsonb NOT NULL DEFAULT '[]'::jsonb,
  "from"      text,
  "to"        text
);

COMMENT ON TABLE  public.blocks IS 'Blocos assinados do protocolo onpostt.';
COMMENT ON COLUMN public.blocks.id IS 'sha256(JSON.stringify(bloco sem id/sig))';
COMMENT ON COLUMN public.blocks.pubkey IS 'Chave pública secp256k1 do autor (ou do destinatário, na cópia "_rcp").';
COMMENT ON COLUMN public.blocks.query IS 'Array JSON de pares [chave, valor].';
COMMENT ON COLUMN public.blocks."from" IS 'Atalho desnormalizado para mensagens (remetente).';
COMMENT ON COLUMN public.blocks."to" IS 'Atalho desnormalizado para mensagens (destinatário).';

-- ----------------------------------------------------------------------------
-- Idempotência / proteção contra replay
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.processed_blocks (
  id           text PRIMARY KEY,
  pubkey       text NOT NULL,
  mode         text NOT NULL,
  created_at   integer NOT NULL,
  processed_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.processed_blocks IS
  'Garante que um id de bloco gere efeitos no máximo uma vez, inclusive toggles.';

-- ----------------------------------------------------------------------------
-- Índices
-- ----------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_blocks_created_at
  ON public.blocks (created_at);

CREATE INDEX IF NOT EXISTS idx_blocks_mode
  ON public.blocks (mode);

CREATE INDEX IF NOT EXISTS idx_blocks_pubkey
  ON public.blocks (pubkey);

CREATE INDEX IF NOT EXISTS idx_blocks_mode_created_at
  ON public.blocks (mode, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_blocks_mode_app_created_at
  ON public.blocks (mode, app, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_blocks_pubkey_mode_created_at
  ON public.blocks (pubkey, mode, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_blocks_app
  ON public.blocks (app);

CREATE INDEX IF NOT EXISTS idx_blocks_from
  ON public.blocks ("from");

CREATE INDEX IF NOT EXISTS idx_blocks_to
  ON public.blocks ("to");

CREATE INDEX IF NOT EXISTS idx_blocks_from_to
  ON public.blocks ("from", "to");

-- Pubkeys são hex e podem chegar com caixa diferente do valor armazenado.
CREATE INDEX IF NOT EXISTS idx_blocks_pubkey_lower
  ON public.blocks (lower(pubkey));

CREATE INDEX IF NOT EXISTS idx_blocks_from_lower
  ON public.blocks (lower("from"));

CREATE INDEX IF NOT EXISTS idx_blocks_to_lower
  ON public.blocks (lower("to"));

CREATE INDEX IF NOT EXISTS idx_blocks_from_to_lower
  ON public.blocks (lower("from"), lower("to"));

-- Consultas usam `query @> '[[chave, valor]]'::jsonb`.
CREATE INDEX IF NOT EXISTS idx_blocks_query_gin
  ON public.blocks USING gin (query jsonb_path_ops);

-- Relações de bloqueio: leituras filtradas comparam o autor do conteúdo com
-- o blocker (pubkey do bloco) e o blocked (par na query).
CREATE INDEX IF NOT EXISTS idx_blocks_blocker_lower_active
  ON public.blocks (lower(pubkey))
  WHERE mode = 'block';

CREATE INDEX IF NOT EXISTS idx_blocks_blocked_lower_active
  ON public.blocks (lower((
    jsonb_path_query_first(
      query,
      'strict $[*] ? (@[0] == "blocked")'
    ) ->> 1
  )))
  WHERE mode = 'block';

-- Tópicos novos ficam em `content.topics`; o fallback documentado usa
-- `query.topic`, já coberto pelo índice acima.
CREATE INDEX IF NOT EXISTS idx_blocks_post_topics_gin
  ON public.blocks USING gin ((content->'topics'))
  WHERE mode = 'post';

-- Notificações: uma por interação e busca pelo destinatário (pubkey).
-- `query` é um array de pares; JSONPath em modo strict extrai o valor sem
-- desembrulhar o par inteiro.
DROP INDEX IF EXISTS public.idx_blocks_notification_interaction;
DROP INDEX IF EXISTS public.idx_blocks_notification_to;
DROP INDEX IF EXISTS public.idx_blocks_notification_target;

CREATE UNIQUE INDEX IF NOT EXISTS idx_blocks_notification_interaction_key
  ON public.blocks (
    lower((
      jsonb_path_query_first(
        query,
        'strict $[*] ? (@[0] == "interaction")'
      ) ->> 1
    ))
  )
  WHERE mode = 'notification';

CREATE INDEX IF NOT EXISTS idx_blocks_notification_recipient
  ON public.blocks (
    lower((
      jsonb_path_query_first(
        query,
        'strict $[*] ? (@[0] == "to")'
      ) ->> 1
    )),
    created_at DESC
  )
  WHERE mode = 'notification';

CREATE INDEX IF NOT EXISTS idx_blocks_notification_target_id
  ON public.blocks ((
    jsonb_path_query_first(
      query,
      'strict $[*] ? (@[0] == "block")'
    ) ->> 1
  ))
  WHERE mode = 'notification';

CREATE INDEX IF NOT EXISTS idx_processed_blocks_processed_at
  ON public.processed_blocks (processed_at);

CREATE INDEX IF NOT EXISTS idx_processed_blocks_pubkey
  ON public.processed_blocks (pubkey);

COMMIT;
