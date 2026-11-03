# API HTTP e WebSocket

O relay expõe HTTP/JSON e WebSocket/JSON no mesmo host e porta. Esta página
descreve rotas, envelopes, respostas e erros.

---

## 1. HTTP

### 1.1 `GET /health`

Health check para orquestradores. Responde `200` quando o banco está acessível
e `503` quando não está.

```json
{
  "status": "ok",
  "name": "onpostt",
  "database": { "ok": true, "latencyMs": 3 },
  "uptimeSeconds": 120,
  "requestId": "8f4c...",
  "now": "2026-10-25T12:00:00.000Z"
}
```

### 1.2 `GET /status` e `GET /api/status`

Snapshot público do relay. Não inclui credenciais.

```json
{
  "name": "onpostt",
  "protocol": { "name": "onpostt" },
  "relay": {
    "name": "onpostt relay",
    "environment": "development",
    "port": 3000,
    "startedAt": "2026-10-25T12:00:00.000Z",
    "uptimeSeconds": 120
  },
  "database": { "ok": true, "latencyMs": 3 },
  "modes": [
    {
      "name": "reaction",
      "description": "Reação com emoji em um bloco (toggle)",
      "transport": "http",
      "query": { "free": false, "required": ["block", "reaction"], "optional": [] },
      "contentRequired": false,
      "appRequired": true,
      "public": true
    }
  ],
  "stats": {
    "users": 1,
    "connections": 1,
    "subscriptions": 2,
    "httpActive": 0,
    "httpTotal": 42,
    "httpRejected": 0,
    "blocksSaved": 10,
    "blocksRejected": 0,
    "duplicates": 0,
    "lastBlockAt": 1760000000000,
    "memoryRss": 50000000,
    "heapUsed": 20000000
  },
  "limits": {
    "maxBlocksPerRequest": 1000,
    "maxResponseBytes": 8388608,
    "maxBlockSize": 2097152,
    "maxContentSize": 1048576,
    "maxImageBytes": 73728,
    "maxImageDimension": 500,
    "maxImageContentSize": 131072,
    "rateLimitWindowMs": 60000,
    "rateLimitMaxRead": 1200,
    "rateLimitMaxWrite": 300
  },
  "features": {
    "encryptedMessages": true,
    "liveSubscriptions": true,
    "idempotentBlocks": true,
    "reactions": true,
    "commentReplies": true,
    "images": true,
    "encryptedAtRest": false
  },
  "now": "2026-10-25T12:00:00.000Z"
}
```

### 1.3 `GET /api/modes`

Lista os modos com as regras públicas de query, conteúdo e aplicação.

```json
{
  "response": "modes",
  "modes": [
    {
      "name": "comment",
      "description": "Comentário ou resposta em um bloco",
      "transport": "http",
      "query": { "free": false, "required": ["block"], "optional": ["parent"] },
      "contentRequired": true,
      "appRequired": true,
      "public": true
    },
    {
      "name": "block",
      "description": "Bloqueio de usuário (toggle)",
      "transport": "http",
      "query": { "free": false, "required": ["blocker", "blocked"], "optional": [] },
      "contentRequired": false,
      "appRequired": true,
      "public": true
    }
  ],
  "requestId": "8f4c..."
}
```

### 1.4 `GET /api/trending`

Ranking de tópicos em posts recentes. É uma leitura pública e anônima, com rate
limit de leitura e SQL parametrizado. Posts de autores que participam de
bloqueio ativo não entram no agregado; o endpoint devolve apenas tópicos e
contagens, nunca o conteúdo dos posts.

```bash
curl -s 'http://localhost:3000/api/trending?app=onpostt-demo&limit=10&window=604800'
```

```json
{
  "response": "trending",
  "app": "onpostt-demo",
  "windowSeconds": 604800,
  "since": 1759392000,
  "topics": [
    { "topic": "onpostt", "count": 12, "latestAt": 1760000123 },
    { "topic": "seguranca", "count": 7, "latestAt": 1759999000 }
  ],
  "requestId": "8f4c..."
}
```

| Parâmetro | Tipo | Descrição |
| --- | --- | --- |
| `app` | string | aplicação exata; omitido agrega todas |
| `limit` | inteiro | 1..20; padrão 10 |
| `window` | inteiro | janela em segundos, 3600..2592000; padrão 604800 (7 dias) |

A contagem é de posts distintos por tópico. Posts com tombstone do próprio autor
não entram. O ranking ordena por `count` e, em empate, pelo `latestAt` mais
recente. Tópicos vêm de `content.topics` e do fallback legado
`query: [["topic", "slug"]]`.

Para carregar os posts de um tópico, use o filtro `topic` em
`POST /get_blocks_list` (somente `mode: "post"`):

```json
{
  "mode": "post",
  "app": "onpostt-demo",
  "topic": "onpostt",
  "limit": 100
}
```

### 1.5 `POST /get_blocks_list`

Consulta blocos. O corpo é um filtro e pode incluir um token `reader` opcional.

```bash
curl -s http://localhost:3000/get_blocks_list \
  -H 'Content-Type: application/json' \
  -d '{"mode":"post","app":"meu-app","limit":20}'
```

```json
{
  "mode": "post",
  "app": "meu-app",
  "limit": 20,
  "reader": {
    "viewer": "03a1...",
    "created_at": 1760000000,
    "sig": "3045..."
  }
}
```

Sem `reader`, a consulta é anônima. Com `reader`, o relay verifica a assinatura
da mensagem `onpostt-read-v1:<viewer>:<created_at>` e usa a pubkey como
identidade do leitor. O token é somente de leitura, expira em
`READER_TOKEN_TTL_SECONDS` (padrão: 30 dias) e não substitui a assinatura do
bloco.

Resposta:

```json
{
  "response": "blocks",
  "blocks": [
    {
      "id": "9f2c...",
      "pubkey": "03a1...",
      "created_at": 1760000000,
      "mode": "post",
      "query": [["topic", "onpostt"]],
      "content": "olá",
      "app": "meu-app",
      "sig": "3045..."
    }
  ],
  "truncated": false,
  "requestId": "8f4c..."
}
```

`truncated: true` significa que a lista foi cortada por
`MAX_RESPONSE_BYTES` para proteger memória e banda. Use `offset` para buscar a
próxima página.

Filtros:

| Campo | Tipo | Descrição |
| --- | --- | --- |
| `mode` | string | obrigatório |
| `pubkey` | string | autor ou participante de mensagem |
| `query` | array | pares que o bloco deve conter |
| `topic` | string | tópico canônico; apenas `mode: "post"` |
| `since` | inteiro | `created_at >= since` |
| `until` | inteiro | `created_at <= until` |
| `app` | string | aplicação exata |
| `id` | string | id exato |
| `limit` | inteiro | 1..`MAX_BLOCKS_PER_REQUEST` (padrão 1000) |
| `offset` | inteiro | 0..1.000.000 |

Filtros de `message` exigem `pubkey`, os pares `from`/`to` ou `id`.
Filtros de `notification` exigem o par `query: [["to", "<pubkey>"]]` ou `id`.
`to` é comparado sem diferenciar maiúsculas de minúsculas; `pubkey` filtra pelo
ator. Os pares opcionais `block`, `interaction` e `kind` são validados, e o
resultado oculta notificações cuja interação ou bloco alvo não exista mais ou
tenha tombstone. Notificações de `kind: "follow"` apontam para o próprio bloco
`follow` em `block` e `interaction` e desaparecem quando o follow é desfeito.
Filtros de `block` aceitam `blocker`, `blocked` ou ambos. O modo `block` não
aplica o filtro de visibilidade para que a interface consiga detectar o estado.
O filtro `topic` compara `content.topics` e o fallback
`query: [["topic", "<slug>"]]`; ele só é aceito em filtros de `post`.

Com `reader`, o relay esconde conteúdo quando o leitor bloqueou o autor ou o
autor bloqueou o leitor, nas duas direções, para todos os modos exceto `block`.
Sem `reader`, o relay adota o critério conservador de esconder autores que
participam de qualquer bloqueio ativo. Isso evita bypass por omissão do token,
mas não impede uma nova identidade (Sybil).

O ranking `GET /api/trending` também exclui posts de autores que participam de
bloqueio ativo; ele é um agregado anônimo e não entrega o conteúdo dos posts.

Com a biblioteca:

```js
const onpostt = require('./public/onpostt.js');
globalThis.elliptic = require('elliptic');

onpostt.connect({ host: ['http://localhost:3000'] });

// Opcional: autentica a leitura e aplica bloqueios da identidade local.
await onpostt.setReaderKey(myPrivateKey);

const posts = await onpostt.list({ mode: 'post', app: 'meu-app', limit: 20 });
const reactions = await onpostt.list({
  mode: 'reaction',
  query: [
    ['block', posts[0].id],
    ['reaction', '🔥'],
  ],
  limit: 100,
});

const notifications = await onpostt.list({
  mode: 'notification',
  query: [['to', myPubkey]],
  limit: 50,
});

const blocks = await onpostt.list({
  mode: 'block',
  query: [
    ['blocker', myPubkey],
    ['blocked', otherPubkey],
  ],
  limit: 1,
});
```

### 1.6 `POST /save_block`

Grava um bloco assinado. Aceita qualquer modo válido.

```bash
curl -s http://localhost:3000/save_block \
  -H 'Content-Type: application/json' \
  -d @block.json
```

Resposta de criação:

```json
{
  "status": "success",
  "message": "Bloco 9f2c... publicado.",
  "action": "created",
  "id": "9f2c...",
  "mode": "post",
  "requestId": "8f4c..."
}
```

Resposta de toggle removido:

```json
{
  "status": "success",
  "message": "Bloco 9f2c... removido.",
  "action": "removed",
  "id": "9f2c...",
  "mode": "like",
  "requestId": "8f4c..."
}
```

Resposta de id já processado:

```json
{
  "status": "success",
  "message": "Bloco 9f2c... já processado.",
  "action": "duplicate",
  "id": "9f2c...",
  "mode": "like",
  "requestId": "8f4c..."
}
```

Blocos com `action: "created"` ou `"removed"` são transmitidos às assinaturas
WebSocket compatíveis. `duplicate` não é transmitido.

Com a biblioteca:

```js
const block = await onpostt.signBlock(
  {
    mode: 'post',
    query: [['topic', 'onpostt']],
    content: 'olá',
    app: 'meu-app',
  },
  privateKey
);

if (typeof block === 'string') throw new Error(block);

const responses = await onpostt.sendBlock(block);
console.log(responses);
```

Notificação de uma curtida já aceita (sem `content`):

```js
const notification = await onpostt.signBlock(
  {
    mode: 'notification',
    query: [
      ['to', post.pubkey],
      ['block', post.id],
      ['interaction', like.id],
      ['kind', 'like'],
    ],
    app: 'meu-app',
  },
  actorPrivateKey
);

if (typeof notification === 'string') throw new Error(notification);
await onpostt.sendBlock(notification);
```

Notificação de follow (o próprio follow é o alvo e a interação):

```js
const followNotification = await onpostt.signBlock(
  {
    mode: 'notification',
    query: [
      ['to', followedPubkey],
      ['block', follow.id],
      ['interaction', follow.id],
      ['kind', 'follow'],
    ],
    app: 'meu-app',
  },
  followerPrivateKey
);

if (typeof followNotification === 'string') throw new Error(followNotification);
await onpostt.sendBlock(followNotification);
```

Bloqueio/desbloqueio (toggle; o autor é sempre o bloqueador):

```js
const block = await onpostt.signBlock(
  {
    mode: 'block',
    query: [
      ['blocker', myPubkey],
      ['blocked', otherPubkey],
    ],
    app: 'meu-app',
  },
  myPrivateKey
);

if (typeof block === 'string') throw new Error(block);
const [result] = await onpostt.sendBlock(block);
// result.action: "created" no bloqueio, "removed" no desbloqueio
```

Enquanto o bloqueio existir, `message` entre as duas pubkeys é recusado nos dois
sentidos com `code: "user_blocked"`.

### 1.7 Códigos de status

| Status | Quando |
| --- | --- |
| `200` | sucesso, incluindo `duplicate` |
| `400` | bloco/filtro inválido, assinatura inválida, alvo inexistente |
| `403` | `Origin` não permitida |
| `404` | rota inexistente |
| `413` | corpo maior que o limite |
| `415` | `Content-Type` não JSON |
| `429` | rate limit |
| `500` | erro interno |

### 1.8 CORS

- A própria origem do relay é sempre aceita.
- Outras origens precisam estar em `HOST_ALLOWED`.
- `OPTIONS` responde `204` com os cabeçalhos de CORS.
- `HOST_ALLOWED=*` libera qualquer origem e deve ser usado apenas em
  desenvolvimento consciente.

### 1.9 Perfil público e demo

| Rota | Função |
| --- | --- |
| `GET /perfil.html?pubkey=<pubkey>` | página pública com perfil, publicações, foto e atividade |
| `GET /perfil`, `GET /profile`, `GET /profile.html` | redirecionam para `/perfil.html` preservando a query string |
| `GET /demo/?view=feed` | demo na seção de feed |
| `GET /demo/?view=feed&topic=<slug>` | feed filtrado por tópico |
| `GET /demo/?view=profiles` | demo na seção de perfis |
| `GET /demo/?view=notifications` | demo na seção de notificações |
| `GET /demo/?view=chat` | demo na seção de conversas |
| `GET /demo/?view=about` | demo na seção sobre |

A demo mostra **Seguir de volta** em notificações de follow e no perfil quando
a pessoa já segue o visitante. O perfil também oferece **Bloquear** /
**Desbloquear**; quem foi bloqueado vê **Perfil indisponível** no demo.

A página de perfil lê blocos públicos de todas as aplicações e não exige
autenticação. Sem `pubkey`, ela usa a identidade local quando existir. A foto do
perfil é preparada no navegador para até **150px**; fotos de publicações
continuam em **500px**. O demo limita feed, perfis e notificações ao app
`onpostt-demo`.

---

## 2. WebSocket

Conecte no mesmo host/porta:

```js
const ws = new WebSocket('ws://localhost:3000/');
```

O relay envia um `hello` ao aceitar a conexão:

```json
{
  "response": "hello",
  "name": "onpostt",
  "relay": "onpostt relay",
  "heartbeatIntervalMs": 30000
}
```

O `Origin` é validado no upgrade. Conexões sem `Origin` são rejeitadas por
padrão; use `ALLOW_NO_ORIGIN=true` apenas para clientes nativos confiáveis.

### 2.1 Assinatura

```json
{
  "request": "get_blocks_sub",
  "subscription": "feed",
  "filter": { "mode": "post", "app": "meu-app", "limit": 20 },
  "reader": {
    "viewer": "03a1...",
    "created_at": 1760000000,
    "sig": "3045..."
  },
  "requestId": "req-1"
}
```

Resposta:

```json
{
  "response": "subscribed",
  "subscription": "feed",
  "requestId": "req-1"
}
```

Blocos iniciais:

```json
{
  "response": "blocks",
  "subscription": "feed",
  "blocks": [],
  "truncated": false,
  "initial": true,
  "requestId": "req-1"
}
```

`truncated: true` indica corte por `MAX_RESPONSE_BYTES`; ajuste o filtro ou
pagine com `offset`.

Blocos ao vivo:

```json
{
  "response": "blocks",
  "subscription": "feed",
  "blocks": [
    {
      "id": "9f2c...",
      "pubkey": "03a1...",
      "created_at": 1760000000,
      "mode": "post",
      "query": [],
      "content": "olá",
      "app": "meu-app",
      "sig": "3045..."
    }
  ],
  "live": true
}
```

`filter` é obrigatório e segue as mesmas regras de `get_blocks_list`. O id da
assinatura é opcional; se omitido, o relay gera um. O limite padrão é 25
assinaturas por conexão e 5 pubkeys distintas. `reader` também é opcional e tem
o mesmo formato do HTTP: o relay filtra a página inicial e cada bloco ao vivo
antes de entregar. Sem `reader`, valem as regras anônimas. Blocos do modo
`block` são entregues para que o cliente detecte o bloqueio.

Para remover:

```json
{ "request": "unsubscribe", "subscription": "feed", "requestId": "req-2" }
```

### 2.2 Gravar mensagem

Apenas `message` é aceita pelo WebSocket. Os demais modos usam HTTP.

```json
{
  "request": "save_block",
  "block": {
    "id": "9f2c...",
    "pubkey": "03a1...",
    "created_at": 1760000000,
    "mode": "message",
    "query": [
      ["from", "03a1..."],
      ["to", "02b2..."]
    ],
    "content": "{\"forRecipient\":{...},\"forSender\":{...}}",
    "app": "meu-app",
    "sig": "3045..."
  },
  "requestId": "req-3"
}
```

A resposta é o mesmo resultado de `/save_block`, com `requestId`.

### 2.3 Ping e status

```json
{ "request": "ping", "requestId": "req-4" }
```

```json
{ "response": "pong", "ts": 1760000000000, "requestId": "req-4" }
```

```json
{ "request": "get_status", "requestId": "req-5" }
```

O relay também envia ping/pong nativo e encerra conexões inativas após
`SOCKET_INACTIVITY_TIMEOUT` (padrão 10 minutos).

### 2.4 Limites WebSocket

| Limite | Padrão |
| --- | --- |
| Conexões | 1000 |
| Payload por mensagem | 1 MiB |
| Assinaturas por conexão | 25 |
| Pubkeys por conexão | 5 |
| Mensagens por janela | 120 |
| Inatividade | 600 s |
| Heartbeat | 30 s |

---

## 3. Erros

Erros HTTP:

```json
{
  "status": "erro",
  "code": "invalid_signature",
  "message": "Assinatura inválida. Bloco rejeitado.",
  "requestId": "8f4c..."
}
```

Erros WebSocket:

```json
{
  "status": "erro",
  "code": "invalid_filter",
  "message": "Campo \"mode\" inválido ou ausente.",
  "requestId": "req-1"
}
```

Principais códigos:

| Código | Causa |
| --- | --- |
| `invalid_json` | corpo ou mensagem não é JSON |
| `invalid_body` | corpo não é um objeto |
| `unsupported_media_type` | `Content-Type` não JSON |
| `payload_too_large` | corpo/payload acima do limite |
| `forbidden_origin` | `Origin` não permitida |
| `rate_limited` | muitas requisições |
| `invalid_filter` | filtro inválido |
| `invalid_reader` | token `reader` ausente de campos obrigatórios ou malformado |
| `invalid_reader_signature` | assinatura do token `reader` inválida |
| `reader_expired` | token `reader` passou do TTL |
| `reader_not_yet_valid` | `reader.created_at` no futuro além da tolerância |
| `invalid_mode` | modo inválido |
| `invalid_block` | bloco inválido (formato, query ou regra do modo) |
| `invalid_id` | id não confere com o hash |
| `invalid_signature` | assinatura inválida |
| `invalid_timestamp` | `created_at` no futuro |
| `invalid_query` | query com chave ausente, extra ou duplicada |
| `content_too_large` | conteúdo acima do limite |
| `block_too_large` | bloco acima do limite |
| `invalid_image` | imagem fora do formato, base64 ou magic bytes esperados |
| `invalid_image_dimensions` | dimensões declaradas/reais inválidas ou acima de 500px |
| `image_too_large` | imagem decodificada acima de `MAX_IMAGE_BYTES` |
| `target_not_found` | alvo de like/reaction/comment/delete inexistente |
| `target_deleted` | alvo possui tombstone |
| `target_not_owned` | `delete` feito por quem não é autor |
| `parent_not_found` | comentário pai inexistente |
| `parent_mismatch` | comentário pai pertence a outro alvo |
| `interaction_not_found` | notificação aponta para interação inexistente |
| `interaction_author_mismatch` | interação referida pertence a outro autor |
| `interaction_target_mismatch` | interação referida pertence a outro bloco |
| `notification_recipient_mismatch` | destinatário não é o dono do bloco alvo ou não é o `following` do follow |
| `notification_kind_mismatch` | `kind` não corresponde ao modo da interação |
| `notification_target_mismatch` | notificação de follow não aponta para o próprio bloco follow |
| `notification_follow_mismatch` | autor do bloco follow não é o seguidor indicado |
| `notification_duplicate` | já existe notificação para a interação |
| `self_notification` | autor tentou notificar a própria pubkey |
| `user_blocked` | mensagem entre usuários com bloqueio ativo em qualquer sentido |
| `private_key_forbidden` | filtro enviou `privatekey` |
| `use_http` | modo não-message enviado pelo WebSocket |
| `unknown_request` | requisição WebSocket desconhecida |
| `subscription_not_found` | assinatura não existe |
| `too_many_subscriptions` | limite de assinaturas |
| `too_many_pubkeys` | limite de pubkeys |
| `not_found` | rota inexistente |
| `internal_error` | erro interno |

---

## 4. Exemplo completo em Node.js

```js
'use strict';

globalThis.elliptic = require('elliptic');
const onpostt = require('./public/onpostt.js');

const host = 'http://localhost:3000';
const app = 'meu-app';

async function main() {
  const alice = onpostt.generateKeys();
  const bob = onpostt.generateKeys();

  onpostt.connect({ host: [host], socket: [host] });
  await onpostt.setReaderKey(alice.privateKey);

  const post = await onpostt.signBlock(
    {
      mode: 'post',
      query: [['topic', 'onpostt']],
      content: 'olá',
      app,
    },
    alice.privateKey
  );

  if (typeof post === 'string') throw new Error(post);
  await onpostt.sendBlock(post);

  const reaction = await onpostt.signBlock(
    {
      mode: 'reaction',
      query: [
        ['block', post.id],
        ['reaction', '🔥'],
      ],
      app,
    },
    bob.privateKey
  );
  await onpostt.sendBlock(reaction);

  const comment = await onpostt.signBlock(
    {
      mode: 'comment',
      query: [['block', post.id]],
      content: 'comentário',
      app,
    },
    bob.privateKey
  );
  await onpostt.sendBlock(comment);

  const reply = await onpostt.signBlock(
    {
      mode: 'comment',
      query: [
        ['block', post.id],
        ['parent', comment.id],
      ],
      content: 'resposta',
      app,
    },
    bob.privateKey
  );
  await onpostt.sendBlock(reply);

  const blocks = await onpostt.list({ mode: 'post', app, limit: 10 });
  console.log(blocks);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
```
