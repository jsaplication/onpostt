# Protocolo onpostt

Este documento descreve o formato dos blocos, as regras de validação, os modos,
as consultas e a cifragem de mensagens. Ele é normativo para implementações do
relay e da biblioteca.

- Nome do protocolo: `onpostt`
- Transportes: HTTP/JSON e WebSocket/JSON
- Assinatura: secp256k1 (DER em hexadecimal)
- Hash: SHA-256 (hexadecimal minúsculo)

---

## 1. Visão geral

```text
┌────────────────┐   bloco assinado    ┌────────────────┐
│ Cliente        │────────────────────▶│ Relay          │
│ chave privada  │   HTTP / WebSocket  │ valida e grava │
└────────────────┘                     └───────┬────────┘
                                               │
                                               ▼
                                      ┌────────────────┐
                                      │ PostgreSQL     │
                                      │ blocks         │
                                      │ processed_blocks│
                                      └───────┬────────┘
                                              │
                                              ▼
                                      ┌────────────────┐
                                      │ Fan-out WS     │
                                      │ por filtro     │
                                      └────────────────┘
```

Princípios:

1. O cliente é a única parte que conhece a chave privada.
2. O relay valida fatos verificáveis (assinatura, id, formato, alvo e autoria)
   antes de gravar.
3. Blocos são imutáveis. Exclusão é representada por um tombstone (`delete`).
4. Mensagens são cifradas no cliente; o relay só vê o envelope.
5. O relay pode ser replicado; a biblioteca agrega hosts e deduplica por id.

---

## 2. Bloco

Um bloco é um objeto JSON com os campos abaixo.

| Campo | Tipo | Obrigatório | Descrição |
| --- | --- | --- | --- |
| `id` | string | sim | SHA-256 hex de 64 caracteres |
| `pubkey` | string | sim | pubkey secp256k1 comprimida (66) ou não comprimida (130) |
| `created_at` | inteiro | sim | timestamp Unix em segundos, positivo |
| `mode` | string | sim | `post`, `follow`, `block`, `message`, `message_read`, `like`, `reaction`, `comment`, `repost`, `profile`, `notification`, `notification_read` ou `delete` |
| `query` | array | sim | pares `[chave, valor]`; pode ser `[]` em `post`, `profile`, `notification_read` e `message_read` |
| `content` | string \| objeto \| array | depende | obrigatório em `post`, `profile`, `comment`, `message`, `notification_read` e `message_read`; opcional em `like`, `reaction`, `repost`, `follow`, `block` e `delete`; proibido em `notification`; em `post`, objeto `{ text?, image }` para fotos |
| `app` | string | sim, exceto `delete` | identificador da aplicação, 1–190 caracteres |
| `sig` | string | sim | assinatura DER secp256k1 em hex |

Campos extras são permitidos (até 32 campos no total), desde que não sejam
`privatekey`, `__proto__`, `constructor` ou `prototype` (sem diferenciar
maiúsculas de minúsculas). Eles entram no id e na assinatura.

### 2.1 Exemplo

```json
{
  "pubkey": "03a1...66-hex...",
  "created_at": 1760000000,
  "mode": "post",
  "query": [["topic", "onpostt"]],
  "content": "primeiro post",
  "app": "meu-app",
  "id": "9f2c...64-hex...",
  "sig": "3045...der..."
}
```

### 2.2 Ordem canônica

A serialização é `JSON.stringify`, portanto **a ordem das propriedades faz
parte dos bytes assinados**. O relay usa a ordem recebida; o cliente precisa
assinar exatamente o mesmo objeto que envia.

A biblioteca oficial sempre monta nesta ordem:

```text
pubkey, created_at, mode, query, content, app, [campos extras], id, sig
```

Regras:

- `id` entra na mensagem assinada.
- `sig` não entra.
- `id` e `sig` não entram no cálculo do id.
- `undefined` não é serializado; para omitir `content` em `like`, `reaction`,
  `repost`, `follow`, `block` ou `delete`, não inclua a propriedade.
- A biblioteca adiciona um campo extra `nonce` (32 hex) a `like`, `reaction`,
  `repost`, `follow` e `block` sem `content`. Isso garante um id diferente quando
  duas ações do mesmo autor ocorrem no mesmo segundo. O campo é assinado e não
  altera as regras do modo.

O servidor não reordena o bloco antes de validar. Se um cliente construir o
objeto em outra ordem, deve calcular id e assinatura sobre essa mesma ordem.

---

## 3. Id canônico

```js
const unsigned = { ...block };
delete unsigned.id;
delete unsigned.sig;
const id = sha256(JSON.stringify(unsigned));
```

O relay compara o `id` recebido com o calculado (case-insensitive) e rejeita a
divergência com `code: "invalid_id"`.

O id é usado para:

- chave primária em `blocks`;
- idempotência em `processed_blocks`;
- dedupe de entrega no WebSocket;
- alvo de `like`, `reaction`, `comment` e `delete`;
- dedupe entre múltiplos relays no cliente.

---

## 4. Assinatura

```js
const signed = { ...block };
delete signed.sig;              // id permanece
const msgHash = sha256(JSON.stringify(signed));
const sig = secp256k1.sign(msgHash, privateKey).toDER('hex');
```

O relay:

1. valida o formato DER (hex, comprimento par entre 128 e 200);
2. reconstrói o objeto sem `sig`, preservando a ordem recebida;
3. calcula SHA-256 do JSON;
4. verifica com a `pubkey` do bloco.

Falhas retornam `code: "invalid_signature"`.

> O relay verifica a assinatura **duas vezes** no caminho de gravação: uma na
> validação completa e outra explícita antes da transação. Isso é redundância
> intencional.

---

## 5. Modos

### 5.1 `post`

Publicação pública. `query` é livre. Conteúdo pode ser string, objeto ou array.
Posts com foto usam o objeto descrito em [5.1.1](#511-fotos); posts com tópicos
usam `content.topics`, descrito em [5.1.2](#512-tópicos).

```json
{
  "mode": "post",
  "query": [],
  "content": {
    "text": "olá",
    "topics": ["boas-vindas", "onpostt"]
  },
  "app": "meu-app"
}
```

O fallback histórico com `query: [["topic", "boas-vindas"]]` continua aceito e
é lido como um tópico legado.

#### 5.1.1 Fotos

Fotos são opcionais e viajam como base64 no `content` assinado. O formato é
fechado: o objeto de conteúdo com imagem aceita **apenas** `text`, `image` e
`topics`, e o objeto `image` aceita **apenas** `mime`, `data`, `width` e
`height`.

```json
{
  "mode": "post",
  "query": [],
  "app": "meu-app",
  "content": {
    "text": "legenda opcional",
    "image": {
      "mime": "image/jpeg",
      "data": "<base64 canônico, sem prefixo data:>",
      "width": 500,
      "height": 375
    }
  }
}
```

Regras de validação no relay:

- `mime` deve ser `image/jpeg` ou `image/png`;
- `data` deve ser base64 canônico, com padding correto e sem prefixo
  `data:image/...;base64,`;
- os bytes decodificados não podem passar de `MAX_IMAGE_BYTES` (72 KiB por
  padrão);
- os magic bytes precisam corresponder ao `mime` declarado;
- as dimensões reais são lidas do cabeçalho JPEG/PNG pelo relay; não são aceitas
  dimensões declaradas divergentes;
- `width` e `height` declarados e reais devem ser inteiros positivos e menores ou
  iguais a `MAX_IMAGE_DIMENSION` (500px por padrão);
- o JSON do conteúdo com imagem não pode passar de `MAX_IMAGE_CONTENT_SIZE`
  (128 KiB por padrão), e o bloco completo continua limitado por
  `MAX_BLOCK_SIZE`;
- imagens só são renderizadas pelo cliente; o relay não gera thumbnails nem
  converte formatos.

O cliente deve reduzir a foto antes de assinar. `onpostt.prepareImage` usa
canvas no navegador, limita o maior lado a 500px, converte para JPEG e tenta
qualidades menores até ficar abaixo de 64 KiB (margem de segurança em relação
ao limite do relay). O exemplo completo está no
[`README`](../README.md#fotos-em-posts).

#### 5.1.2 Tópicos

Tópicos são metadados opcionais e públicos do post. O formato canônico é um
array de até cinco slugs em `content.topics`:

```json
{
  "mode": "post",
  "query": [],
  "app": "meu-app",
  "content": {
    "text": "publicação com tópicos",
    "topics": ["onpostt", "seguranca"]
  }
}
```

Cada slug:

- tem de 1 a 50 caracteres;
- usa letras minúsculas `a-z`, números `0-9`, ponto, hífen ou sublinhado;
- começa e termina com letra ou número;
- não se repete no mesmo post;
- não contém caracteres de controle.

O cliente normaliza a entrada do usuário antes de assinar (remove `#`, aplica
minúsculas, remove acentos e troca espaços por hífen). O relay **não reescreve**
conteúdo assinado: ele só aceita slugs já canônicos em `content.topics`. Tópicos
são criados implicitamente pelo primeiro post que os usa; não há bloco ou tabela
de tópico. Para leitura, o filtro de topo `topic` compara `content.topics` e o
fallback `query: [["topic", "slug"]]`.

### 5.2 `profile`

Perfil público. `query` é livre (por exemplo `[["name", "Ana"]]`). Nas consultas,
o relay retorna apenas o **último** bloco `profile` de cada `pubkey`.

O conteúdo recomendado é:

```json
{
  "name": "Ana",
  "bio": "Uma frase sobre mim",
  "image": {
    "mime": "image/jpeg",
    "data": "<base64 sem prefixo data:>",
    "width": 150,
    "height": 150
  }
}
```

`image` é opcional. Quando existe, o objeto aceita apenas `name`, `bio` e
`image`, e a foto passa pelas mesmas regras de bytes, magic bytes, dimensões
reais e limites do post. O limite de protocolo para imagens é 500px, mas o
cliente de perfil deve preparar a foto com **150px no maior lado**, mostrar a
prévia ao importar e gravar a base64 canônica devolvida por
`onpostt.prepareImage(file, { maxDimension: 150 })`. Salvar o perfil sem `image`
remove a foto anterior.

### 5.3 `follow` (toggle)

Query obrigatória e exata:

```json
[["follower", "<pubkey do autor>"], ["following", "<pubkey alvo>"]]
```

Regras:

- `follower` deve ser igual à `pubkey` do autor;
- `following` deve ser uma pubkey válida;
- não é permitido seguir a si mesmo;
- o primeiro envio cria a relação; um novo bloco com a mesma query remove;
- cada envio deve ser um bloco novo (novo id).

### 5.4 `block` (toggle)

Query obrigatória e exata:

```json
[["blocker", "<pubkey do autor>"], ["blocked", "<pubkey alvo>"]]
```

Regras:

- `blocker` deve ser igual à `pubkey` do autor;
- `blocked` deve ser uma pubkey válida e diferente do autor;
- o primeiro envio cria o bloqueio; um novo bloco com a mesma query remove;
- cada envio deve ser um bloco novo (novo id);
- enquanto o bloqueio existir, mensagens entre as duas pubkeys são rejeitadas
  nos dois sentidos, antes de qualquer cópia para a caixa de entrada;
- bloqueio e envio de mensagem usam o mesmo lock transacional por par de
  pubkeys, evitando corrida entre bloquear e enviar;
- leituras com token `reader` escondem, nas duas direções, perfis, posts,
  comentários, notificações, mensagens e demais blocos dos envolvidos;
- leituras anônimas escondem autores que participam de qualquer bloqueio ativo,
  para evitar bypass por omissão do token;
- o próprio bloco `block` continua legível para a interface detectar o estado;
- uma identidade nova (outra chave privada) não herda o bloqueio; ver a
  limitação de Sybil no fim desta seção.

### 5.5 `like` (toggle)

Query obrigatória e exata: `[["block", "<id alvo>"]]`.

- o alvo precisa existir e não estar excluído para criar a curtida;
- se a curtida já existe, o envio remove (mesmo que o alvo tenha sido
  excluído depois);
- o autor da curtida é a `pubkey` do bloco;
- `content` é opcional.

### 5.6 `reaction` (toggle)

Query obrigatória e exata:

```json
[
  ["block", "<id alvo>"],
  ["reaction", "🔥"]
]
```

- o emoji deve ter de 1 a 32 code points, sem caracteres de controle e sem ser
  composto apenas de espaços;
- o toggle é por autor + alvo + emoji: a mesma pessoa pode usar emojis
  diferentes no mesmo bloco;
- o alvo precisa existir e não estar excluído para criar a reação;
- remover uma reação antiga é permitido mesmo que o alvo tenha sido excluído
  depois;
- `content` é opcional.

### 5.7 `comment`

Query: `[["block", "<id alvo>"]]` e, opcionalmente,
`["parent", "<id do comentário pai>"]`.

- `content` deve ser string (texto);
- o alvo precisa existir e não estar excluído;
- o pai, quando presente, precisa ser um bloco `comment` existente, do mesmo
  alvo, e não pode ter sido excluído;
- o pai não pode ser igual ao bloco alvo;
- respostas podem responder a respostas, formando uma árvore.

Comentário:

```json
{
  "mode": "comment",
  "query": [["block", "<id do post>"]],
  "content": "meu comentário",
  "app": "meu-app"
}
```

Resposta:

```json
{
  "mode": "comment",
  "query": [
    ["block", "<id do post>"],
    ["parent", "<id do comentário>"]
  ],
  "content": "minha resposta",
  "app": "meu-app"
}
```

### 5.8 `delete`

Query obrigatória e exata: `[["block", "<id alvo>"]]`.

- somente o autor do bloco alvo pode criar o tombstone;
- o alvo precisa existir e não pode ser um `delete`;
- `content` é opcional; a biblioteca grava
  `Block [<id>] has been marked as deleted.`;
- `app` é opcional;
- o bloco não é removido fisicamente; consultas ocultam o alvo.

### 5.9 `notification`

Notificação de uma interação já aceita. Query obrigatória e exata:

```json
[
  ["to", "<pubkey do dono do bloco alvo>"],
  ["block", "<id do bloco alvo>"],
  ["interaction", "<id do bloco like/reaction/comment/repost/follow>"],
  ["kind", "like"]
]
```

`kind` é `like`, `reaction`, `comment`, `repost` ou `follow`. O bloco não tem
`content` e `app` é obrigatório. A `pubkey` do bloco é o ator da interação; `to`
é o destinatário.

Regras de gravação:

- `to` precisa ser pubkey válida, dona do bloco alvo e diferente do autor;
- o bloco alvo precisa existir e não pode ser um `delete`;
- a interação precisa existir, ter sido assinada pelo mesmo autor da
  notificação, ter `mode` igual a `kind` e apontar para o mesmo `block`;
- alvo e interação não podem ter tombstone;
- só pode existir uma notificação para cada interação;
- o relay não cria notificações automaticamente: o cliente envia o bloco depois
  que a curtida, reação, comentário, repost ou follow for aceito.

Para `kind: "follow"`, `block` e `interaction` apontam para o **próprio bloco
`follow`**, `to` deve ser igual a `following` e o autor do `follow` deve ser o
`follower`. Não há bloco alvo separado. Desfazer o follow remove o bloco e a
notificação deixa de aparecer nas consultas.

A notificação é um bloco público e imutável. Consultas de `notification`
ocultam resultados cuja interação ou bloco alvo não existe mais ou recebeu
tombstone. O estado de lida é registrado por `notification_read`, sem alterar
a notificação original.

### 5.10 `notification_read`

Recibo de leitura de notificações. Query exata `[]` e conteúdo:

```json
{ "read": ["<id da notificação>", "..."] }
```

- `app` é obrigatório e o transporte é HTTP;
- `read` deve ter de 1 a 500 ids válidos, sem duplicatas;
- cada id precisa existir como `notification` e ter `to` igual à `pubkey` do
  autor do recibo;
- o recibo guarda apenas ids, nunca o texto da notificação;
- consultas exigem `pubkey` ou `id` para evitar varredura global.

### 5.11 `message`

Query obrigatória e exata:

```json
[["from", "<pubkey do autor>"], ["to", "<pubkey do destinatário>"]]
```

Regras:

- `from` deve ser igual à `pubkey` do autor;
- `to` deve ser uma pubkey válida;
- `content` deve ser o envelope cifrado (objeto ou string JSON);
- transporte preferencial: WebSocket;
- `POST /save_block` também aceita `message`.

Formato do envelope:

```json
{
  "forRecipient": {
    "ciphertext": "hex (AES-256-GCM, tag incluída)",
    "iv": "24 hex (12 bytes)",
    "senderPubKey": "pubkey efêmera comprimida"
  },
  "forSender": {
    "ciphertext": "hex",
    "iv": "24 hex",
    "senderPubKey": "pubkey efêmera comprimida"
  }
}
```

Pelo menos um dos envelopes é obrigatório. Na prática a biblioteca envia os
dois para permitir que remetente e destinatário releiam a mensagem.

#### Conteúdo de mídia (convenção do cliente)

O relay não interpreta o texto decifrado. A demo usa JSON dentro do envelope:

```json
{
  "text": "legenda opcional",
  "image": {
    "mime": "image/jpeg",
    "data": "<base64>",
    "width": 500,
    "height": 320
  }
}
```

```json
{
  "text": "",
  "audio": {
    "mime": "audio/webm",
    "data": "<base64>",
    "duration": 15
  }
}
```

Imagens são redimensionadas para no máximo 500px e comprimidas antes de entrar
no envelope. Áudios são gravados com limite de 15 segundos. Os limites de
`MAX_CONTENT_SIZE` e `MAX_BLOCK_SIZE` precisam acomodar o envelope cifrado
(resultado maior que o base64 original); o relay continua sem ver o conteúdo.

### 5.12 `message_read`

Recibo de leitura de conversas. Query exata `[]` e conteúdo:

```json
{ "read": ["<id lógico da mensagem>", "..."] }
```

- `app` é obrigatório e o transporte é HTTP;
- `read` deve ter de 1 a 500 ids válidos, sem duplicatas;
- use o id lógico da mensagem: a cópia interna `"<id>_rcp"` não é aceita;
- cada id precisa existir como `message` e ter `to` igual à `pubkey` do autor
  do recibo;
- o recibo guarda apenas ids, nunca o texto nem o envelope cifrado;
- consultas exigem `pubkey` ou `id` para evitar varredura global;
- abrir uma conversa no cliente marca apenas as mensagens recebidas daquela
  pubkey; mensagens recebidas com a conversa ativa não geram não lidas.

---

## 6. Cifragem de mensagens

Algoritmo usado pela biblioteca oficial:

1. Gerar um par secp256k1 **efêmero por envio**.
2. Para cada destinatário (recipiente e remetente):
   - ECDH entre a chave privada efêmera e a pubkey do participante;
   - converter o ponto compartilhado para hexadecimal;
   - `key = SHA-256(UTF-8(hex do segredo compartilhado))`;
   - gerar IV aleatório de 12 bytes;
   - cifrar o texto UTF-8 com AES-256-GCM.
3. Publicar `ciphertext`, `iv` e a pubkey efêmera em `senderPubKey`.
4. Para descriptografar:
   - ECDH entre a chave privada do participante e `senderPubKey`;
   - mesma derivação;
   - AES-256-GCM com o IV e o ciphertext recebidos.

Propriedades:

- o relay não consegue ler o texto;
- cada envio usa uma chave efêmera, então o ciphertext muda mesmo para o mesmo
  texto;
- não há ratchet: o histórico é legível com a chave privada do participante.

### Armazenamento

Para uma mensagem `id`, o relay grava:

| Linha | `id` | `pubkey` | Significado |
| --- | --- | --- | --- |
| original | `<id>` | `from` | caixa de saída do remetente |
| cópia | `<id>_rcp` | `to` | caixa de entrada do destinatário |

Em conversa consigo mesmo, a cópia não é criada. Consultas por conversa sem
`pubkey` limitam-se à linha original para não duplicar; consultas por `pubkey`
encontram a linha correspondente.

---

## 7. Query

`query` é um array de pares `[chave, valor]`.

```json
[
  ["topic", "onpostt"],
  ["lang", "pt-BR"]
]
```

Regras de gravação:

- no máximo 32 pares;
- chaves únicas;
- chave com 1–64 caracteres, válida em `[A-Za-z0-9_.:-]`;
- valores apenas string, número finito ou booleano;
- string de valor com até 2048 caracteres;
- chaves `privatekey`, `__proto__`, `constructor` e `prototype` são proibidas;
- `post` e `profile` aceitam qualquer par válido;
- os demais modos aceitam apenas as chaves declaradas na tabela de modos.

A consulta SQL usa contenção JSONB (`query @> '[[chave, valor]]'`), com todos
os valores parametrizados. Nada é interpolado.

---

## 8. Filtros de leitura

Filtro aceito por `POST /get_blocks_list` e por assinaturas WebSocket:

| Campo | Tipo | Descrição |
| --- | --- | --- |
| `mode` | string | obrigatório; um dos modos |
| `pubkey` | string | autor (ou participante, em `message`) |
| `query` | array | pares que o bloco deve conter |
| `topic` | string | tópico canônico; somente em `mode: "post"` |
| `since` | inteiro | `created_at >= since` (inclusivo) |
| `until` | inteiro | `created_at <= until` (inclusivo) |
| `app` | string | aplicação exata |
| `id` | string | id exato |
| `limit` | inteiro | 1..`MAX_BLOCKS_PER_REQUEST` (padrão 1000) |
| `offset` | inteiro | 0..1.000.000 |

Campos desconhecidos e `privatekey` são rejeitados (inclusive em pares de
`query`). `since > until` é erro. Respostas acima de `MAX_RESPONSE_BYTES`
voltam com `truncated: true`; use `offset` para a próxima página. Os campos
`pubkey`, `from` e `to` do filtro são comparados sem diferenciar maiúsculas de
minúsculas. Para filtrar reações, use
`query: [["block", id], ["reaction", "🔥"]]`. O campo `topic` é normalizado para
o slug canônico e corresponde a `content.topics` ou ao fallback
`query: [["topic", slug]]`.

### Autenticação de leitura (`reader`)

O filtro em si não contém `reader`. No HTTP, `reader` é um campo irmão do filtro
no corpo; no WebSocket, é irmão de `filter` na mensagem `get_blocks_sub`.

```json
{
  "viewer": "<pubkey>",
  "created_at": 1760000000,
  "sig": "<assinatura DER hex>"
}
```

A mensagem assinada é exatamente:

```text
onpostt-read-v1:<viewer em minúsculas>:<created_at>
```

Regras:

- `viewer` precisa ser pubkey secp256k1 válida e a assinatura precisa
  corresponder a ela;
- `created_at` é Unix em segundos; o token vale por
  `READER_TOKEN_TTL_SECONDS` (padrão: 30 dias) e tolera pequeno skew futuro;
- o token concede apenas leitura; ele não assina blocos nem altera estado;
- com token, o relay esconde conteúdo quando leitor e autor se bloquearam em
  qualquer direção;
- sem token, o relay esconde conteúdo de autores que participam de qualquer
  bloqueio ativo;
- blocos `block` ficam fora do filtro de visibilidade para a interface detectar
  o estado;
- a mesma verificação é aplicada na página inicial e em cada bloco ao vivo de
  uma assinatura WebSocket; erro de banco na checagem ao vivo falha fechado.

**Limitação Sybil.** O token prova posse de uma chave, não identidade humana.
Uma pessoa bloqueada pode criar outra chave e consultar como outra pubkey. O
protocolo não tem registro central de unicidade; esse limite é inerente ao
modelo local-first e só seria resolvido com um provedor externo de identidade.

### Mensagens

Filtros de `message` exigem ao menos uma restrição:

- `pubkey` (remetente **ou** destinatário), ou
- os pares `from` e `to`, ou
- `id`.

Sem isso, um cliente poderia varrer metadados de todas as conversas.

### Notificações

Filtros de `notification` exigem o par `query: [["to", "<pubkey>"]]` ou o campo
`id`. `to` é comparado sem diferenciar maiúsculas de minúsculas; `pubkey`
filtra pelo ator. Também são aceitos os pares `block`, `interaction` e `kind`,
desde que os valores sejam válidos.

O resultado só inclui notificações enquanto a interação e o bloco alvo
existirem e não tiverem tombstone. Assim, descurtir, remover uma reação,
desfazer um repost/follow ou excluir um comentário/post faz a notificação
desaparecer sem apagar o bloco imutável. Notificações de follow são validadas
pelo próprio bloco `follow` e pelo par `following`/`to`.

### Bloqueios

Filtros de `block` usam os pares `query: [["blocker", "<pubkey>"]]`,
`query: [["blocked", "<pubkey>"]]` ou ambos. A leitura de metadados `block`
continua pública para que qualquer cliente detecte o estado. A presença de um
bloco `block` ativo também é consultada antes de aceitar mensagens nos dois
sentidos; um novo toggle com a mesma query remove o bloqueio. A página de perfil
do demo consulta os dois sentidos para decidir se mostra o perfil, o botão
**Bloquear**/**Desbloquear** ou a seção **Perfil indisponível**.

### Ordenação e deduplicação

- Ordenação: `created_at DESC, id DESC`.
- `profile`: último bloco por `pubkey`, depois paginação.
- `notification`: uma linha por interação; não há deduplicação por alvo.
- A biblioteca deduplica por id lógico (remove o sufixo `_rcp`).
- O servidor deduplica por assinatura no fan-out em tempo real.

### Tombstones

Um `delete` do próprio autor oculta o alvo em todas as consultas. A cópia de
mensagem `<id>_rcp` também é ocultada quando o id original é excluído. A
verificação de autoria usa o remetente correto em mensagens. Notificações
também deixam de aparecer quando a interação referenciada ou o bloco alvo é
removido.

---

## 9. Transporte

### HTTP

- `POST /save_block` — grava qualquer modo válido por HTTP, inclusive `block`.
- `POST /get_blocks_list` — consulta.
- `GET /api/trending` — ranking de tópicos em posts recentes.
- `Content-Type: application/json` obrigatório.
- Corpo máximo: `HTTP_MAX_MESSAGE_SIZE` (padrão 2 MiB).

### WebSocket

- Mesmo host/porta do HTTP.
- `Origin` validado no upgrade.
- Apenas `message` pode ser gravada pelo socket.
- Assinaturas (`get_blocks_sub`) recebem blocos iniciais e ao vivo.
- Heartbeat ping/pong do servidor e `ping`/`pong` da aplicação.

Detalhes de mensagens e erros em [`API.md`](API.md).

---

## 10. Limites padrão

| Limite | Padrão |
| --- | --- |
| Bloco completo | 2 MiB |
| `content` (texto/objeto comum ou envelope cifrado) | 1 MiB |
| Corpo HTTP | 2 MiB |
| JSON de conteúdo com imagem em post | 128 KiB |
| Imagem decodificada em post | 72 KiB |
| Dimensão de imagem | 500px no maior lado |
| Áudio do demo (cliente) | 15s e base64 ≤ 180000 caracteres |
| Campos no bloco | 32 |
| Pares de `query` | 32 |
| Chave de `query` | 64 caracteres |
| Valor de `query` | 2048 caracteres |
| `app` | 190 caracteres |
| `reaction` | 32 code points |
| `created_at` no futuro | 600 s |
| Blocos por consulta | 1000 |
| Bytes por resposta de listagem/assinatura | 8 MiB |
| Assinaturas por conexão | 25 |
| Pubkeys por conexão | 5 |
| Payload WebSocket | 1 MiB |

Todos são configuráveis por ambiente. Veja `env.example`.

---

## 11. Idempotência e replay

O relay insere o id em `processed_blocks` dentro da mesma transação que aplica
o efeito. Se o id já existe:

```json
{
  "status": "success",
  "action": "duplicate",
  "id": "...",
  "mode": "like",
  "message": "Bloco ... já processado."
}
```

Nada é criado, removido ou transmitido. Isso é essencial para toggles: sem essa
proteção, reenviar um `like` antigo alternaria a curtida.

Um `like`, `reaction`, `follow` ou `block` novo (com novo `id`) ainda pode
remover a relação. O cliente deve sempre assinar um bloco novo para cada ação.

`notification` não é toggle. Uma segunda notificação para a mesma interação,
mesmo com outro `id`, é rejeitada com `notification_duplicate`.
