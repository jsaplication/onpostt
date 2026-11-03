# Arquitetura

O onpostt é um relay modular em Node.js que serve HTTP e WebSocket na mesma
porta, com PostgreSQL como armazenamento de blocos assinados.

O desenho preserva a arquitetura do protocolo: clientes independentes, relays
replicáveis, blocos imutáveis e fan-out por filtro. Cada componente é isolado,
validado e limitado.

---

## 1. Diagrama

```text
                         ┌───────────────────────┐
                         │ Usuário               │
                         │ chave privada local   │
                         └───────────┬───────────┘
                                     │ assina / cifra
                                     ▼
┌────────────────────────────────────────────────────────────┐
│ Cliente / app                                              │
│  ├─ biblioteca onpostt (chaves, assinatura, cifra)         │
│  ├─ HTTP  → save_block / get_blocks_list                   │
│  └─ WS    → assinaturas em tempo real / message            │
└───────────────┬────────────────────────────┬───────────────┘
                │ HTTP                       │ WebSocket
                ▼                            ▼
┌───────────────────────────┐    ┌───────────────────────────┐
│ Relay 1                   │    │ Relay 2 ... Relay N       │
│  Express + WS + validação │    │ mesmo protocolo           │
└─────────────┬─────────────┘    └─────────────┬─────────────┘
              │                                │
              └──────────────┬─────────────────┘
                             ▼
                ┌───────────────────────────┐
                │ PostgreSQL                │
                │  blocks                   │
                │  processed_blocks         │
                └───────────────────────────┘
```

Os relays podem compartilhar o mesmo banco ou operar de forma independente.
Compartilhar o banco facilita consistência, mas o fan-out WebSocket continua
local a cada processo.

---

## 2. Componentes

| Módulo | Papel |
| --- | --- |
| `src/main.js` | cria o servidor HTTP, monta o WS, timeouts, banner e shutdown |
| `src/config.js` | lê `.env`, normaliza origens, define limites e features |
| `src/logger.js` | winston (console + arquivo), metadados seguros |
| `src/db.js` | pool PostgreSQL, transações, health check com cache |
| `src/crypto.js` | SHA-256, secp256k1, validação de chave/assinatura/id |
| `src/modes.js` | definição declarativa dos modos e regras de query |
| `src/protocol.js` | validação completa do bloco e matching de filtros ao vivo |
| `src/image.js` | validação de base64, magic bytes e dimensões reais de fotos |
| `src/topics.js` | normalização, validação e extração de tópicos |
| `src/trending.js` | agregação SQL e ranking de tópicos em alta |
| `src/query.js` | normalização de filtros e geração de SQL parametrizado |
| `src/readAuth.js` | token `reader` assinado e identidade de leitura |
| `src/visibility.js` | visibilidade de blocos ao vivo por relação de bloqueio |
| `src/getBlocks.js` | leitura de blocos |
| `src/saveBlock.js` | transação, idempotência, toggles, cópia de mensagem |
| `src/stats.js` | contadores em memória para status |
| `src/errors.js` | erros públicos com `code` estável |
| `src/relay-http.js` | Express, CORS, CSP, rate limit, API e estáticos |
| `src/relay-socket.js` | upgrade, assinaturas, fan-out, mensagens, heartbeat |
| `public/onpostt.js` | biblioteca do cliente |
| `public/perfil.html` + `public/assets/perfil.js` | página pública de perfil e leitura de atividade |
| `scripts/build-lib.js` | elliptic + biblioteca → bundle minificado |

---

## 3. Inicialização

```text
main.js
  ├─ require config        (carrega .env, valida limites)
  ├─ require logger        (cria logs/ se habilitado)
  ├─ require relay-http    (cria app Express)
  ├─ require relay-socket  (cria WebSocketServer noServer)
  ├─ http.createServer(app)
  ├─ setupWebSocket(server)
  ├─ server.listen(port, host)
  └─ timers: heartbeat, limpeza de rate limit, cache de saúde
```

O servidor **sobe mesmo sem banco**. Nesse caso:

- `/health` responde `503` com `status: "degraded"`;
- `/api/status` mostra `database.ok = false`;
- consultas e gravações falham com erro público ou `internal_error`.

Isso permite diagnosticar a configuração pela dashboard.

---

## 4. Ciclo de uma requisição HTTP

```text
request
  │
  ├─ requestId + headers de segurança + estatísticas
  ├─ validação de Origin            → 403 se não permitida
  ├─ OPTIONS                        → 204
  ├─ express.json (limite)          → 400/413/415
  ├─ rate limiter (read/write)      → 429
  ├─ rota
  │    ├─ /get_blocks_list → parseReader → normalizeFilter → SQL → capBlocks → rows
  │    └─ /save_block      → validateBlock → transação → broadcast
  └─ resposta JSON + requestId (+ truncated, se houver corte)
```

Erros passam pelo handler final, que:

- devolve mensagem pública para `PublicError`;
- registra internos sem detalhes;
- adiciona `requestId`;
- define `Retry-After` em rate limit.

---

## 5. Ciclo de gravação

```text
saveBlock(block)
  │
  ├─ validateBlockDetailed
  │    ├─ formato, tamanho, campos proibidos
  │    ├─ pubkey, created_at, mode, app, query, content, sig
  │    ├─ regras por modo
  │    ├─ assinatura
  │    └─ id canônico
  │
  ├─ verificação redundante de assinatura
  │
  └─ transação
       ├─ advisory lock (pubkey:mode:alvo[:emoji])
       │    └─ notification: lock por interaction
       ├─ INSERT processed_blocks ... ON CONFLICT DO NOTHING
       │    └─ 0 linhas → duplicate (rollback lógico)
       ├─ checagem de id existente (rede de segurança)
       ├─ switch(mode)
       │    ├─ post/profile          → INSERT
       │    ├─ comment               → valida alvo/pai → INSERT
       │    ├─ notification          → valida interação/alvo/kind → INSERT
       │    ├─ notification_read     → valida destinatário → INSERT
       │    ├─ message_read          → valida destinatário → INSERT
       │    ├─ delete                → valida dono → INSERT tombstone
       │    ├─ like/reaction/follow  → DELETE toggle ou INSERT
       │    ├─ repost                → DELETE toggle ou INSERT
       │    └─ message               → INSERT original + cópia _rcp
       └─ COMMIT
```

Após `action: "created"` ou `"removed"` em um toggle, o HTTP chama
`broadcastBlock`. O WS chama `broadcastBlock` diretamente após gravar uma
mensagem.

### Por que advisory lock?

Duas requisições concorrentes com ids diferentes podem tentar criar/remover o
mesmo `like` ou a mesma `reaction`. O lock por `pubkey:mode:alvo` (incluindo o
emoji em reações) serializa a decisão e evita estados intermediários
inconsistentes.

`notification` usa um lock separado por `interaction`: a unicidade é por
interação, não por autor/alvo. A verificação de duplicidade consulta o banco e o
índice único parcial `idx_blocks_notification_interaction_key` é a última
barreira contra duas notificações concorrentes para a mesma interação.

### Por que `processed_blocks`?

O id é o identificador lógico do bloco. Registrar antes do efeito garante que
replay não alterne toggles. A tabela também serve de auditoria de processamento.

---

## 6. Leitura e filtros

```text
getBlocksPage(filter, viewer)
  ├─ normalizeFilter
  │    ├─ lista fechada de campos
  │    ├─ valida mode/pubkey/app/id/since/until
  │    ├─ valida query e chaves reservadas
  │    ├─ normaliza topic (somente post)
  │    ├─ restringe message (pubkey/from/to/id)
  │    ├─ restringe notification (to ou id)
  │    └─ restringe notification_read/message_read (pubkey ou id)
  ├─ buildBlocksQuery(filter, viewer)
  │    ├─ WHERE parametrizado
  │    ├─ query @> '[[k,v]]'::jsonb
  │    ├─ topic: content.topics @> ["slug"] OR query.topic
  │    ├─ viewer: esconde relação de bloqueio nas duas direções
  │    ├─ anônimo: esconde autores com bloqueio ativo (exceto mode=block)
  │    ├─ tombstones via NOT EXISTS
  │    ├─ notification: esconde interação/alvo removidos
  │    ├─ profile: DISTINCT ON (lower(pubkey))
  │    └─ ORDER BY created_at DESC, id DESC + LIMIT/OFFSET
  └─ capBlocks
       └─ MAX_RESPONSE_BYTES → { blocks, truncated }
```

O token `reader` é verificado por `readAuth.parseReader`; a pubkey resultante
entra como parâmetro SQL, nunca interpolada. Sem token, `viewer` é `null` e a
consulta usa a proteção anônima. O modo `block` não se auto-filtra para permitir
detecção de estado na interface.

Nenhum valor é interpolado. O número de parâmetros é fixo por consulta. O
`getBlocks` antigo permanece como atalho interno para a lista.

### 6.1 Trending

`GET /api/trending` usa uma consulta de agregação separada. Ela seleciona posts
da janela (`created_at >= now - window`), opcionalmente por `app`, exclui
tombstones do autor, exclui autores que participam de bloqueio ativo (o ranking
é anônimo), expande `content.topics` e o fallback `query.topic`, e conta
`DISTINCT id` por tópico. O resultado é ordenado por contagem e depois
pelo post mais recente. `limit` e `window` são validados e parametrizados; o
índice parcial `idx_blocks_post_topics_gin` acelera a leitura por tópico.

---

## 7. WebSocket

### 7.1 Upgrade

```text
server.on('upgrade')
  ├─ valida caminho (SOCKET_PATH)
  ├─ valida Origin
  ├─ valida limite de conexões
  └─ wss.handleUpgrade → connection
```

### 7.2 Estado por conexão

```js
{
  id,
  ip,
  subscriptions: Map<id, { filter, seen, order }>,
  pubkeys: Set,
  rate: { count, reset },
  inactivityTimer,
  alive
}
```

### 7.3 Assinatura

```text
get_blocks_sub
  ├─ parseReader (opcional)
  ├─ normalizeFilter
  ├─ limite de assinaturas/pubkeys
  ├─ registra assinatura + viewer
  ├─ responde "subscribed"
  ├─ getBlocksPage(filter, viewer)
  └─ envia "blocks" iniciais (dedupe + truncated)
```

Blocos ao vivo são entregues por `broadcastBlock`, que percorre conexões e
assinaturas, aplica `blockMatchesFilter`, consulta `visibility.isVisibleTo`
(relação de bloqueio atual, com fail closed em erro de banco) e deduplica por id.
Blocos `block` são sempre entregues para a interface detectar o estado.

### 7.4 Heartbeat

- A cada `SOCKET_HEARTBEAT_INTERVAL`, o servidor envia `ping` (frame).
- Sem `pong` até o próximo ciclo, a conexão é encerrada.
- Qualquer mensagem reinicia o timeout de inatividade.
- `{ "request": "ping" }` é respondido com `{ "response": "pong" }` (aplicação).

### 7.5 Mensagens

```text
save_block (WS)
  ├─ exige mode === "message"
  ├─ saveBlock(block)
  ├─ responde resultado
  └─ broadcastBlock (se created)
```

Mensagens também podem ser gravadas por HTTP. O WS é o caminho preferencial
porque mantém a conexão viva e permite entrega imediata.

---

## 8. Modelo de dados

```text
blocks
  id (PK)          texto; sha256 canônico
  pubkey           autor; na cópia _rcp, destinatário
  created_at       unix segundos
  mode             post|follow|message|message_read|like|reaction|comment|repost|profile|notification|notification_read|delete
  content          jsonb (texto vira JSON string)
  sig              DER hex
  app              identificador da aplicação
  query            jsonb [[k,v], ...]
  from,to          atalhos desnormalizados de message

processed_blocks
  id (PK)          id já processado
  pubkey, mode, created_at
  processed_at     timestamptz
```

Relações:

- um `like` referencia um bloco por `query.block`;
- uma `reaction` referencia um bloco e um emoji por `query.block` +
  `query.reaction`;
- um `comment` referencia um bloco por `query.block` e, opcionalmente, um
  comentário pai por `query.parent`;
- uma `notification` referencia o destinatário (`to`), o bloco alvo (`block`), a
  interação (`interaction`) e o tipo (`kind`); só existe uma por interação;
- `notification_read` e `message_read` guardam em `content.read` apenas ids de
  blocos pertencentes ao autor do recibo;
- um `delete` referencia um bloco por `query.block`;
- um `follow` referencia duas pubkeys;
- um `repost` referencia um bloco por `query.block`;
- uma `message` gera uma linha original e, se `from != to`, uma cópia
  `<id>_rcp` com `pubkey = to`;
- tombstones não removem linhas; consultas os aplicam via `NOT EXISTS`.

---

## 9. Fan-out e deduplicação

Existem três níveis de dedupe:

| Nível | Chave | Onde |
| --- | --- | --- |
| Servidor | id por assinatura | `subscription.seen` (até 2000) |
| Cliente WS | id por assinatura | `subscription.seen` (até 5000) |
| Cliente HTTP | id lógico (`_rcp` removido) | `list()` entre hosts |

O dedupe é **por assinatura**, não global. Duas assinaturas do mesmo cliente
podem receber o mesmo bloco se ambas casarem, o que é o comportamento correto
para callbacks diferentes.

---

## 10. Múltiplos relays

```text
Cliente
  ├─ host A ──┐
  ├─ host B ──┼─ list() agrega e deduplica por id
  └─ host C ──┘
```

- `connect({ host: [...] })` define hosts HTTP.
- `connect({ socket: [...] })` define sockets WS.
- Escritas HTTP são enviadas a todos os hosts em paralelo.
- Mensagens WS são enviadas a todos os sockets abertos.
- Respostas de erro de um host não impedem as demais.

Não há quorum, ordenação global nem resolução de conflitos: blocos são
imutáveis e identificados por hash, então a união é natural.

---

## 11. Falhas e recuperação

| Falha | Comportamento |
| --- | --- |
| Banco indisponível | `/health` 503; escritas/leituras falham; processo continua |
| WS cai | cliente agenda reconexão com backoff (1–30 s + jitter) |
| Servidor reinicia | assinaturas são reenviadas ao reconectar |
| Cliente fecha | servidor remove conexão, assinaturas e timers |
| Query lenta | log de warning acima de 500 ms; `statement_timeout` limita |
| Erro não capturado | log; encerra apenas se `EXIT_ON_UNCAUGHT=true` |
| SIGTERM/SIGINT | fecha WS, HTTP e pool; força saída após 10 s |
| Porta em uso | log de erro e `exitCode=1` |

---

## 12. Escala

O relay é stateless em relação a blocos (o estado está no PostgreSQL), mas
mantém estado local em:

- conexões WS e assinaturas;
- rate limit em memória;
- contadores de status.

Para escalar horizontalmente:

1. use um balanceador com sticky sessions **ou** aceite que cada cliente tenha
   seu próprio conjunto de conexões;
2. compartilhe fan-out entre instâncias via pub/sub (Redis, NATS) se precisar
   que um bloco gravado em A chegue a assinantes em B;
3. compartilhe rate limit;
4. dimensione o pool PostgreSQL (`MAX_POOL_SIZE`) por instância;
5. monitore conexões e memória;
6. mantenha o mesmo schema em todas as instâncias.

Com banco compartilhado, consultas iniciais já enxergam blocos de outras
instâncias. Sem pub/sub, porém, o tempo real fica restrito à instância que
recebeu a escrita.

---

## 13. Decisões de projeto

| Decisão | Motivo |
| --- | --- |
| Blocos imutáveis + tombstones | simplicidade, auditabilidade, idempotência |
| `id` derivado do conteúdo | dedupe entre relays e proteção contra troca |
| Assinatura sobre JSON ingênuo | ordem explícita e interoperabilidade |
| Toggles como presença de linha | consultas simples e reversíveis |
| `processed_blocks` separado | replay protection sem alterar `blocks` |
| Cópia `_rcp` | caixa de entrada eficiente para o destinatário |
| E2E no cliente | relay não precisa de chave privada |
| Chave efêmera por envio | reduz reuso de chave |
| Express + `ws` | maturidade, baixo acoplamento, fácil proxy |
| Sem CDN | CSP forte, disponibilidade e privacidade |

---

## 14. Mapa do código

```text
src/main.js           bootstrap e shutdown
src/config.js         ambiente
src/relay-http.js     HTTP
src/relay-socket.js   WebSocket
src/protocol.js       regras do protocolo
src/image.js          validação de fotos
src/query.js          filtros → SQL
src/readAuth.js       token de leitura
src/visibility.js     bloqueio ao vivo
src/saveBlock.js      escrita
src/getBlocks.js      leitura
src/crypto.js         primitivas
src/modes.js          catálogo de modos
src/db.js             PostgreSQL
src/stats.js          métricas
src/errors.js         erros
src/logger.js         logs
```
