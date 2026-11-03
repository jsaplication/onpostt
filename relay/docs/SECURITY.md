# Segurança

Segurança é o requisito principal do onpostt. Este documento descreve o modelo
de ameaças, os controles implementados, as garantias e o que **não** é
garantido.

> Resumo: o relay nunca recebe chave privada, valida tudo o que é verificável e
> limita abuso. Ele **não** oferece anonimato, moderação ou disponibilidade
> garantida.

---

## 1. Ativos

| Ativo | Onde vive | Proteção |
| --- | --- | --- |
| Chave privada | dispositivo do usuário | nunca sai do cliente |
| Cofre portátil | download do usuário | PBKDF2-SHA-256 + AES-256-GCM |
| Sessão ativa | `sessionStorage` da aba | escopo da aba e CSP da origem |
| Sessão lembrada | IndexedDB do navegador | chave AES não exportável + expiração |
| Conteúdo de mensagens | cliente → banco (ciphertext) | E2E AES-256-GCM |
| Conteúdo público | banco | integridade por assinatura |
| Senha/URL do banco | ambiente do relay | `.env`, nunca em log/API |
| Disponibilidade | relay + PostgreSQL | limites, timeouts, proxy |

---

## 2. Modelo de ameaças

### 2.1 Relay comprometido

O relay vê:

- pubkeys, horários, IPs, tamanhos, filtros e metadados;
- conteúdo público em claro;
- ciphertext de mensagens e envelope (`forRecipient`, `forSender`).

O relay **não** vê:

- chaves privadas;
- texto de mensagens;
- senha do banco (não é exposta na API).

Um relay malicioso pode censurar, atrasar ou descartar blocos. A biblioteca
permite configurar vários hosts, mas não há consenso bizantino: o cliente decide
em quais confia.

### 2.2 Cliente malicioso

Pode:

- criar blocos válidos com qualquer pubkey cuja chave privada possua;
- inundar o relay (mitigado por rate limit);
- criar muitos blocos pequenos (custo de armazenamento);
- tentar forjar autoria (bloqueado por assinatura);
- tentar replay de toggle (bloqueado por `processed_blocks`);
- tentar excluir bloco de outro autor (bloqueado por checagem de dono);
- tentar gravar mensagem sem cifra (bloqueado pelo envelope);
- tentar enviar mensagem após um bloqueio (recusado no servidor nos dois
  sentidos, com lock transacional do par);
- tentar responder a um comentário de outro post (bloqueado por
  `parent_mismatch`);
- tentar notificar outra pubkey, referenciar interação alheia ou duplicar uma
  notificação (bloqueado pelas checagens de alvo, autor, `kind` e unicidade);
- tentar forjar uma notificação de follow sem seguir o destinatário (bloqueado
  por `notification_follow_mismatch` e pela checagem `following == to`).

Não pode:

- vazar a chave privada de outro usuário pelo relay;
- alterar conteúdo assinado sem invalidar a assinatura;
- trocar o id de um bloco sem invalidar a assinatura.

### 2.3 Atacante de rede

Sem HTTPS/WSS, pode ler e modificar tráfego. Com TLS, pode bloquear ou atrasar.
A integridade dos blocos é garantida pela assinatura mesmo se o transporte for
adulterado, mas metadados e disponibilidade não são.

### 2.4 Vazamento do banco

O banco contém conteúdo público e ciphertext de mensagens. Não contém chaves
privadas. Um vazamento expõe metadados (quem falou com quem, quando) e permite
tentar ataques offline contra o ciphertext, limitados pela força do ECDH e da
chave privada do usuário.

### 2.5 XSS e conteúdo de terceiros

O relay serve HTML próprio com CSP restritiva. Aplicações consumidoras devem
tratar `content` como **texto**, nunca como HTML. A biblioteca não renderiza
conteúdo; o demo e a página de perfil usam `textContent` para texto, `<img>`
com `src` data URL para fotos validadas e `<audio>` com data URL para áudios
validados. A CSP permite `img-src 'self' data: blob:` e
`media-src 'self' data: blob:`, mas não permite scripts inline. Nomes, bios,
comentários, tópicos e trechos de notificação nunca viram HTML. A política de permissões
libera o microfone apenas para a própria origem (`microphone=(self)`), usada
pela gravação de áudio do demo.

### 2.6 Cofre local, sessão e dispositivo comprometido

O cofre `.json` é um arquivo offline. Quem o obtiver pode tentar senhas offline,
limitado apenas pela qualidade da senha e pelo custo do PBKDF2 (600.000
iterações). A senha mínima de 10 caracteres é um piso, não uma garantia contra
senhas previsíveis.

A sessão ativa fica em `sessionStorage`; a sessão lembrada usa uma `CryptoKey`
AES-GCM não exportável no IndexedDB. Isso impede exportar a chave bruta, mas
**não** protege contra código de mesma origem executando na página: XSS pode
chamar `crypto.subtle.decrypt` com a chave armazenada, ler `sessionStorage` ou
usar a chave privada em memória para assinar blocos. CSP sem `unsafe-inline`,
ausência de HTML de usuário e uso de `textContent` reduzem a entrada para XSS,
mas não substituem a segurança do dispositivo.

Quem copia o perfil do navegador (incluindo IndexedDB) e consegue executar
JavaScript na origem pode restaurar a sessão até a expiração. Em máquina
compartilhada, desmarque **Manter sessão** ou faça logout; o logout revoga o
registro antes de apagá-lo, limpa a sessão e avisa outras abas.

Não há recuperação central: perder o cofre e a senha, sem ter a chave privada em
outro lugar, significa perder a identidade. O `username` não é único nem prova
identidade civil.

---

## 3. Controles implementados

### 3.1 Chave privada

- A biblioteca rejeita `privatekey` em blocos, pares de query e filtros, e
  exige que o cliente envie apenas `pubkey`.
- O servidor rejeita `privatekey` em filtros
  (`code: "private_key_forbidden"`), em blocos e em pares de query, sem
  diferenciar maiúsculas de minúsculas.
- Nenhum endpoint aceita chave privada.
- Logs não registram chaves.
- Os exemplos e o demo geram chaves em memória/sessão; não há chave fixa no
  repositório.

### 3.2 Integridade do bloco

- Assinatura secp256k1 DER sobre `JSON.stringify(bloco sem sig)`.
- `id = sha256(JSON.stringify(bloco sem id/sig))` conferido pelo relay.
- Verificação redundante antes da transação.
- Limite de campos, tamanho de bloco e tamanho de conteúdo.
- Imagens: base64 canônico, magic bytes JPEG/PNG, dimensões reais lidas do
  cabeçalho, máximo de 500px e limite de bytes decodificados. As dimensões
  declaradas precisam coincidir com as reais.
- Perfil com foto aceita somente `name`, `bio` e `image`; campos extras são
  rejeitados, e a imagem passa pelas mesmas verificações do post. O cliente de
  perfil prepara a foto para 150px e mostra a prévia antes de salvar; o relay
  mantém o limite de protocolo de 500px para imagens.
- Tópicos são limitados a cinco slugs canônicos de até 50 caracteres, sem
  controles, duplicatas ou maiúsculas. O filtro e o ranking são parametrizados;
  o cliente renderiza os nomes com `textContent`.
- Rejeição de chaves JSON perigosas (`__proto__`, `constructor`, `prototype`).
- Regras de query por modo: chaves obrigatórias, opcionais e extras rejeitadas.
- Emoji de reação limitado a 32 code points, sem controles/linhas vazias.

### 3.3 Replay e idempotência

- `processed_blocks` registra o id na mesma transação do efeito.
- Advisory lock por `pubkey:mode:alvo[:emoji]` serializa toggles concorrentes.
- Reenvio retorna `duplicate` sem alterar estado nem transmitir.
- Toggles (`like`, `reaction`, `repost`, `follow`, `block`) usam o mesmo
  mecanismo.
- `block` e `message` compartilham um advisory lock pelo par de pubkeys
  ordenado, para que um bloqueio concorrente não deixe passar uma mensagem.

### 3.4 Autorização de alvo

- `like`/`reaction`/`comment`: alvo existe e não está excluído para criar.
- `reaction`: toggle por autor/alvo/emoji.
- `comment` com `parent`: o pai precisa ser um comentário do mesmo alvo, não
  excluído, e não pode ser o próprio alvo.
- `delete`: alvo existe e pertence ao autor do tombstone (comparação
  case-insensitive); o alvo não pode ser outro `delete`.
- `follow`: `follower` = autor, `following` válido, sem auto-follow.
- `block`: `blocker` = autor, `blocked` válido e diferente do autor; a query
  exata é um toggle e a lista é pública.
- `notification`: `to` é o dono do bloco alvo e diferente do autor; a interação
  existe, foi assinada pelo mesmo autor, tem modo igual a `kind` e aponta para o
  mesmo alvo; alvo e interação não têm tombstone; a interação tem no máximo uma
  notificação (lock transacional + verificação de duplicidade). Em
  `kind: "follow"`, `block` e `interaction` são o próprio follow e
  `following` deve ser igual a `to`.
- `message`: `from` = autor, `to` válido, envelope cifrado e nenhum bloqueio
  ativo entre as duas pubkeys.

### 3.5 Mensagens

- Exigência de `forRecipient` e/ou `forSender`.
- `ciphertext` hex com tamanho mínimo e par.
- `iv` hex de exatamente 12 bytes.
- `senderPubKey` secp256k1 válida.
- Tamanho do envelope limitado.
- Chave efêmera por envio.
- SHA-256 sobre o hex do segredo ECDH antes de importar a chave AES-256-GCM.
- Bloqueio ativo em qualquer sentido impede a gravação das duas cópias da
  mensagem; a checagem ocorre dentro da mesma transação e do mesmo par de locks
  usado pelo toggle `block`.

Limitações criptográficas:

- não há ratchet/forward secrecy entre mensagens;
- não há deniable authentication além da assinatura do bloco;
- o remetente pode guardar o texto que enviou;
- o relay pode negar entrega;
- destinatário pode descriptografar apenas se possuir a chave privada
  correspondente à `to` (ou à `from`, no envelope `forSender`).

### 3.6 Rede e navegador

- Validação de `Origin` em HTTP e no upgrade WebSocket.
- Mesma origem permitida automaticamente; externas via `HOST_ALLOWED`.
- `ALLOW_NO_ORIGIN=false` por padrão.
- CORS restrito aos métodos e cabeçalhos usados.
- CSP sem `unsafe-inline`, sem CDN, `object-src 'none'`,
  `frame-ancestors 'none'`.
- `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`,
  `Referrer-Policy`, `Permissions-Policy`.
- HSTS opcional (`ENABLE_HSTS=true`) quando atrás de HTTPS.
- Express sem `X-Powered-By`.

> A CSP usa `connect-src 'self' ws: wss:` porque `'self'` não cobre `ws://` em
> todos os navegadores. A restrição efetiva de origem continua no servidor, no
> upgrade e nas rotas HTTP.

### 3.7 Limites e disponibilidade

- Corpo HTTP máximo.
- Payload WebSocket máximo.
- Imagens: 72 KiB decodificados, 500px e 128 KiB de JSON de conteúdo.
- Resposta de listagem/assinatura limitada a `MAX_RESPONSE_BYTES` (8 MiB por
  padrão); o excedente é sinalizado com `truncated: true` e pode ser paginado.
- Timeouts de headers, request, keep-alive e `statement_timeout` do banco.
- Máximo de conexões HTTP e WebSocket.
- Máximo de assinaturas e pubkeys por conexão.
- Rate limit por IP (HTTP) e por conexão (WS).
- Notificações têm unicidade por interação e não podem ser duplicadas.
- Heartbeat e timeout de inatividade no WS.
- Shutdown gracioso com timeout forçado.

### 3.8 Banco de dados

- Queries sempre parametrizadas; nenhum valor do usuário é interpolado.
- Filtros têm lista fechada de campos.
- Pool com timeouts e `statement_timeout`.
- Erros internos do banco não são devolvidos ao cliente.
- `healthCheck` tem cache curto.
- Credenciais apenas no ambiente; a dashboard mostra somente `ok`/latência.

### 3.9 Logs

- Formato winston; em produção, JSON.
- `errorMeta` inclui nome, mensagem, código e (fora de produção) stack.
- Não registra corpo de bloco, chave, senha ou string de conexão.
- IP aparece em logs de rate limit; configure retenção conforme sua política.

### 3.10 Dependências

- `npm audit fix` e `npm update` atualizaram `express` para 4.22.3, `ws` para
  8.22.0, `dotenv` para 16.6.1, `pg` para 8.23.1, `winston` para 3.19.0 e as
  dependências transitivas `body-parser`, `path-to-regexp`, `proxy-addr` e
  `qs`; em 2026-10-27, `npm audit --omit=dev` não aponta vulnerabilidades
  critical, high ou moderate.
- Permanece um advisory **low** sem correção publicada:
  `GHSA-848j-6mx2-7j84` / `CVE-2025-14505` em `elliptic <= 6.6.1`. O defeito
  pode gerar assinatura ECDSA incorreta quando o valor intermediário `k` tem
  zeros à esquerda. A biblioteca cliente verifica cada assinatura logo depois
  de assiná-la e descarta a assinatura inválida antes de enviá-la ao relay; a
  chave privada nunca sai do dispositivo. Ainda assim, acompanhe a correção
  upstream e evite usar `elliptic` diretamente para assinar sem essa checagem.
- O relay usa `elliptic` apenas para validar chaves e assinaturas recebidas,
  não para assinar blocos.

### 3.11 Cofre local e sessão persistente

- Não existe conta no relay. O username do cadastro é um rótulo local; a
  identidade criptográfica é a pubkey. Não há recuperação de senha no servidor.
- O cadastro valida username (3–40 caracteres, sem controles ou
  `/\?%*:|"<>`) e senha (mínimo de 10 caracteres). A senha não é gravada.
- WebCrypto exige contexto seguro (HTTPS ou localhost). Em HTTP fora de
  localhost o cliente avisa e não gera chaves.
- O cofre usa PBKDF2-SHA-256 com 600.000 iterações, salt aleatório de 16 bytes,
  AES-256-GCM e IV aleatório de 12 bytes. O AAD vincula formato, username,
  pubkey e `createdAt`, impedindo troca silenciosa desses metadados.
- O payload cifrado contém apenas `privateKey`, `publicKey` e `username`; nada
  disso aparece em texto puro no arquivo exportado. O demo não oferece download
  de JSON em texto puro.
- A importação limita o arquivo a 1 MiB, valida formato, KDF, salt, IV,
  ciphertext e pubkey, e devolve a mesma mensagem para senha errada ou corrupção.
- Se a pubkey local ainda não tiver bloco `profile`, o demo ou a página de
  perfil publica um bloco inicial assinado com o username local. Isso torna o
  username público no relay; um perfil existente não é sobrescrito.
- A sessão ativa fica em `sessionStorage`; a chave privada não é gravada em
  `localStorage`. A opção de manter sessão gera uma `CryptoKey` AES-256-GCM
  **não exportável** no IndexedDB `onpostt-auth`, cifra a identidade local e
  aplica validade deslizante de 30 dias.
- Desmarcar "manter sessão" grava uma marca de revogação e apaga o registro
  persistente. O logout também revoga antes de apagar, limpa a sessão e propaga
  o evento para outras abas via `BroadcastChannel`; o demo redireciona para o
  login e o perfil descarta a chave recarregando a página.
- Se o IndexedDB estiver bloqueado ou indisponível, a sessão funciona apenas na
  aba atual e o cliente avisa que não haverá restauração após fechar.
- A CSP continua sem `unsafe-inline`, sem scripts/estilos inline e o cliente usa
  `textContent` para dados não confiáveis. A sessão persistente não resiste a
  XSS de mesma origem nem ao acesso ao perfil do navegador; ver 2.6.

### 3.12 Leitura autenticada e bloqueio

- O cliente assina `onpostt-read-v1:<viewer>:<created_at>` com a chave privada
  local e envia `{ viewer, created_at, sig }` em `reader`.
- O relay valida pubkey, assinatura, timestamp e TTL
  (`READER_TOKEN_TTL_SECONDS`, padrão 30 dias). O token só identifica o leitor;
  não autoriza escrita.
- Com leitor identificado, o SQL de leitura esconde conteúdo quando leitor e
  autor se bloquearam em qualquer direção. A condição cobre `pubkey` do bloco e
  as duas pontas de `message`.
- Sem token, a leitura é anônima e esconde conteúdo de autores que participam de
  qualquer bloqueio ativo. Isso fecha o bypass trivial de omitir o token.
- O modo `block` é excluído do filtro de visibilidade para que a interface
  detecte o estado. A lista de relações de bloqueio continua pública.
- A transmissão ao vivo consulta a relação atual antes de entregar cada bloco;
  erro de banco na verificação resulta em não entregar (fail closed).
- O ranking de trending também exclui posts de autores que participam de
  bloqueio ativo, pois é um agregado anônimo.
- Nova chave privada = nova identidade. Não há prova de unicidade humana; ver 5.

---

## 4. Garantias

O relay garante, para blocos que aceita:

1. a assinatura corresponde à `pubkey` e ao conteúdo recebido;
2. o `id` corresponde ao conteúdo sem `id`/`sig`;
3. regras de modo e autoria foram aplicadas;
4. o efeito de um id ocorre no máximo uma vez;
5. o bloco não é entregue a assinaturas cujo filtro não case;
6. mensagens só são gravadas com envelope cifrado válido e sem bloqueio ativo
   entre remetente e destinatário;
7. notificações só apontam para interações reais, do mesmo autor e alvo, com no
   máximo uma por interação; follow notifications apontam para o próprio follow;
8. a API pública não expõe credenciais do banco;
9. tokens `reader` são verificados por pubkey, assinatura, timestamp e TTL antes
   de identificar o leitor; não concedem escrita;
10. leituras HTTP e WebSocket escondem conteúdo de relações de bloqueio ativas
    nas duas direções; leituras anônimas escondem autores que participam de
    qualquer bloqueio ativo; metadados `block` continuam legíveis; falha de
    banco na checagem ao vivo não entrega o bloco.

---

## 5. Não garantias

- **Anonimato.** IP, horários, pubkeys, filtros e tamanho de mensagens são
  visíveis ao relay e podem ser correlacionados.
- **Confidencialidade de conteúdo público.** `post`, `profile`, `comment`,
  `like`, `reaction`, `follow`, `block`, `notification` e `delete` são legíveis
  por leitores sem relação de bloqueio; o relay esconde conteúdo nas relações
  ativas, mas não cifra esses blocos. Perfis, notificações, follows e bloqueios
  também revelam relações sociais (quem interagiu com quem e quando).
- **Ocultação não é cifragem.** O relay aplica o bloqueio nas leituras e impede
  mensagens, mas os blocos continuam legíveis no PostgreSQL e por quem tem
  acesso administrativo ao banco. O bloco `block` também continua público para
  a interface detectar o estado; ele revela a existência e as pubkeys da
  relação.
- **Sybil / nova identidade.** O bloqueio vale para a pubkey bloqueada. Uma
  pessoa pode gerar outra chave privada e consultar como uma identidade nova; o
  relay não tem prova de unicidade humana. Sem um provedor externo de
  identidade, esse limite é inerente ao modelo local-first.
- **Token de leitura é bearer.** Quem obtiver um token `reader` válido pode ler
  como aquela pubkey até o TTL. O token não assina blocos nem altera estado, mas
  deve ser tratado como credencial e não deve ser colocado em URLs/logs.
- **Disponibilidade.** O relay pode cair, ser bloqueado ou censurar.
- **Moderação.** Não há remoção física, banimento ou moderação central.
- **Identidade real.** Uma pubkey não prova identidade civil.
- **Recomputação da assinatura pelo cliente.** A assinatura é verificada na
  gravação, mas a serialização JSON não é preservada no banco. Um cliente que
  recebe o bloco reconstruído não consegue refazer a verificação sem o payload
  assinado original.
- **Segurança do dispositivo.** Malware no cliente pode ler a chave privada.
  XSS de mesma origem pode usar a sessão ou a chave AES do IndexedDB.
- **Força da senha do cofre.** O PBKDF2 encarece o ataque offline, mas não
  corrige uma senha previsível nem recupera um cofre perdido.
- **Conta central.** O username não é único, não autentica sozinho e não pode
  ser recuperado ou revogado pelo relay.
- **Forward secrecy.** Comprometer a chave privada permite ler mensagens
  antigas destinadas a ela.
- **Entrega.** Não há recibo assinado nem garantia de que o destinatário leu.
- **Proteção contra spam.** Rate limit reduz, mas não elimina.

---

## 6. Boas práticas para clientes

1. Gere a chave no dispositivo; nunca a envie ao relay.
2. Prefira armazenamento seguro (Keychain, Keystore, cofre) a `localStorage`.
   No demo, use o cofre cifrado e desmarque "manter sessão" em máquina
   compartilhada.
3. Assine localmente. O relay valida todo bloco na gravação, mas devolve os
   blocos reconstruídos do banco (JSON normalizado), então não é possível
   recalcular a assinatura apenas com os campos retornados. Para verificação
   independente, obtenha o payload assinado exato ou compare o mesmo bloco
   entre relays distintos.
4. Trate `content` como texto; use `textContent`, nunca `innerHTML`.
5. Use HTTPS/WSS em produção.
6. Não registre chaves em console, analytics ou relatórios de erro.
7. Rotacione a chave se houver suspeita de comprometimento.
8. Ao usar vários relays, compare respostas e deduplique por id.
9. Não confie em `pubkey` como identidade civil sem verificação externa.
10. Em mensagens, confira se `from`/`to` correspondem aos participantes
    esperados.
11. Trate notificações e recibos como derivados: `notification_read` e
    `message_read` guardam apenas ids, não alteram o bloco original e revelam
    somente o que o destinatário escolheu marcar como lido. Não envie um bloco
    para "apagar" a notificação ou a mensagem.
12. Perfil é público. Não coloque dados sensíveis em nome, bio ou foto; a foto
    do perfil deve ser preparada para 150px antes de assinar.
13. Baixe o cofre cifrado e guarde-o separado da senha. Sem os dois (ou sem a
    chave privada), não há recuperação.
14. Use uma senha longa e única para o cofre. A senha não é enviada ao relay e
    não é armazenada pelo demo.
15. Faça logout em dispositivos compartilhados. O logout revoga a sessão local,
    mas não pode revogar uma chave privada que já saiu do dispositivo.

---

## 7. Boas práticas para operadores

1. Rode atrás de HTTPS (Nginx, Caddy, load balancer) e habilite HSTS.
2. Configure `HOST_ALLOWED` com as origens reais; nunca use `*` em produção.
3. Mantenha `ALLOW_NO_ORIGIN=false`.
4. Configure `TRUST_PROXY` apenas quando houver proxy confiável; caso contrário,
   um cliente pode falsificar `X-Forwarded-For` e burlar o rate limit por IP.
5. Use um usuário PostgreSQL com privilégios mínimos (SELECT/INSERT/UPDATE/
   DELETE nas tabelas do schema, não superuser).
6. Restrinja a rede do banco ao relay.
7. Faça backup e teste a restauração.
8. Monitore `/health`, taxa de `429`, erros 5xx e crescimento de
   `processed_blocks`.
9. Aplique retenção/limpeza de logs conforme a LGPD/GDPR.
10. Mantenha dependências atualizadas (`npm audit`).
11. Em múltiplas instâncias, use rate limit e pub/sub compartilhados.
12. Faça shutdown gracioso (SIGTERM) para não cortar conexões.

---

## 8. Checklist de revisão

- [ ] `.env` não está versionado.
- [ ] Nenhuma chave privada no repositório, HTML, demo ou exemplos.
- [ ] Nenhum download de identidade em texto puro; cofres usam PBKDF2 +
  AES-256-GCM.
- [ ] Sessão ativa em `sessionStorage`; nenhuma chave privada em `localStorage`.
- [ ] Logout limpa sessão, revoga e apaga o registro do IndexedDB.
- [ ] `HOST_ALLOWED` não contém `*`.
- [ ] HTTPS/WSS ativo e HSTS habilitado.
- [ ] `ALLOW_NO_ORIGIN=false`.
- [ ] `TRUST_PROXY` coerente com a topologia.
- [ ] Banco com usuário dedicado e backup.
- [ ] `VALIDATE_BLOCK_ID=true`.
- [ ] Limites compatíveis com o uso.
- [ ] Logs sem segredos e com retenção definida.
- [ ] Node.js 20+.
- [ ] `npm test` e `npm run check` passando.

---

## 9. Relato de vulnerabilidades

Não abra issue pública com detalhes exploráveis, provas de conceito ou dados de
usuários. Envie um relato privado ao mantenedor do projeto ou use o recurso de
*security advisory* do repositório, incluindo:

- ambiente e commit afetados;
- passos de reprodução;
- impacto;
- sugestão de correção, se houver.

O recebimento será confirmado e a correção coordenada antes da divulgação.
