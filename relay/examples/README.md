# Exemplos

Exemplos executáveis em Node.js usando a biblioteca oficial e a API do relay.
Nenhum exemplo contém chave privada fixa: as chaves são geradas em memória ou
vêm de variáveis de ambiente.

## Pré-requisitos

1. Relay rodando e banco configurado:

   ```bash
   npm start
   ```

2. Node.js 20+ e dependências instaladas.
3. A aplicação usa `app = "examples"` por padrão. Ajuste com `ONPOSTT_APP`.

## Scripts

| Arquivo | O que faz |
| --- | --- |
| `publish-post.js` | gera chave, assina um `post` e grava via HTTP |
| `publish-photo.js` | gera uma PNG 500×375, embute em base64 e publica um post com foto |
| `read-feed.js` | lista os últimos posts via `list()` |
| `send-message.js` | assina/cifra uma `message`, grava e descriptografa |
| `social-actions.js` | executa post, like, reaction, comment, reply, notification, follow, notificação de follow, block e delete |
| `watch-feed.js` | assinatura em tempo real via WebSocket cru |

### Publicar

```bash
node examples/publish-post.js http://localhost:3000
```

Saída esperada:

```text
pubkey: 03...
id: 9f2c...
http://localhost:3000 success created
```

### Publicar foto em base64

```bash
node examples/publish-photo.js http://localhost:3000
```

O script gera uma PNG 500×375 em memória (simulando o resultado do canvas do
frontend), codifica em base64, assina e publica. Depois consulta o feed e confirma
que a imagem está presente. O relay valida o tamanho, os magic bytes e as
dimensões reais; uma imagem acima de 72 KiB ou de 500px é rejeitada.

No navegador, use `onpostt.prepareImage(file, { maxDimension: 500, maxBytes: 64 * 1024 })`
antes de assinar. A função redimensiona, converte para JPEG e devolve
`{ mime, data, width, height, bytes }`. O exemplo completo está em
[`README.md`](../README.md#fotos-em-posts) e em
[`public/doc.html`](../public/doc.html#fotos).

### Ler o feed

```bash
node examples/read-feed.js http://localhost:3000
```

### Ações sociais

```bash
node examples/social-actions.js http://localhost:3000
```

O script cria duas identidades efêmeras (Alice e Bob), publica um post, curte,
reage com 🔥, comenta, responde ao comentário e segue. Para cada interação, Bob
cria uma `notification` assinada apontando para a interação real, o post da
Alice e o `kind` correspondente. Alice também envia uma notificação de follow
para Bob, apontando para o próprio bloco `follow`. Bob bloqueia Alice e o script
consulta o bloqueio público. No fim, remove as notificações e desfaz tudo
(unblock, unfollow, unlike, unreact e delete) para não deixar lixo no banco.

Um bloqueio/desbloqueio é apenas um toggle:

```js
const block = await onpostt.signBlock(
  {
    mode: 'block',
    query: [
      ['blocker', myPubkey],
      ['blocked', otherPubkey],
    ],
    app: 'examples',
  },
  myPrivateKey
);

const [result] = await onpostt.sendBlock(block);
// result.action: "created" no bloqueio, "removed" no desbloqueio
```

Enquanto o bloqueio existir, o relay recusa `message` entre as duas pubkeys nos
dois sentidos com `code: "user_blocked"` e filtra as leituras dos envolvidos. A
biblioteca envia um token `reader` assinado quando há uma chave configurada:

```js
await onpostt.setReaderKey(myPrivateKey);
const perfis = await onpostt.list({ mode: 'profile', limit: 20 });
```

Sem `reader`, a leitura é anônima e o relay esconde autores que participam de
qualquer bloqueio ativo. O bloco `block` continua público para a interface
detectar o estado. Uma nova chave privada é uma nova identidade; o bloqueio não
elimina Sybil.

### Perfil público e foto do perfil

A demo publica perfis com `name`, `bio` e `image` opcional. A foto do perfil é
pré-visualizada ao importar e preparada com
`onpostt.prepareImage(file, { maxDimension: 150, maxBytes: 64 * 1024 })`; a foto
de uma publicação continua em 500px. A página pública fica em
`/perfil.html?pubkey=<pubkey>` e os aliases `/perfil`, `/profile` e
`/profile.html` redirecionam preservando a query string.

A demo também aceita `?view=feed`, `?view=profiles`, `?view=notifications`,
`?view=chat` e `?view=about`, além de `?topic=<slug>` para abrir o feed
filtrado por tópico. A lateral de trending usa `GET /api/trending`.

### Enviar mensagem

```bash
node examples/send-message.js http://localhost:3000
```

Sem variáveis, o script gera remetente e destinatário efêmeros e mostra a
descriptografia dos dois lados. Para usar identidades fixas:

```bash
# atenção: não versione estas variáveis
ONPOSTT_PRIVATE_KEY=<64-hex> \
ONPOSTT_TO=<pubkey-do-destinatário> \
node examples/send-message.js
```

O relay não recebe a chave privada; ela é usada apenas localmente para assinar e
cifrar.

### Acompanhar em tempo real

```bash
node examples/watch-feed.js http://localhost:3000
```

O exemplo usa `ws` diretamente para enviar `Origin`. No navegador, use:

```js
const unsubscribe = onpostt.sub(
  { mode: 'post', app: 'examples' },
  (event) => console.log(event.blocks)
);
```

## Variáveis

| Variável | Padrão | Descrição |
| --- | --- | --- |
| `ONPOSTT_HOST` | `http://localhost:3000` | URL do relay |
| `ONPOSTT_APP` | `examples` | identificador da aplicação |
| `ONPOSTT_PRIVATE_KEY` | gerada | chave do remetente (64 hex) |
| `ONPOSTT_TO` | gerada | pubkey do destinatário |

## Solução de problemas

- **403 no WebSocket:** a origem não está em `HOST_ALLOWED`. O exemplo envia
  `http://localhost:3000`; ajuste `ONPOSTT_HOST` ou a configuração do relay.
- **`Nenhum host HTTP configurado`:** confira se `connect()` recebeu o host.
- **`invalid_signature`:** o bloco foi alterado depois de assinar.
- **`private_key_forbidden`:** um filtro enviou `privatekey`; use `pubkey`.
- **`target_not_found`:** o bloco alvo de like/reaction/comment/delete não
  existe.
- **`parent_not_found` / `parent_mismatch`:** a resposta aponta para um
  comentário inexistente ou de outro post.
- **`interaction_not_found` / `interaction_author_mismatch` /
  `interaction_target_mismatch`:** a notificação não aponta para uma interação
  real, do mesmo autor e do mesmo alvo.
- **`notification_recipient_mismatch` / `notification_kind_mismatch`:** `to` não
  é o dono do bloco alvo ou `kind` não corresponde ao modo da interação.
- **`notification_target_mismatch` / `notification_follow_mismatch`:** a
  notificação de follow não aponta para o próprio follow ou `following` não é o
  destinatário.
- **`notification_duplicate`:** já existe uma notificação para essa interação.
- **`user_blocked`:** há um bloqueio ativo entre remetente e destinatário; o
  relay recusa a mensagem nos dois sentidos até o desbloqueio.
- **`invalid_reader` / `invalid_reader_signature` / `reader_expired`:** o token
  de leitura está malformado, adulterado ou expirou. Chame
  `setReaderKey(privateKey)` novamente para assinar um token atual.
- **`target_deleted`:** o alvo possui um tombstone e não aceita novas ações.
- **`image_too_large`:** a imagem decodificada passou de `MAX_IMAGE_BYTES`.
- **`invalid_image_dimensions`:** as dimensões declaradas não conferem com o
  cabeçalho real ou passam de `MAX_IMAGE_DIMENSION`.

## Segurança

- Não coloque chaves privadas em código, exemplos, HTML ou commits.
- Em produção, carregue a chave de um cofre local/Keychain/Keystore.
- Use HTTPS/WSS.
- Trate conteúdo recebido como texto.
