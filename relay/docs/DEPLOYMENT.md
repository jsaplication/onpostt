# Implantação

Guia para colocar o relay onpostt em produção com PostgreSQL, HTTPS e
WebSocket atrás de um proxy reverso.

---

## 1. Pré-requisitos

| Item | Requisito | Observação |
| --- | --- | --- |
| Node.js | 20+ | 22/24 recomendados |
| PostgreSQL | 13+ | 15+ recomendado |
| Proxy reverso | Nginx, Caddy ou equivalente | — |
| Sistema | Linux recomendado | Windows funciona para desenvolvimento |

O relay não exige compilação nativa além das dependências npm.

---

## 2. Banco de dados

### 2.1 Criar usuário e banco

Como superusuário do PostgreSQL:

```sql
CREATE ROLE onpostt LOGIN PASSWORD 'troque-esta-senha';
CREATE DATABASE onpostt OWNER onpostt;
```

Se preferir um usuário sem privilégio de owner:

```sql
CREATE ROLE onpostt LOGIN PASSWORD 'troque-esta-senha';
CREATE DATABASE onpostt;
\c onpostt
GRANT CONNECT ON DATABASE onpostt TO onpostt;
GRANT USAGE, CREATE ON SCHEMA public TO onpostt;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO onpostt;
```

O schema cria as tabelas e índices. Não é necessário superusuário em runtime.

### 2.2 Aplicar o schema

Com `DATABASE_URL` ou variáveis `PG*` configuradas:

```bash
npm run db:init
```

Ou manualmente:

```bash
psql "postgres://onpostt:senha@localhost:5432/onpostt" \
  -f database/schema.sql
```

O script é idempotente e não apaga dados.

### 2.3 TLS do banco

Se o PostgreSQL exigir TLS:

```dotenv
DB_SSL=true
DB_SSL_REJECT_UNAUTHORIZED=true
```

Para certificado autoassinado em ambiente controlado, avalie
`DB_SSL_REJECT_UNAUTHORIZED=false` — nunca em produção pública.

### 2.4 Backup

```bash
pg_dump --format=custom --file=onpostt-$(date +%F).dump onpostt
```

Restaure em ambiente de teste periodicamente:

```bash
createdb onpostt_restore
pg_restore --dbname=onpostt_restore onpostt-$(date +%F).dump
```

Inclua `blocks` e `processed_blocks`. Para produção crítica, configure WAL
archiving/PITR.

---

## 3. Configuração

```bash
cp env.example .env
chmod 600 .env
```

Exemplo de produção (substitua domínio, senha e caminhos):

```dotenv
NODE_ENV=production
PORT_HTTP=3000
HOST=127.0.0.1

HOST_ALLOWED=https://relay.exemplo.com
ALLOW_NO_ORIGIN=false
TRUST_PROXY=1
ENABLE_HSTS=true

PGHOST=127.0.0.1
PGPORT=5432
PGUSER=onpostt
PGPASSWORD=troque-esta-senha
PGDATABASE=onpostt
DB_SSL=false

LOG_LEVEL=info
LOG_TO_FILE=true
LOG_DIR=logs
EXIT_ON_UNCAUGHT=true

RELAY_NAME=onpostt relay
```

Notas:

- `HOST=127.0.0.1` quando o proxy roda na mesma máquina.
- `TRUST_PROXY=1` atrás de **um** proxy confiável; sem isso, o rate limit por
  IP pode ser burlado com `X-Forwarded-For`.
- `HOST_ALLOWED` deve conter exatamente o esquema e o host público. A própria
  origem já é aceita automaticamente, mas listar explicitamente evita surpresas
  com proxy.
- Nunca use `HOST_ALLOWED=*` em produção.
- `.env` nunca entra no controle de código.

---

## 4. Instalação

```bash
# em /opt/onpostt
npm ci
npm run build:lib       # gera public/onpostt.min.js
npm prune --omit=dev    # remove esbuild e dependências de teste
```

O bundle `public/onpostt.min.js` já pode vir pronto no deploy; o build só é
necessário se você alterar `public/onpostt.js` ou
`public/vendor/elliptic.min.js`.

Verifique:

```bash
npm test
npm run check
```

---

## 5. Proxy reverso

### 5.1 Nginx

`/etc/nginx/conf.d/onpostt.conf`:

```nginx
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}

server {
    listen 80;
    server_name relay.exemplo.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    server_name relay.exemplo.com;

    ssl_certificate     /etc/letsencrypt/live/relay.exemplo.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/relay.exemplo.com/privkey.pem;

    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
    client_max_body_size 2m;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;

        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # WebSocket
        proxy_set_header Upgrade    $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_read_timeout 600s;
        proxy_send_timeout 600s;
    }
}
```

O relay já envia cabeçalhos de segurança; o proxy pode reforçá-los.

### 5.2 Caddy

```caddy
relay.exemplo.com {
    encode zstd gzip
    reverse_proxy 127.0.0.1:3000
}
```

Caddy negocia WebSocket automaticamente.

### 5.3 TLS e HSTS

- Use certificados válidos (Let's Encrypt ou CA interna).
- Habilite `ENABLE_HSTS=true` somente depois de confirmar HTTPS.
- Redirecione HTTP para HTTPS no proxy.

---

## 6. Serviço systemd

`/etc/systemd/system/onpostt.service`:

```ini
[Unit]
Description=onpostt relay
After=network.target postgresql.service
Wants=postgresql.service

[Service]
Type=simple
User=onpostt
Group=onpostt
WorkingDirectory=/opt/onpostt
EnvironmentFile=/opt/onpostt/.env
ExecStart=/usr/bin/node /opt/onpostt/src/main.js
Restart=on-failure
RestartSec=5
TimeoutStopSec=20
KillSignal=SIGTERM

NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/opt/onpostt/logs

[Install]
WantedBy=multi-user.target
```

```bash
sudo useradd --system --home /opt/onpostt --shell /usr/sbin/nologin onpostt
sudo chown -R onpostt:onpostt /opt/onpostt
sudo mkdir -p /opt/onpostt/logs
sudo chown onpostt:onpostt /opt/onpostt/logs
sudo systemctl daemon-reload
sudo systemctl enable --now onpostt
sudo systemctl status onpostt
```

Ajuste `ReadWritePaths` se `LOG_DIR` for outro caminho. Se não usar logs em
arquivo, remova a necessidade de escrita.

### Windows

Para desenvolvimento, `npm start` é suficiente. Para serviço, use NSSM ou
`sc.exe` apontando para `node.exe src/main.js` com o diretório de trabalho
correto.

---

## 7. Verificação

```bash
curl -fsS https://relay.exemplo.com/health
curl -fsS https://relay.exemplo.com/api/status
curl -fsS https://relay.exemplo.com/api/modes
```

Espere:

- `/health` → `200` e `database.ok = true`;
- `/api/status` → `modes` com os doze modos;
- `/api/modes` → regras públicas de query;
- `/` → dashboard;
- `/doc.html` → documentação;
- `/demo/` → demo;
- `/perfil.html` → página pública de perfil (sem query, abre o perfil local quando
  houver identidade).

Teste o WebSocket com a origem correta:

```js
const ws = new WebSocket('wss://relay.exemplo.com/');
ws.onmessage = (event) => console.log(event.data);
```

Se a origem não for permitida, o upgrade retorna `403`.

---

## 8. Monitoramento

| Sinal | Como | Ação |
| --- | --- | --- |
| Disponibilidade | `GET /health` | alertar se 503 por > 2 min |
| Latência do banco | `database.latencyMs` | investigar > 200 ms |
| Erros 5xx | logs/APM | investigar imediatamente |
| Rate limit | contador `httpRejected` | ajustar limites ou bloquear abuso |
| Conexões WS | `stats.connections` | dimensionar/reiniciar |
| Memória | `stats.memoryRss` | investigar vazamento |
| Disco | logs e PostgreSQL | rotação/backup |
| Duplicatas | `stats.duplicates` | normal em retries; picos indicam clientes reenviando |

Não exponha `/api/status` a menos que aceite divulgar métricas operacionais.
Ele não contém segredos, mas revela volume e configuração de limites.

---

## 9. Atualização

```bash
# 1. backup
pg_dump --format=custom --file=/backup/onpostt-$(date +%F).dump onpostt

# 2. código
git pull            # ou copie o código novo
npm ci
npm run build:lib

# 3. schema (idempotente)
npm run db:init

# 4. reinício gracioso
sudo systemctl restart onpostt

# 5. verificação
curl -fsS https://relay.exemplo.com/health
```

O shutdown gracioso fecha WebSocket, HTTP e pool. O cliente reconecta sozinho.

### Rollback

1. pare o serviço;
2. restaure o código anterior;
3. restaure o backup do banco se o schema tiver mudado;
4. suba o serviço;
5. valide `/health` e uma consulta.

Mantenha o backup mesmo quando a mudança parecer aditiva.

---

## 10. Escala horizontal

- O estado dos blocos está no PostgreSQL.
- Conexões WS, rate limit e contadores são locais ao processo.
- Com múltiplas instâncias atrás de um balanceador:
  - use sticky sessions para WebSocket, ou aceite reconexão;
  - compartilhe fan-out via pub/sub (Redis/NATS) se precisar de tempo real
    entre instâncias;
  - compartilhe rate limit;
  - dimensione `MAX_POOL_SIZE` por instância (soma ≤ conexões do PostgreSQL).
- `processed_blocks` garante idempotência mesmo com instâncias concorrentes.

---

## 11. Hardening

- [ ] Firewall: apenas 443 público; 3000 e 5432 em loopback/rede privada.
- [ ] `.env` com permissão `600`.
- [ ] Usuário de sistema sem shell e sem privilégios.
- [ ] PostgreSQL com usuário dedicado e backup testado.
- [ ] TLS válido, HSTS, redirect 80 → 443.
- [ ] `HOST_ALLOWED` sem `*`, `ALLOW_NO_ORIGIN=false`.
- [ ] `TRUST_PROXY` correto.
- [ ] `EXIT_ON_UNCAUGHT=true` em produção.
- [ ] Logs com rotação e retenção.
- [ ] Dependências atualizadas (`npm audit`).
- [ ] Limites revisados para o volume esperado.
- [ ] Plano de resposta a incidentes e contato de segurança.

---

## 12. Solução de problemas

| Sintoma | Causa provável | Correção |
| --- | --- | --- |
| `password authentication failed` (28P01) | senha/usuário incorretos | ajuste `PGPASSWORD`/`PGUSER` ou `DATABASE_URL` |
| `database "onpostt" does not exist` (3D000) | banco não criado | `CREATE DATABASE onpostt` |
| `ECONNREFUSED` no banco | PostgreSQL parado/porta errada | verifique serviço, `PGHOST`/`PGPORT` |
| `/health` 503 | banco indisponível | corrija conexão; o relay segue de pé |
| 403 no HTTP/WS | `Origin` não permitida | ajuste `HOST_ALLOWED` ou use a mesma origem |
| 403 sem `Origin` no WS | cliente nativo | configure `ALLOW_NO_ORIGIN=true` com cautela |
| 429 | rate limit | reduza frequência, aumente limites ou use proxy |
| 413 | corpo grande | aumente `HTTP_MAX_MESSAGE_SIZE` ou reduza o bloco |
| `EADDRINUSE` | porta ocupada | pare o processo ou troque `PORT_HTTP` |
| WS fecha sozinho | heartbeat/inatividade | cliente deve responder `pong` ou enviar `ping` |
| `private_key_forbidden` | filtro com `privatekey` | envie apenas `pubkey` |
| `block_too_large` | bloco acima do limite | reduza conteúdo ou aumente `MAX_BLOCK_SIZE` |
| `invalid_origin` em produção | proxy altera `Host` | preserve `Host` no proxy |

Para diagnosticar, consulte `logs/combined.log` e `logs/error.log` (se
`LOG_TO_FILE=true`). Nunca habilite log de corpo de bloco ou de chave.
