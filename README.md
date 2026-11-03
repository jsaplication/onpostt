# onpostt

Relay HTTP/WebSocket para o protocolo **onpostt**: blocos JSON assinados com
secp256k1, consultas por filtros, tópicos com ranking de trending, reações,
comentários com respostas, notificações de interação e de novos seguidores,
perfis públicos com foto, bloqueio/desbloqueio de usuários, fotos em base64 e
mensagens diretas cifradas de ponta a ponta.

O projeto é construído com **segurança em primeiro lugar**:

- a chave privada nunca sai do cliente;
- todo bloco é verificado por assinatura e id canônico;
- bloqueios são aplicados também na leitura: o relay autentica o leitor por um
  token assinado e filtra perfis, posts, notificações e mensagens;
- operações com estado são idempotentes e protegidas contra replay;
- entradas, payloads, conexões e taxa são limitados;
- o relay não depende de CDN, telemetria ou segredos no código.

Requisitos: **Node.js 20+** e **PostgreSQL 13+**.

---

## O que é

Um relay onpostt guarda **blocos assinados** e os entrega a aplicativos:

| Camada | Responsabilidade |
| --- | --- |
| Cliente / biblioteca | gera chaves localmente, assina e cifra mensagens |
| Relay | valida assinatura/id/regras, grava, consulta e faz fan-out |
| PostgreSQL | blocos imutáveis, índices e controle de idempotência |
| WebSocket | assinaturas em tempo real e envio de mensagens |

O relay **nunca precisa da chave privada** de um usuário. Conteúdo de `post`,
`profile`, `comment`, `like`, `reaction`, `follow`, `block`, `notification` e
`delete` é público, mas consultas de leitura aplicam as relações de bloqueio
ativas. Fotos de `post` viajam como base64 dentro do bloco assinado. Apenas o
conteúdo de `message` é cifrado no cliente e permanece cifrado no banco.

### Páginas servidas

| Rota | Conteúdo |
| --- | --- |
| `/` | dashboard: protocolo, porta, modos, conexões, banco e métricas |
| `/doc.html` | documentação do protocolo e da biblioteca |
| `/demo/` | demo com feed global/seguindo, tópicos e trending lateral, fotos, reposts, perfis, notificações de interação e de follow com “Seguir de volta”, follows, bloqueio/desbloqueio, likes, reações em posts, curtidas/descurtidas em comentários, respostas, chat com imagem/áudio, indicadores de não lidas e remoção local de conversa; exige sessão local |
| `/login.html` | entrada por chave privada ou cofre `.json` cifrado |
| `/cadastro.html` | criação de identidade local, cofre cifrado e sessão persistente |
| `/perfil.html?pubkey=...` | perfil público: foto, nome, bio, publicações, reposts feitos, reações em posts, curtidas/descurtidas em comentários, comentários, seguidores e ações de seguir/seguir de volta/deixar de seguir e bloquear/desbloquear |
| `/onpostt.min.js` | biblioteca oficial (elliptic incluído) |
| `/health` | health check para orquestradores |
| `/api/status` | snapshot público de status |

A demo aceita `?view=feed`, `?view=profiles`, `?view=notifications`,
`?view=chat` e `?view=about` para abrir direto em uma seção, além de
`?topic=<slug>` para abrir o feed filtrado por um tópico. A página de perfil
também responde em `/perfil`, `/profile` e `/profile.html`, redirecionando para
`/perfil.html` e preservando a query string. Entrada e cadastro respondem em
`/entrar` e `/login`, e em `/cadastro`, `/registrar` e `/signup`, preservando a
query string.

No feed, a aba **Global** mostra posts e reposts de todos; a aba **Seguindo**
mostra posts de quem você segue e reposts feitos por você ou por quem você
segue. Um repost aparece como cartão próprio, com avatar e nome de quem
repostou, tanto no feed quanto no perfil de quem o fez; o cartão também carrega
o avatar e o nome do autor original, com fallback para as iniciais da pubkey.

Cada post pode ter até cinco tópicos, exibidos como chips clicáveis. A lateral
direita do feed mostra os tópicos em alta dos últimos sete dias, com a
quantidade de posts distintos e o horário da publicação mais recente. Clicar em
um chip ou em um item da lateral abre o feed filtrado; o botão **Limpar** volta
ao feed normal. Qualquer identidade pode criar um tópico simplesmente publicando
com ele.

---

## Arquitetura

```text
┌──────────────────────┐
│ Usuário              │
│ chave privada local  │
└──────────┬───────────┘
           │ assina / cifra
           ▼
┌──────────────────────┐        ┌──────────────────────┐
│ Cliente / app        │───────▶│ Relay                │
│ (biblioteca onpostt) │  HTTP  │ valida + grava       │
└──────────────────────┘        └──────────┬───────────┘
           │                                │
           │ WebSocket                      ▼
           │                     ┌──────────────────────┐
           └────────────────────▶│ PostgreSQL           │
                                  │ blocks               │
                                  │ processed_blocks     │
                                  └──────────┬───────────┘
                                             │
                                             ▼
                                  ┌──────────────────────┐
                                  │ WebSocket fan-out    │
                                  │ por filtro           │
                                  └──────────────────────┘
```

Vários relays podem operar de forma independente (ou compartilhar o mesmo
banco). O cliente escolhe os hosts; a biblioteca agrega respostas e deduplica
por id.

---

## Início rápido

### 1. Instalar

```bash
npm install
```

No Windows, se a política de execução bloquear `npm.ps1`, use `npm.cmd`.

### 2. Configurar

```bash
cp env.example .env
```

Edite `.env` e ajuste pelo menos:

```dotenv
NODE_ENV=development
PORT_HTTP=3000
HOST_ALLOWED=http://localhost:3000,http://127.0.0.1:3000
PGHOST=localhost
PGPORT=5432
PGUSER=postgres
PGPASSWORD=sua-senha
PGDATABASE=onpostt
```

> `.env` está no `.gitignore`. Nunca versione senhas, chaves ou strings de
> conexão. `env.example` contém apenas valores de exemplo.

### 3. Criar o schema

```bash
npm run db:init
```

O script aplica `database/schema.sql` e é idempotente. Alternativa manual:

```bash
psql "postgres://usuario:senha@localhost:5432/onpostt" -f database/schema.sql
```

### 4. Subir o relay

```bash
npm start
```

Abra <http://localhost:3000/>. A dashboard mostra o nome do protocolo
(`onpostt`), a porta, os modos suportados, as conexões e a saúde do banco.

Para desenvolvimento com recarga automática:

```bash
npm run dev
```

### 5. Testar

```bash
npm test          # crypto, protocolo, filtros e biblioteca
npm run check     # checagem de sintaxe dos arquivos principais
```

Os testes não precisam de banco.

---

## O protocolo em 30 segundos

Um bloco é um objeto JSON assinado:

```json
{
  "pubkey": "03...66-hex...",
  "created_at": 1760000000,
  "mode": "post",
  "query": [["topic", "onpostt"]],
  "content": "primeiro post",
  "app": "meu-app",
  "id": "9f2c...64-hex...",
  "sig": "3045...der..."
}
```

- `id = sha256(JSON.stringify(bloco sem id e sem sig))`
- `sig = secp256k1.sign(sha256(JSON.stringify(bloco sem sig))).toDER('hex')`
- A ordem das propriedades importa, porque a serialização é `JSON.stringify`.
- A biblioteca monta: `pubkey, created_at, mode, query, content, app`, campos
  extras, `id`, `sig`.

### Modos

| Modo | Transporte | Query | Conteúdo | Regras principais |
| --- | --- | --- | --- | --- |
| `post` | HTTP | livre | obrigatório | texto ou `{ text, image?, topics? }`; fotos até 500px; até 5 tópicos |
| `profile` | HTTP | livre | obrigatório | `{ name, bio, image? }`; último perfil por pubkey; foto preparada para 150px |
| `follow` | HTTP | `follower`, `following` | opcional | toggle; `follower` = autor; sem auto-follow |
| `block` | HTTP | `blocker`, `blocked` | opcional | toggle de bloqueio; `blocker` = autor; sem auto-bloqueio |
| `like` | HTTP | `block` | opcional | toggle por autor/alvo |
| `reaction` | HTTP | `block`, `reaction` | opcional | toggle por autor/alvo/emoji |
| `comment` | HTTP | `block` + `parent` opcional | obrigatório | comentário ou resposta |
| `repost` | HTTP | `block` | opcional | toggle por autor/alvo |
| `notification` | HTTP | `to`, `block`, `interaction`, `kind` | proibido | derivada de uma interação real; uma por interação |
| `notification_read` | HTTP | `[]` | obrigatório | `{ read: [ids] }`; só notificações da própria pubkey |
| `message` | WebSocket | `from`, `to` | obrigatório | envelope cifrado; `from` = autor |
| `message_read` | HTTP | `[]` | obrigatório | `{ read: [ids] }`; só mensagens recebidas pela própria pubkey |
| `delete` | HTTP | `block` | opcional | tombstone; somente o autor do alvo |

`like`, `reaction`, `repost`, `follow`, `block` e `delete` podem omitir
`content`. `post`, `profile`, `comment`, `notification_read`, `message` e
`message_read` exigem conteúdo. `notification` não aceita `content`: o texto e o
ator vêm do bloco de interação referenciado. A biblioteca adiciona um `nonce`
aleatório a `like`, `reaction`, `repost`, `follow` e `block` para que duas ações
no mesmo segundo tenham ids diferentes. Os recibos de leitura guardam apenas
ids; nunca transportam o texto de mensagens.

### Tópicos e trending

Tópicos não são um modo novo. Eles são metadados opcionais do bloco `post`,
gravados em `content.topics` como slugs canônicos (minúsculos, 1–50 caracteres,
letras, números, ponto, hífen ou sublinhado). O relay valida cada item e aceita
no máximo cinco por post. O primeiro post que usa um tópico o cria; não existe
tabela nem bloco separado de tópico.

```js
const post = await onpostt.signBlock(
  {
    mode: 'post',
    query: [],
    content: {
      text: 'primeiro post com tópicos',
      topics: ['onpostt', 'seguranca'],
    },
    app: 'meu-app',
  },
  privateKey
);
await onpostt.sendBlock(post);

// Listar posts de um tópico (content.topics ou query.topic legado)
const posts = await onpostt.list({
  mode: 'post',
  app: 'meu-app',
  topic: 'onpostt',
  limit: 100,
});
```

`GET /api/trending?app=meu-app&limit=10&window=604800` agrega os posts recentes
e retorna `{ response: "trending", topics: [{ topic, count, latestAt }] }`.
`window` é em segundos, entre 1 hora e 30 dias (padrão: 7 dias). A contagem é de
posts distintos por tópico; posts com tombstone do autor não entram. O desempate
é pelo post mais recente. O fallback documentado `query: [["topic", "slug"]]`
continua aceito para leitura e também alimenta o ranking.

### Ações sociais

```js
// Curtir/descurtir (toggle)
await onpostt.sendBlock(
  await onpostt.signBlock(
    { mode: 'like', query: [['block', postId]], app: 'meu-app' },
    privateKey
  )
);

// Reagir/remover reação em um post ou comentário (toggle por emoji)
await onpostt.sendBlock(
  await onpostt.signBlock(
    {
      mode: 'reaction',
      query: [
        ['block', postId],
        ['reaction', '🔥'],
      ],
      app: 'meu-app',
    },
    privateKey
  )
);

// Comentar
const comment = await onpostt.signBlock(
  {
    mode: 'comment',
    query: [['block', postId]],
    content: 'meu comentário',
    app: 'meu-app',
  },
  privateKey
);
await onpostt.sendBlock(comment);

// Responder a um comentário
await onpostt.sendBlock(
  await onpostt.signBlock(
    {
      mode: 'comment',
      query: [
        ['block', postId],
        ['parent', comment.id],
      ],
      content: 'minha resposta',
      app: 'meu-app',
    },
    privateKey
  )
);
```

O mesmo toggle de `reaction` vale para comentários: use o id do comentário em
`query.block`. No demo, comentários exibem apenas 👍/👎 e escolher uma reação
remove a oposta do mesmo autor.

### Notificações

Uma notificação é um bloco assinado que aponta para uma interação já aceita. O
ator é a `pubkey` do bloco; o destinatário é `to`; o alvo é `block`; a interação
é `interaction`; e `kind` é `like`, `reaction`, `comment`, `repost` ou `follow`.
O bloco não tem `content`.

```js
const notification = await onpostt.signBlock(
  {
    mode: 'notification',
    query: [
      ['to', ownerPubkey],
      ['block', postId],
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

O relay só grava se todas as condições abaixo forem verdadeiras:

- `to` é o dono do bloco alvo e é diferente do autor;
- a interação existe, foi assinada pelo mesmo autor da notificação e aponta para
  o mesmo `block`;
- o modo da interação é igual a `kind`;
- alvo e interação não têm tombstone;
- ainda não existe notificação para essa interação.

Para `kind: "follow"` não existe um bloco alvo separado: `block` e `interaction`
apontam para o **próprio bloco `follow`**. O relay exige que `to` seja igual a
`following` e que o autor do `follow` seja o seguidor. Ao desfazer o follow, o
bloco é removido pelo toggle e a notificação deixa de aparecer nas consultas.

A notificação é imutável e pública, mas consultas a ocultam quando a interação
ou o bloco alvo deixa de existir (por exemplo, após descurtir ou excluir). O
estado de lida é registrado em blocos `notification_read` assinados pelo
destinatário e também mantido em `localStorage` para resposta imediata. O bloco
original nunca é alterado.

Para listar as notificações de uma pubkey, o filtro precisa do par `to` ou de
`id`; `to` é comparado sem diferenciar maiúsculas de minúsculas:

```js
const notifications = await onpostt.list({
  mode: 'notification',
  app: 'meu-app',
  query: [['to', ownerPubkey]],
  limit: 50,
});
```

A demo mostra o contador de não lidas, o texto contextual em português, o
trecho do bloco e as ações de marcar como lidas e limpar as lidas. Notificações
de follow exibem **Seguir de volta**; quando a pessoa já é seguida, a ação some.
O exemplo executável está em [`examples/social-actions.js`](examples/social-actions.js).

### Perfil público

`/perfil.html?pubkey=<pubkey>` abre o perfil público de qualquer pubkey, com
foto, nome, bio, publicações (incluindo fotos), reposts, curtidas, reações,
comentários, seguidores e seguindo. A leitura cruza aplicações, mas respeita
bloqueios: sem identidade autenticada, autores que participam de um bloqueio
ativo ficam ocultos; com identidade, o relay aplica a relação entre leitor e
autor. A demo continua limitada ao app `onpostt-demo`. Sem `pubkey`, a página
abre o perfil da identidade local quando houver uma.

Quando a sessão tem uma identidade com chave privada, o perfil de outra pubkey
mostra o botão **Seguir** / **Seguir de volta** / **Deixar de seguir**. A ação
publica um bloco `follow` assinado com `follower` igual à identidade local e
`following` igual à pubkey do perfil, atualiza o contador de seguidores e
persiste no relay. **Seguir de volta** aparece quando a pessoa do perfil já segue
a identidade local e ainda não é seguida de volta. O botão não aparece no próprio
perfil nem sem chave privada.

### Bloqueio de usuário

O modo `block` é um toggle assinado pelo bloqueador:

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
await onpostt.sendBlock(block);
```

A primeira publicação cria o bloqueio; repetir a mesma query remove (desbloqueia).
O relay recusa mensagens nos dois sentidos enquanto existir um bloqueio ativo
entre remetente e destinatário, usando o mesmo lock transacional para bloquear e
enviar. Na demo, o perfil de quem bloqueou mostra **Bloquear** / **Desbloquear**;
quem foi bloqueado vê uma seção **Perfil indisponível** em vez do perfil, e o
cliente também oculta posts, notificações e conversas desse usuário.

O bloqueio é aplicado no servidor também na leitura. A biblioteca assina um
token de leitura de curta duração com a chave privada local e o envia no campo
`reader`; o relay usa a pubkey provada para esconder, nas duas direções, perfis,
posts, comentários, notificações, mensagens e demais blocos dos envolvidos.
Consultas sem token continuam públicas, mas o relay adota um critério
conservador: esconde conteúdo de autores que participam de qualquer bloqueio
ativo. Assim, um usuário bloqueado não contorna a regra simplesmente omitindo o
token. Eventos WebSocket também passam pela mesma verificação antes da entrega.

```js
await onpostt.setReaderKey(myPrivateKey); // assina o token automaticamente
const perfis = await onpostt.list({ mode: 'profile', limit: 20 });
```

O bloco `block` em si continua legível para que a interface detecte o estado e
mostre **Perfil indisponível** ou **Desbloquear**. A recusa de mensagens também é
feita no servidor e vale para qualquer cliente. O token de leitura é um
credencial de leitura: quem o obtiver pode ler como aquela pubkey, mas não
assinar blocos nem alterar dados.

**Limitação Sybil:** uma pessoa bloqueada pode gerar uma nova chave privada e
aparecer como outra identidade. O relay não tem prova de identidade civil nem
registro central que ligue pubkeys à mesma pessoa. Sem um provedor externo de
unicidade, esse limite é inerente ao modelo de chaves. O bloqueio protege o
perfil e as publicações contra a identidade bloqueada e contra leitura anônima,
não contra uma identidade nova.

Os cartões de repost exibem o perfil normal do autor original (foto e nome,
com fallback para iniciais/pubkey) tanto na página de perfil quanto no feed. No
feed, a faixa de atribuição também mostra a foto e o nome de quem repostou.

No demo, os cartões de perfil e a área do autor de cada publicação levam à
página de perfil. As rotas `/perfil`, `/profile` e `/profile.html` redirecionam
para `/perfil.html` preservando a query string.

### Identidade local, cofre e sessão

O relay **não tem conta de usuário**. O `username` do cadastro é apenas o nome
exibido no perfil; a identidade é a pubkey. "Entrar" significa desbloquear, no
navegador, a chave privada que assina os blocos. Não há username único, e-mail de
recuperação nem redefinição de senha no servidor.

O cadastro em `/cadastro.html`:

- gera um par secp256k1 no navegador;
- valida o username (3–40 caracteres, sem controles ou `/\?%*:|"<>`) e a senha
  (mínimo de 10 caracteres);
- cria um cofre `.json` com `format: "onpostt.identity.vault"`;
- deriva a chave com PBKDF2-SHA-256 e 600.000 iterações, salt de 16 bytes;
- cifra o conteúdo com AES-256-GCM e IV de 12 bytes;
- usa AAD para vincular formato, username, pubkey e `createdAt` ao ciphertext;
- inclui a chave privada somente dentro do ciphertext, nunca em texto puro;
- oferece o download do cofre e guarda a identidade na sessão.

O cadastro e o login local usam WebCrypto e exigem **HTTPS ou localhost**. Em
HTTP fora de localhost o navegador não expõe `crypto.subtle`, e a página avisa
em vez de gerar chaves sem proteção.

No primeiro acesso ao demo ou ao próprio perfil, se a pubkey ainda não tiver um
bloco `profile`, o cliente publica um bloco inicial assinado com o username
local. Um perfil público existente não é sobrescrito; nome, bio e foto podem ser
editados depois no demo.

Formato resumido do cofre:

```json
{
  "format": "onpostt.identity.vault",
  "app": "onpostt-demo",
  "username": "nome-local",
  "publicKey": "03...",
  "createdAt": "2026-10-27T19:45:36.591Z",
  "cipher": "AES-256-GCM",
  "kdf": {
    "name": "PBKDF2",
    "hash": "SHA-256",
    "iterations": 600000,
    "salt": "<base64 de 16 bytes>"
  },
  "iv": "<base64 de 12 bytes>",
  "ciphertext": "<payload cifrado>"
}
```

`/login.html` aceita:

- **chave privada** colada (64 caracteres hexadecimais), com username opcional;
- **cofre `.json`** importado, que pede a senha definida no cadastro ou na
  exportação. Senha errada ou arquivo corrompido retornam a mesma mensagem
  genérica. Arquivos em texto puro não são aceitos.

A opção **Manter sessão neste dispositivo** vem marcada e usa 30 dias de validade
deslizante. A sessão ativa fica em `sessionStorage`. Para sobreviver ao
fechamento do navegador, o cliente gera uma chave AES-256-GCM **não exportável**
com WebCrypto, guarda essa chave no IndexedDB `onpostt-auth` e usa-a para cifrar
uma cópia local da identidade. A senha do cofre não é armazenada. Desmarcar a
opção apaga e revoga o registro persistente, mantendo apenas a aba atual.

O logout limpa a sessão, marca o dispositivo como revogado, remove o registro do
IndexedDB e avisa outras abas via `BroadcastChannel`; o demo redireciona para o
login. Se o IndexedDB estiver indisponível, o login continua apenas na aba atual
e o cliente avisa que a sessão não será restaurada depois. Em computador
compartilhado, desmarque **Manter sessão** ou saia ao terminar.

No demo, o diálogo de identidade permite exportar um novo cofre cifrado com uma
senha escolhida na hora e sair. O download de JSON em texto puro não existe. A
chave privada e a senha nunca são enviadas ao relay, mas qualquer script de mesma
origem executando na página pode usar a sessão aberta; a CSP e o uso de
`textContent` reduzem esse risco, sem eliminar XSS. Perder o cofre e a senha
significa perder a identidade portátil; a chave privada colada manualmente é a
única alternativa nesse caso.

### Fotos em posts

A imagem é reduzida **no navegador** e enviada como base64 dentro do `content`.
O relay não confia nas dimensões declaradas: decodifica os bytes, confere a
assinatura do arquivo (JPEG/PNG), lê largura e altura reais do cabeçalho e
rejeita imagens maiores que `MAX_IMAGE_DIMENSION` (500px) ou
`MAX_IMAGE_BYTES` (72 KiB decodificados por padrão).

Formato do conteúdo:

```json
{
  "text": "legenda opcional",
  "image": {
    "mime": "image/jpeg",
    "data": "<base64 sem prefixo data:>",
    "width": 500,
    "height": 375
  }
}
```

Use `onpostt.prepareImage` no navegador. Ele redimensiona respeitando a
proporção, converte para JPEG, comprime até o alvo e devolve o formato exato
aceito pelo relay:

```js
async function publishPhoto(file, caption, privateKey) {
  const image = await onpostt.prepareImage(file, {
    maxDimension: 500,
    maxBytes: 64 * 1024, // margem abaixo do limite de 72 KiB do relay
    mime: 'image/jpeg',
  });

  const block = await onpostt.signBlock(
    {
      mode: 'post',
      query: [],
      app: 'meu-app',
      content: {
        ...(caption ? { text: caption } : {}),
        image: {
          mime: image.mime,
          data: image.data, // base64 canônico, sem prefixo data:
          width: image.width,
          height: image.height,
        },
      },
    },
    privateKey
  );

  if (typeof block === 'string') throw new Error(block);
  return onpostt.sendBlock(block);
}
```

`prepareImage` só existe no navegador, porque usa `canvas`, `FileReader` e
`createImageBitmap`/`Image`. A demo oficial usa a mesma função, mostra a prévia
e remove a foto do rascunho antes de publicar.

A foto do perfil usa o mesmo helper, mas o alvo é **150px** no maior lado. A
imagem é preparada e pré-visualizada antes de salvar; o relay continua aceitando
até 500px, o limite de protocolo para imagens. O conteúdo é estrito: quando há
imagem, o relay aceita apenas `name`, `bio` e `image`:

```js
const image = await onpostt.prepareImage(file, {
  maxDimension: 150,
  maxBytes: 64 * 1024,
  mime: 'image/jpeg',
});
const block = await onpostt.signBlock(
  {
    mode: 'profile',
    query: [],
    app: 'meu-app',
    content: {
      name: 'Ana',
      bio: 'Uma frase sobre mim',
      image: {
        mime: image.mime,
        data: image.data,
        width: image.width,
        height: image.height,
      },
    },
  },
  privateKey
);

if (typeof block === 'string') throw new Error(block);
await onpostt.sendBlock(block);
```

Salvar o perfil sem `image` remove a foto anterior. O demo mostra a prévia ao
importar, redimensiona para até 150px, guarda o base64 canônico no bloco e usa a
imagem como avatar no feed, nos perfis e nas conversas. A foto de publicação
continua em 500px.

### Mensagens

O cliente gera uma chave efêmera por envio, faz ECDH com a pubkey do
destinatário e com a do remetente, deriva AES-256-GCM e grava dois envelopes:

```json
{
  "forRecipient": { "ciphertext": "...", "iv": "...", "senderPubKey": "..." },
  "forSender":    { "ciphertext": "...", "iv": "...", "senderPubKey": "..." }
}
```

O relay valida o formato, mas não consegue ler o texto. O destinatário recebe
uma cópia com id `<id>_rcp` para aparecer na caixa de entrada; o remetente lê a
mensagem original.

Na demo, o texto decifrado pode ser simples ou um JSON com `image`/`audio`.
Imagens são redimensionadas para até 500px e comprimidas antes da cifragem.
Áudios são gravados no navegador por no máximo 15 segundos e enviados em base64
dentro do envelope. A lista de conversas mostra apenas contatos com mensagens
enviadas ou recebidas por você; abrir uma conversa publica `message_read` e
remove os indicadores de não lidas. Apagar uma conversa oculta o histórico
apenas neste dispositivo (`localStorage`); as mensagens permanecem no relay e
uma nova mensagem reabre o contato.

---

## Segurança

- Chave privada **nunca** é enviada ao relay. Biblioteca e servidor rejeitam
  `privatekey` em blocos, pares de query e filtros, sem diferenciar maiúsculas
  de minúsculas.
- O cofre local usa PBKDF2-SHA-256 com 600.000 iterações e AES-256-GCM; senha e
  chave privada não são gravadas em `localStorage`.
- A sessão persistente usa uma chave AES não exportável no IndexedDB, expira em
  30 dias e é revogada no logout. A sessão ativa fica em `sessionStorage`.
- Todo bloco é verificado por assinatura e por id canônico antes de gravar.
- `processed_blocks` impede replay de `like`, `reaction`, `follow`, `block` e
  demais efeitos.
- `like`, `reaction`, `comment` e `delete` exigem alvo existente; `delete`
  exige autoria.
- `notification` exige interação real do mesmo autor, alvo do destinatário,
  `kind` compatível, ausência de tombstone e no máximo uma notificação por
  interação. Notificações de follow validam o próprio bloco `follow` e o par
  `following`/`to`.
- `block` exige `blocker` = autor, `blocked` válido e diferente do autor; o
  bloqueio ativo rejeita mensagens nos dois sentidos antes de gravar a cópia do
  destinatário.
- Leituras com `reader` verificam assinatura, pubkey, timestamp e TTL antes de
  usar a identidade. O token de leitura só concede leitura e não autoriza
  escrita.
- Relações de bloqueio ativas filtram leituras autenticadas nas duas direções e
  leituras anônimas pelo critério conservador de autores participantes. O
  filtro vale para HTTP, páginas de perfil, tópicos e transmissões WebSocket ao
  vivo; erros de banco na checagem ao vivo falham fechados.
- Respostas exigem um comentário pai do mesmo alvo e não excluído.
- Perfis e notificações continuam públicos para leitores sem relação de
  bloqueio; a leitura de notificações não altera o bloco.
- CORS e WebSocket só aceitam a própria origem ou valores de `HOST_ALLOWED`.
- Limites de corpo, payload WS, assinaturas, pubkeys, conexões e taxa por IP.
- Respostas de listagem são limitadas por `MAX_RESPONSE_BYTES`; quando cortadas,
  retornam `truncated: true` para o cliente paginar com `offset`.
- Imagens são decodificadas e verificadas por magic bytes e dimensões reais;
  dados declarados pelo cliente não são confiados.
- Tópicos são normalizados no cliente e revalidados no relay; o ranking usa SQL
  parametrizado e o demo renderiza nomes com `textContent`, sem HTML.
- Cabeçalhos de segurança e CSP restritiva; nenhuma dependência de CDN.
- Logs não registram corpos de blocos, chaves, senhas ou string do banco.
- A dashboard expõe apenas um snapshot público (sem credenciais).

Detalhes e modelo de ameaças: [`docs/SECURITY.md`](docs/SECURITY.md).

---

## Configuração

Todas as variáveis estão documentadas em `env.example`. Resumo:

| Grupo | Variáveis |
| --- | --- |
| Servidor | `NODE_ENV`, `PORT_HTTP`, `HOST`, `TRUST_PROXY` |
| Origens | `HOST_ALLOWED`, `ALLOW_NO_ORIGIN`, `ENABLE_HSTS` |
| Limites HTTP | `HTTP_MAX_CONNECTIONS`, `HTTP_MAX_MESSAGE_SIZE`, timeouts |
| Limites WS | `SOCKET_PATH`, `SOCKET_MAX_*`, `RATE_LIMIT_MAX_WS` |
| Protocolo | `MAX_BLOCK_SIZE`, `MAX_CONTENT_SIZE`, `MAX_RESPONSE_BYTES`, `MAX_QUERY_*`, `VALIDATE_BLOCK_ID`, `READER_TOKEN_TTL_SECONDS` |
| Imagens | `MAX_IMAGE_BYTES`, `MAX_IMAGE_DIMENSION`, `MAX_IMAGE_CONTENT_SIZE` |
| Banco | `DATABASE_URL` ou `PGHOST`/`PGPORT`/`PGUSER`/`PGPASSWORD`/`PGDATABASE` |
| Pool | `MAX_POOL_SIZE`, `DB_*_TIMEOUT_MS`, `DB_SSL` |
| Logs | `LOG_LEVEL`, `LOG_TO_FILE`, `LOG_DIR` |
| Operação | `EXIT_ON_UNCAUGHT`, `RELAY_NAME` |

`HOST_ALLOWED=*` libera qualquer origem e deve ser usado apenas em
desenvolvimento consciente. A mesma origem do relay é sempre permitida.

---

## Scripts

| Comando | Função |
| --- | --- |
| `npm start` | inicia o relay |
| `npm run dev` | inicia com `--watch` |
| `npm test` | executa a suíte de testes |
| `npm run check` | valida a sintaxe dos arquivos principais |
| `npm run db:init` | aplica `database/schema.sql` (idempotente) |
| `npm run build:lib` | gera `public/onpostt.min.js` com elliptic + esbuild |

---

## Estrutura

```text
.
├── src/
│   ├── main.js           # bootstrap HTTP + WebSocket + shutdown
│   ├── relay-http.js     # API, estáticos, CORS, CSP, rate limit
│   ├── relay-socket.js   # assinaturas, fan-out, mensagens, heartbeat
│   ├── protocol.js       # validação de blocos, query e filtros
│   ├── image.js          # base64, magic bytes e dimensões reais de fotos
│   ├── topics.js         # normalização e validação de tópicos
│   ├── trending.js       # ranking SQL de tópicos em alta
│   ├── crypto.js         # sha256, secp256k1, id canônico
│   ├── query.js          # normalização de filtros e SQL parametrizado
│   ├── readAuth.js       # token de leitura assinado (viewer)
│   ├── visibility.js     # visibilidade de blocos ao vivo
│   ├── saveBlock.js      # persistência, toggles, idempotência
│   ├── getBlocks.js      # leitura
│   ├── db.js             # pool e transações
│   ├── config.js         # ambiente e limites
│   ├── modes.js          # definição dos modos
│   ├── stats.js          # métricas em memória
│   ├── errors.js         # erros públicos
│   └── logger.js         # winston, sem segredos
├── public/
│   ├── index.html        # dashboard
│   ├── doc.html          # documentação
│   ├── login.html        # entrada local (chave ou cofre)
│   ├── cadastro.html     # criação de identidade e cofre
│   ├── perfil.html       # página pública de perfil
│   ├── onpostt.js        # biblioteca (fonte)
│   ├── onpostt.min.js    # bundle (gerado)
│   ├── demo/             # aplicação de demonstração
│   ├── assets/           # CSS, auth.js, login.js, cadastro.js e perfil.js
│   └── vendor/           # elliptic local
├── database/
│   └── schema.sql        # schema canônico idempotente
├── test/                 # testes (node:test)
├── scripts/              # init-db e build-lib
├── examples/             # exemplos executáveis
└── docs/                 # documentação técnica
```

---

## Documentação

- [Protocolo](docs/PROTOCOL.md) — bloco, id, assinatura, modos e query.
- [API HTTP e WebSocket](docs/API.md) — rotas, mensagens, erros e limites.
- [Segurança](docs/SECURITY.md) — modelo de ameaças, garantias e limitações.
- [Arquitetura](docs/ARCHITECTURE.md) — componentes, fluxos e escala.
- [Implantação](docs/DEPLOYMENT.md) — PostgreSQL, proxy reverso, TLS e operação.
- [Banco de dados](database/README.md) — schema, índices e manutenção.
- [Exemplos](examples/README.md) — publicar, publicar foto, listar, reagir, notificar e conversar.

---

## Limitações

- O relay não oferece anonimato: IP, horários, pubkeys e metadados de
  assinatura são visíveis.
- Conteúdo público é público, incluindo perfis, relações de follow/bloqueio e
  notificações. O filtro de bloqueio esconde conteúdo nas leituras, mas não
  cifra os blocos; a cifragem protege apenas `message`.
- O relay aplica bloqueio nas leituras HTTP e WebSocket e impede mensagens entre
  bloqueados, mas a lista de blocos `block` continua pública para a interface
  detectar o estado. Ocultação não é cifragem: administradores do banco e quem
  acessa diretamente o PostgreSQL ainda veem os blocos.
- **Sybil:** uma nova chave privada é uma nova identidade. O bloqueio não impede
  que a mesma pessoa crie outra pubkey para tentar acessar o perfil. Não há
  prova de unicidade humana no protocolo; para isso seria necessário um
  provedor externo de identidade, o que quebraria o modelo local-first.
- Não há moderação ou remoção física de blocos.
- Rate limit e fan-out WebSocket são em memória; para múltiplas instâncias,
  use um limitador/pub-sub compartilhado.
- Mensagens não têm ratchet/forward secrecy entre mensagens; cada envio usa
  uma chave efêmera, mas o histórico continua legível com a chave privada.
- A chave privada do usuário é responsabilidade do cliente.
- O login é local: não há conta central, username único, recuperação de senha
  ou revogação remota de uma identidade.
- A sessão persistente do demo equivale a manter o perfil do navegador
  desbloqueado. XSS de mesma origem, malware ou acesso ao perfil do navegador
  podem usar a chave; a CSP e o uso de `textContent` reduzem a superfície, mas
  não garantem proteção contra código malicioso no dispositivo.
- O cofre depende da qualidade da senha escolhida. Sem o cofre e a senha (ou a
  chave privada), não há recuperação.

---

## Licença

MIT. Veja `package.json`.
