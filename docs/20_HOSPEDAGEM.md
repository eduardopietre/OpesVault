# Hospedagem própria: instalar, atualizar, fazer backup

Versão 1.0 • 05/10/2026. Guia para rodar o servidor do OpesVault com Docker na sua máquina ou numa VPS (`18` §3.4, fase W2). A segurança do que o servidor guarda está no `19`; este documento trata da operação.

## 1. O que roda

| Serviço  | Imagem                                              | Papel                                                                          |
| -------- | --------------------------------------------------- | ------------------------------------------------------------------------------ |
| `server` | `opesvault-server` (construída do `web/Dockerfile`) | API em `/api/v1` e o aplicativo web; Node 22, SQLite embutido, anexos em disco |
| `caddy`  | `caddy:2-alpine`                                    | HTTPS automático na frente do `server`; a única porta exposta                  |

O servidor é **zero-knowledge** (`19` §2): guarda contas (e-mail e hash do segredo de login), quem é integrante de qual projeto, e texto cifrado. Ele não tem a senha nem a chave de nenhum projeto. Um backup do servidor é, portanto, um backup de texto cifrado.

O volume `opesvault-data` (montado em `/data` no `server`) guarda:

| Arquivo                                                | Conteúdo                                                                                                                                              |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `opesvault.db`, `opesvault.db-wal`, `opesvault.db-shm` | Banco SQLite: contas, sessões (só hashes), projetos, integrantes, envelopes, registros cifrados, concessões de edição                                 |
| `blobs/<projeto>/<anexo>`                              | Anexos cifrados                                                                                                                                       |
| `secret`                                               | Segredo do servidor, gerado na primeira vez se `OPESVAULT_SECRET` estiver vazio. **Os sais de login dependem dele**: sem ele, ninguém entra (`19` §5) |

## 2. Requisitos

- Linux com Docker Engine 24 ou mais novo e o plugin Compose v2 (`docker compose version`). Funciona também no Docker Desktop (Windows, macOS) para testes.
- 1 GB de RAM e espaço em disco para os anexos (os PDFs ocupam quase o mesmo espaço cifrados).
- Para um domínio real: um nome (por exemplo `cofre.exemplo.com.br`) com registro DNS A ou AAAA apontando para a máquina, e as portas **80 e 443** chegando até ela (na VPS, liberar no firewall; em casa, redirecionar no roteador e, se o IP muda, usar DNS dinâmico).
- O código do repositório (a pasta `web/`).

## 3. Configuração

Copie o modelo e ajuste:

```
cd web
cp .env.example .env
```

| Variável (`.env`)      | Padrão      | Para quê                                                                                                           |
| ---------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------ |
| `OPESVAULT_DOMAIN`     | `localhost` | Domínio do site. `localhost` usa a autoridade certificadora local do Caddy (só para testes)                        |
| `OPESVAULT_HTTP_PORT`  | `80`        | Porta HTTP publicada (redireciona para HTTPS e atende a validação do certificado)                                  |
| `OPESVAULT_HTTPS_PORT` | `443`       | Porta HTTPS publicada                                                                                              |
| `OPESVAULT_SECRET`     | vazio       | Segredo do servidor (32 caracteres ou mais). Vazio: gerado no volume. Se preencher, guarde o `.env` com os backups |

Variáveis que o `server` lê (o `docker-compose.yml` já define as de produção):

| Variável                                     | Padrão                      | Observação                                                         |
| -------------------------------------------- | --------------------------- | ------------------------------------------------------------------ |
| `PORT`                                       | `8080`                      | Porta interna                                                      |
| `OPESVAULT_DATA_DIR`                         | `/data` na imagem           | Banco, anexos e segredo                                            |
| `OPESVAULT_SECRET` / `OPESVAULT_SECRET_FILE` | —                           | Valor, caminho de arquivo, ou arquivo (segredos do Docker)         |
| `OPESVAULT_SECURE_COOKIES`                   | `true`                      | Só `false` em desenvolvimento por HTTP sem `localhost`             |
| `OPESVAULT_TRUST_PROXY`                      | `false` (`true` no compose) | Usa o IP do cliente informado pelo Caddy nos limites de tentativas |
| `OPESVAULT_STATIC_DIR`                       | `/app/public` na imagem     | Aplicativo web servido junto com a API                             |

## 4. Instalar

```
cd web
cp .env.example .env          # ajuste OPESVAULT_DOMAIN
docker compose up -d --build
docker compose ps             # server "healthy", caddy "Up"
curl https://SEU-DOMINIO/api/v1/health      # {"ok":true}
```

Depois abra `https://SEU-DOMINIO` no navegador. A imagem traz o aplicativo web de produção (`VITE_SERVICES=real`, sem o catálogo de componentes), servido pelo mesmo processo da API.

**Proxy corporativo com inspeção de TLS:** se o `docker build` falhar ao baixar pacotes com erro de certificado, passe a autoridade certificadora do proxy só para a construção, sem gravá-la na imagem:

```
docker build --secret id=extra_ca,src=/caminho/ca.pem -t opesvault-server:local .
docker compose up -d --no-build
```

## 5. Domínio e HTTPS

- O Caddy obtém e renova o certificado sozinho (Let's Encrypt ou ZeroSSL) quando `OPESVAULT_DOMAIN` é um domínio real que aponta para a máquina e as portas 80 e 443 estão acessíveis. Os certificados ficam no volume `caddy-data`.
- Com `localhost`, o Caddy usa uma autoridade local. Para o navegador confiar, copie a raiz e instale-a como confiável no sistema (só em máquina de teste):
  ```
  docker compose cp caddy:/data/caddy/pki/authorities/local/root.crt ./caddy-root.crt
  curl --cacert caddy-root.crt https://localhost/api/v1/health
  ```
- O servidor envia `Strict-Transport-Security` (um ano) e a política de conteúdo do `19` §12. Não sirva o aplicativo por HTTP simples fora de `localhost`: o navegador só oferece WebCrypto em contexto seguro.
- O Caddy não grava log de acesso, de propósito (o servidor grava o seu, sem dados pessoais, §8).

## 6. Atualizar

```
cd web
git pull
docker compose up -d --build
docker compose ps
```

- O banco é criado e ajustado pelo próprio servidor ao iniciar; não há passo manual.
- **Antes de atualizar, faça um backup** (§7). Para voltar atrás, marque a imagem anterior antes (`docker tag opesvault-server:local opesvault-server:anterior`) e, se preciso, aponte o `image:` do compose para ela.
- Durante a troca, quem estiver usando vê o estado "offline" por alguns segundos; as alterações ficam na fila do navegador e sobem quando o servidor volta.
- Atualize também o sistema e o Docker da máquina; a imagem base (`node:22-alpine`) é baixada de novo com `docker compose build --pull`.

## 7. Backup e restauração

O que importa é o volume `opesvault-data` (tudo cifrado, mais e-mails e hashes) e, se você preencheu `OPESVAULT_SECRET`, o arquivo `.env`. O volume `caddy-data` só tem certificados, que se obtêm de novo.

**Backup (para alguns segundos o servidor, para uma cópia consistente do SQLite):**

```
cd web
docker compose stop server
docker run --rm -v opesvault_opesvault-data:/data:ro -v "$PWD":/backup alpine \
  tar czf /backup/opesvault-$(date +%Y-%m-%d).tgz -C /data .
docker compose start server
```

- Guarde as cópias fora da máquina (outro disco, outro lugar). Elas não revelam o conteúdo dos projetos sem as senhas, mas revelam e-mails, integrantes, quantidades e horários (`19` §7).
- O backup do servidor **não substitui** a chave de recuperação de cada projeto: sem senha e sem chave de recuperação, nem o backup abre os dados (`19` §10).
- Teste a restauração de vez em quando numa máquina separada.

**Restaurar:**

```
cd web
docker compose stop server
docker run --rm -v opesvault_opesvault-data:/data -v "$PWD":/backup alpine \
  sh -c 'rm -rf /data/* /data/.[!.]* 2>/dev/null; tar xzf /backup/opesvault-AAAA-MM-DD.tgz -C /data && chown -R 1000:1000 /data'
docker compose start server
```

Restaurar uma cópia antiga faz o servidor "voltar no tempo". Os navegadores que já tinham visto alterações mais novas percebem, mantêm a cópia local e avisam (`server_behind`, `19` §11); alterações feitas depois do backup só voltam ao servidor se algum navegador ainda as tiver na fila ou na cópia local. Por isso, faça backup com frequência.

## 8. Logs

```
docker compose logs -f server
```

Cada linha é um JSON com hora, método, modelo de rota (por exemplo `/api/v1/projects/:projectId/records`), situação, duração e, quando há, o id opaco do projeto. **Nunca** há corpo de requisição, e-mail, segredo, nome de projeto ou texto cifrado; o e-mail do pedido de sal vai no corpo, não na URL, justamente para não aparecer em logs de proxies. Erros internos registram só o tipo do erro. O compose limita os logs a 5 arquivos de 10 MB por serviço.

## 9. Cuidados de operação

- Deixe abertas só as portas 80 e 443 (e o SSH, se for VPS). O `server` não publica porta no host.
- O contêiner do `server` roda como usuário sem privilégios (`node`), com sistema de arquivos só de leitura, sem capacidades do Linux e com `no-new-privileges`; só `/data` e `/tmp` são graváveis.
- O limite de tentativas de entrar é por IP (30 por minuto) e por e-mail (10 falhas a cada 15 minutos). Há ainda limites por IP para o pedido do sal de login (60 por minuto) e para toda a API (600 por minuto) e por conta para criar projeto e incluir integrante (60 por minuto); os valores estão em `apps/server/src/config.ts` e os contadores zeram ao reiniciar.
- Quem administra o servidor vê o que está no `19` §7 e pode apagar ou reter dados, mas não lê nem altera os projetos sem ser detectado (`19` §11).

## 10. Desenvolvimento

```
cd web
pnpm install
pnpm server          # API em http://localhost:8080, dados em web/apps/server/.data
pnpm --filter @opesvault/server build    # o pacote único dist/server.mjs, como na imagem
```

Navegadores aceitam cookie `Secure` em `http://localhost`, então o padrão funciona em desenvolvimento. Os testes (`pnpm check`) sobem o servidor no próprio processo, numa porta aleatória e numa pasta temporária, e rodam a suíte de contrato contra ele.

## 11. Problemas comuns

| Sintoma                                               | Causa provável                                    | O que fazer                                                                                                       |
| ----------------------------------------------------- | ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `server` não fica "healthy"                           | Segredo curto ou volume sem permissão             | `docker compose logs server`; `OPESVAULT_SECRET` precisa de 32 caracteres; o volume precisa pertencer ao uid 1000 |
| Certificado não sai                                   | DNS ainda não aponta, ou portas 80/443 bloqueadas | `docker compose logs caddy`; conferir DNS e firewall                                                              |
| Todos deixam de conseguir entrar depois de reinstalar | Segredo do servidor mudou                         | Restaurar o arquivo `secret` (ou o `OPESVAULT_SECRET`) do backup                                                  |
| Navegador mostra "offline"                            | Servidor parado ou atualizando                    | `docker compose ps`; as alterações ficam na fila do navegador                                                     |
| `docker build` falha com erro de certificado          | Proxy com inspeção de TLS                         | §4, construção com `--secret id=extra_ca`                                                                         |
