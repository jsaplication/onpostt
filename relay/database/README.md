# Banco de dados

O relay usa PostgreSQL 13+ para armazenar blocos assinados e o controle de
idempotência.

```text
database/
└── schema.sql    # schema canônico e idempotente
```

---

## 1. Aplicar

Recomendado:

```bash
npm run db:init
```

Manual:

```bash
psql "$DATABASE_URL" -f database/schema.sql
```

`schema.sql` usa `IF NOT EXISTS` e pode ser aplicado mais de uma vez. Ele não
apaga dados existentes.

---

## 2. Tabelas

### 2.1 `blocks`

| Coluna | Tipo | Observação |
| --- | --- | --- |
| `id` | text PK | `sha256(JSON.stringify(bloco sem id/sig))` |
| `pubkey` | text NOT NULL | autor; na cópia `_rcp`, destinatário |
| `created_at` | integer NOT NULL | Unix segundos |
| `mode` | text NOT NULL | `post`, `follow`, `block`, `message`, `message_read`, `like`, `reaction`, `comment`, `repost`, `profile`, `notification`, `notification_read` e `delete` |
| `content` | jsonb | texto vira JSON string; `like`, `reaction`, `repost`, `follow`, `block`, `notification` e `delete` podem ser `null`; posts com foto e perfis guardam `image` em base64 |
| `sig` | text NOT NULL | assinatura DER em hexadecimal |
| `app` | text | aplicação |
| `query` | jsonb NOT NULL | array de pares `[chave, valor]` |
| `from` | text | atalho de mensagem (remetente) |
| `to` | text | atalho de mensagem (destinatário) |

Blocos são imutáveis. Exclusão é representada por um bloco `mode = 'delete'`
assinado pelo autor do alvo; as consultas usam `NOT EXISTS` para ocultar o
bloco excluído.

### 2.2 `processed_blocks`

| Coluna | Tipo | Observação |
| --- | --- | --- |
| `id` | text PK | id do bloco já processado |
| `pubkey` | text NOT NULL | autor |
| `mode` | text NOT NULL | modo |
| `created_at` | integer NOT NULL | timestamp do bloco |
| `processed_at` | timestamptz | quando o relay processou |

Essa tabela é a barreira contra replay. O id é inserido na mesma transação do
efeito; se já existir, o relay retorna `duplicate` e não altera nada. Toggles
como `follow` e `block` removem o bloco original, mas a linha de
`processed_blocks` continua sendo a prova de que aquele id já foi aplicado.

> **Não apague linhas de `processed_blocks` sem analisar o impacto.** Em um
> toggle removido, o bloco original não existe mais em `blocks`; a linha em
> `processed_blocks` é a única prova de que aquele id já foi aplicado. Apagar
> permite replay e pode reativar/remover relações.

---

## 3. Índices

| Índice | Uso |
| --- | --- |
| `idx_blocks_created_at` | ordenação e filtros `since`/`until` |
| `idx_blocks_mode` | filtros por modo |
| `idx_blocks_pubkey` | feed/perfil por autor |
| `idx_blocks_mode_created_at` | feed por modo |
| `idx_blocks_mode_app_created_at` | feed por modo e aplicação |
| `idx_blocks_pubkey_mode_created_at` | feed de um autor por modo |
| `idx_blocks_app` | feed por aplicação |
| `idx_blocks_from` / `idx_blocks_to` | conversas |
| `idx_blocks_from_to` | conversa completa |
| `idx_blocks_pubkey_lower`, `idx_blocks_from_lower`, `idx_blocks_to_lower` | filtros de pubkey sem diferenciar caixa |
| `idx_blocks_from_to_lower` | conversa completa sem diferenciar caixa |
| `idx_blocks_query_gin` | contenção `query @>` |
| `idx_blocks_blocker_lower_active` | leituras filtradas por bloqueios ativos (blocker) |
| `idx_blocks_blocked_lower_active` | leituras filtradas por bloqueios ativos (blocked) |
| `idx_blocks_notification_interaction_key` | unicidade de `notification` por `interaction` |
| `idx_blocks_notification_recipient` | notificações por `to` + `created_at` |
| `idx_blocks_notification_target_id` | busca de notificações por `block` |
| `idx_processed_blocks_processed_at` | auditoria/retenção |
| `idx_processed_blocks_pubkey` | manutenção por autor |

O índice GIN usa `jsonb_path_ops`, adequado para `@>`. Os índices de
`notification` são parciais (`WHERE mode = 'notification'`) e extraem valores de
`query` com `jsonb_path_query_first`; o de `interaction` é único e impede
duplicatas concorrentes.

---

## 4. Consultas de exemplo

Últimos posts:

```sql
SELECT id, pubkey, created_at, content, app
FROM blocks
WHERE mode = 'post'
ORDER BY created_at DESC, id DESC
LIMIT 20;
```

Posts de um autor:

```sql
SELECT *
FROM blocks
WHERE mode = 'post' AND pubkey = $1
ORDER BY created_at DESC
LIMIT 20;
```

Posts com uma tag:

```sql
SELECT *
FROM blocks
WHERE mode = 'post'
  AND query @> '[["topic","onpostt"]]'::jsonb
ORDER BY created_at DESC
LIMIT 20;
```

Curtidas de um post:

```sql
SELECT pubkey, created_at
FROM blocks
WHERE mode = 'like'
  AND query @> jsonb_build_array(jsonb_build_array('block'::text, $1::text))
ORDER BY created_at DESC;
```

Reações de um post, agrupadas por emoji:

```sql
SELECT value->>1 AS emoji, count(*) AS total
FROM blocks,
     jsonb_array_elements(query) AS value
WHERE mode = 'reaction'
  AND query @> jsonb_build_array(jsonb_build_array('block'::text, $1::text))
  AND value->>0 = 'reaction'
GROUP BY emoji
ORDER BY total DESC, emoji;
```

Comentários e respostas de um post:

```sql
SELECT id, pubkey, created_at, content, query
FROM blocks
WHERE mode = 'comment'
  AND query @> jsonb_build_array(jsonb_build_array('block'::text, $1::text))
ORDER BY created_at ASC;
```

O campo `parent` em `query` aponta para o comentário respondido, quando
existir.

Último perfil por pubkey:

```sql
SELECT DISTINCT ON (pubkey) *
FROM blocks
WHERE mode = 'profile'
ORDER BY pubkey, created_at DESC, id DESC;
```

Notificações de um destinatário:

```sql
SELECT id, pubkey, created_at, query
FROM blocks
WHERE mode = 'notification'
  AND lower((
    jsonb_path_query_first(query, 'strict $[*] ? (@[0] == "to")') ->> 1
  )) = lower($1)
ORDER BY created_at DESC, id DESC;
```

Consultas de notificação também devem ocultar resultados cuja interação ou bloco
alvo não existe mais ou recebeu tombstone; o relay aplica essas condições em
`src/query.js`.

Conversa:

```sql
SELECT *
FROM blocks
WHERE mode = 'message'
  AND "from" = $1
  AND "to" = $2
  AND pubkey = $1          -- apenas a linha original
ORDER BY created_at DESC;
```

Blocos ocultos por tombstone:

```sql
SELECT b.*
FROM blocks b
WHERE NOT EXISTS (
  SELECT 1
  FROM blocks d
  WHERE d.mode = 'delete'
    AND d.pubkey = b.pubkey
    AND d.query @> jsonb_build_array(jsonb_build_array('block'::text, b.id))
);
```

Duplicatas processadas:

```sql
SELECT mode, count(*) AS total
FROM processed_blocks
GROUP BY mode
ORDER BY total DESC;
```

---

## 5. Manutenção

### 5.1 Estatísticas

```sql
VACUUM (ANALYZE) blocks;
VACUUM (ANALYZE) processed_blocks;
```

O autovacuum normalmente é suficiente. Monitore tabelas bloatadas se houver
muitos toggles (insert/delete frequente).

### 5.2 Tamanho

```sql
SELECT relname,
       pg_size_pretty(pg_total_relation_size(relid)) AS total
FROM pg_catalog.pg_statio_user_tables
ORDER BY pg_total_relation_size(relid) DESC;
```

### 5.3 Retenção de logs

Logs do relay (`logs/`) são independentes do banco. Configure rotação no
winston (`maxsize`/`maxFiles`, já ativos) e/ou logrotate.

### 5.4 Retenção de blocos

O protocolo não define expiração. Se sua operação precisar de retenção:

- `post`, `profile`, `comment`, `like`, `reaction`, `repost`, `follow`, `block`,
  `notification` e `delete` são conteúdo público; a política é sua;
- `message` é ciphertext; apagar reduz metadados;
- apagar `blocks` de um toggle **não** deve apagar `processed_blocks`
  correspondente;
- faça backup antes de qualquer limpeza;
- documente a política para os usuários.

---

## 6. Permissões

Crie um usuário dedicado:

```sql
CREATE ROLE onpostt LOGIN PASSWORD '...';
CREATE DATABASE onpostt OWNER onpostt;
```

Se o banco já existe:

```sql
GRANT CONNECT ON DATABASE onpostt TO onpostt;
GRANT USAGE ON SCHEMA public TO onpostt;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO onpostt;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO onpostt;
```

O relay não precisa de `CREATE`, `DROP` ou superusuário em runtime. Use um
usuário separado (ou `postgres`) apenas para aplicar o schema.

---

## 7. Monitoramento

```sql
-- conexões ativas
SELECT count(*) FROM pg_stat_activity WHERE datname = 'onpostt';

-- queries lentas (requer pg_stat_statements)
SELECT calls, mean_exec_time, query
FROM pg_stat_statements
ORDER BY mean_exec_time DESC
LIMIT 10;

-- locks
SELECT pid, mode, granted, relation::regclass
FROM pg_locks
WHERE NOT granted;
```

Alertas sugeridos:

- conexões > 80% de `max_connections`;
- latência do health check > 200 ms;
- crescimento anormal de `blocks`;
- locks esperando > 5 s;
- falhas de autenticação (28P01) após deploy.

---

## 8. Backup e restauração

Backup:

```bash
pg_dump --format=custom --file=onpostt-$(date +%F).dump onpostt
```

Restauração de teste:

```bash
createdb onpostt_restore
pg_restore --dbname=onpostt_restore onpostt-$(date +%F).dump
psql onpostt_restore -c "SELECT count(*) FROM blocks;"
```

Inclua todas as tabelas. Para PITR, configure WAL archiving no PostgreSQL.

---

## 9. Solução de problemas

| Erro | Causa | Correção |
| --- | --- | --- |
| `28P01` | senha/usuário | ajuste `PGPASSWORD`/`PGUSER`/`DATABASE_URL` |
| `3D000` | banco inexistente | `CREATE DATABASE onpostt` |
| `42P01` | tabela inexistente | rode `npm run db:init` |
| `53300` | conexões esgotadas | reduza `MAX_POOL_SIZE` ou aumente `max_connections` |
| `57014` | statement timeout | otimize consulta ou ajuste `DB_STATEMENT_TIMEOUT_MS` |
| `23505` | unique violation | inesperado em `blocks`/`processed_blocks`; investigue concorrência |
| `40P01` | deadlock | raro; o advisory lock serializa toggles; tente novamente |
