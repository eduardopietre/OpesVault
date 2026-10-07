# Segurança da versão web: chaves, cofre, sincronização e bloqueio

Versão 1.2 • 06/10/2026 (§12.1, revisão de segurança de W12). Documento normativo da web, sucessor do `03` (que continua valendo para o desktop até W13). Distingue requisito de produto de garantia criptográfica, como o `03`. Implementação: `web/packages/crypto` e `web/packages/vault`; servidor: `web/apps/server`. Decisões do usuário em `18` §1; escolhas marcadas como **adotado provisoriamente, revisável** dependem do `18` §8.

## 1. Escopo

Vale para tudo que toca dados do projeto na web: senha do projeto, senha da conta, chaves, registros, anexos, cache no navegador, tráfego e servidor. Se este documento e o `03` divergirem sobre a web, vale este. Mudar primitiva, parâmetro, formato ou o que o servidor recebe exige revisão deste documento e testes de vetor conhecido.

## 2. Modelo de ameaça

**Zero-knowledge:** a senha do projeto, a chave do projeto e o conteúdo dos registros nunca saem do navegador em claro. O servidor autentica contas, guarda texto cifrado e sincroniza. Isso protege contra:

| Quem                                                                             | O que consegue                                                                                                                                                              | O que não consegue                                                                                                                                   |
| -------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Operador do servidor, ou quem copiar o banco, o volume `/data` ou um backup dele | Ver os metadados da §7; apagar, reter ou devolver versões antigas de registros (§11)                                                                                        | Ler registros, anexos, nomes de projeto ou a senha; alterar um registro sem que a alteração seja detectada; mover um registro de lugar ou de projeto |
| Quem observa a rede                                                              | Com TLS (Caddy, `20`): só tamanhos e horários                                                                                                                               | Ler ou alterar o tráfego                                                                                                                             |
| Aparelho roubado ou perdido, **bloqueado**                                       | Ler o IndexedDB: texto cifrado, envelope, cursor e e-mail da sessão (cookie)                                                                                                | Abrir o projeto sem a senha; o Argon2id (§3) encarece cada tentativa                                                                                 |
| Aparelho roubado ou perdido, **desbloqueado**                                    | Tudo o que a aba mostra, enquanto não houver bloqueio por inatividade (§9)                                                                                                  | —                                                                                                                                                    |
| Script injetado na aba (XSS, dependência comprometida, extensão do navegador)    | Enquanto o projeto está desbloqueado, **tudo**: ler os registros em memória, usar as chaves (mesmo não extraíveis) para decifrar e cifrar, capturar a senha quando digitada | Ler os bytes das chaves de trabalho (`CryptoKey` não extraível), mas isso não o impede de usá-las                                                    |
| Integrante removido                                                              | Continua sabendo a senha compartilhada e pode ter guardado a chave do projeto e cópias do texto cifrado                                                                     | Obter registros novos do servidor (perde o acesso na hora)                                                                                           |

Não se promete proteção contra malware no aparelho, extensões maliciosas do navegador, keylogger, captura de tela ou inspeção da aba desbloqueada, como no `03` §1. Senha compartilhada não isola integrantes (`03` §1, `18` §1): qualquer integrante com a senha lê e altera tudo.

**Script injetado é o pior cenário**, porque a chave fica na aba enquanto desbloqueada (`18` §1). As defesas são de prevenção (`18` §3.7): CSP estrita sem `unsafe-inline` nem `unsafe-eval`, Trusted Types, nenhum script de terceiros, nenhum CDN, cabeçalhos da §12, auditoria do lockfile. Não existe mitigação criptográfica para um script que roda dentro da aba desbloqueada.

## 3. Primitivas e parâmetros

Nada caseiro (`03` §2): WebCrypto para HKDF, AES-GCM e HMAC; `hash-wasm` (implementação de referência do Argon2 compilada para WebAssembly) para o Argon2id.

| Uso                               | Primitiva                     | Parâmetros                                                                                                                                    |
| --------------------------------- | ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Senha do projeto e senha da conta | Argon2id (RFC 9106)           | **64 MiB, 3 passadas, 1 via, saída de 32 bytes, sal de 16 bytes** — adotado provisoriamente, revisável (`18` §8: medir no celular mais fraco) |
| Derivação de chaves               | HKDF-SHA256 (RFC 5869)        | `info` com rótulo e versão (§4)                                                                                                               |
| Cifra                             | AES-256-GCM (NIST SP 800-38D) | Nonce de 96 bits aleatório por cifração; etiqueta de 128 bits                                                                                 |
| Id opaco de registro              | HMAC-SHA256                   | Truncado a 128 bits (32 hexadecimais)                                                                                                         |
| Aleatoriedade                     | `crypto.getRandomValues`      | —                                                                                                                                             |

- Os parâmetros do Argon2id viajam com cada envelope, então podem subir depois sem quebrar envelopes antigos. Ao abrir, o app só aceita parâmetros entre 8 MiB e 1 GiB, 1 a 16 passadas e 1 a 4 vias; fora disso recusa antes de derivar (um envelope hostil não esgota a memória da aba).
- Senhas são normalizadas em Unicode NFC antes de virar bytes, para que a mesma senha digitada em sistemas diferentes abra o projeto. Senha nova vazia é recusada.
- Vetores conhecidos (`web/packages/crypto/test`): RFC 5869 caso 1, RFC 4231 caso 2, GCM caso 16, vetor de referência do Argon2id e comparação com uma segunda implementação (`@noble/hashes`). Os formatos do OpesVault têm vetores próprios com aleatoriedade fixa, injetada **só nos testes**.

## 4. Hierarquia de chaves

```
senha do projeto ──Argon2id(sal do envelope)──HKDF "opesvault/envelope/password/v1"──► chave de envelope (senha)
chave de recuperação ──HKDF(sal de recuperação) "opesvault/envelope/recovery/v1"──► chave de envelope (recuperação)

chave do projeto (256 bits aleatórios, gerada no navegador)
  ├─ embrulhada pela chave de envelope (senha)        ┐ o envelope (§6.1)
  ├─ embrulhada pela chave de envelope (recuperação)  ┘
  └─ HKDF ─► "opesvault/records/v1"       chave dos registros (AES-256-GCM)
           ─► "opesvault/record-id/v1"     chave dos ids opacos (HMAC-SHA256)
           ─► "opesvault/project-name/v1"  chave do nome do projeto (AES-256-GCM)
           ─► "opesvault/blob-key/v1"      chave que embrulha a chave de cada anexo (AES-256-GCM)
           ─► "opesvault/device-snapshot/v1" chave do retrato do projeto neste aparelho (AES-256-GCM, §8)

senha da conta ──Argon2id(sal de login do servidor)──HKDF "opesvault/login/v1"──► segredo de login (§5)
```

- A **chave do projeto** é a mesma para todos os integrantes e não muda (não há rotação, §11). Trocar a senha ou a chave de recuperação só refaz o embrulho.
- A **chave de recuperação** tem 160 bits aleatórios, exibidos uma vez em nove grupos de quatro caracteres Crockford base32 (oito de chave e um de verificação, por exemplo `7MZ3-YG21-…-RXFS`). A leitura aceita minúsculas, espaços, falta de hífens, O por 0 e I ou L por 1; o grupo de verificação distingue "digitada errada" de "chave errada". Por ter entropia alta, dispensa Argon2id.
- Os bytes crus da chave do projeto existem só durante a criação, o desbloqueio, a troca de senha e a regeneração da chave de recuperação. Logo depois viram `CryptoKey` **não extraíveis** e os bytes são sobrescritos com zeros (`wipe`). Nenhuma chave vai para `localStorage`, `sessionStorage`, IndexedDB, log ou servidor.

## 5. Contas e login

- Cada pessoa tem sua conta no servidor (e-mail e senha da conta). A senha da conta **não é** a senha do projeto: uma abre a conta, a outra abre os dados. O dono adiciona integrantes pelo e-mail da conta.
- O navegador pede ao servidor o **sal de login** do e-mail (no corpo de um POST, para o e-mail nunca aparecer numa URL ou em log de proxy), deriva o segredo de login (§4) e envia só ele. A senha da conta não sai do navegador.
- O sal de login é `HMAC-SHA256(segredo do servidor, e-mail normalizado)`, os 16 primeiros bytes. É estável e existe também para e-mails sem conta, para que pedir o sal não revele quem tem conta. Consequência: o **segredo do servidor precisa ser preservado** (está no volume de dados, `20`); trocá-lo invalida todos os logins.
- O servidor guarda só `scrypt(segredo de login, sal aleatório por conta)` e compara em tempo constante. Mesmo com o banco vazado, cada tentativa contra a senha da conta custa um Argon2id mais um scrypt.
- E-mails são normalizados (NFC, sem espaços nas pontas, minúsculas) dos dois lados.
- Sessão: token aleatório de 256 bits em cookie `HttpOnly`, `Secure`, `SameSite=Strict`; o servidor guarda só o SHA-256 do token. Tentativas de entrar têm limite por IP e por e-mail (§12).

## 6. Formatos

### 6.1 Envelope

```
{ version: 1,
  kdf: { algorithm: "argon2id", memoryKiB, iterations, parallelism, salt },
  wrappedByPassword, recoverySalt, wrappedByRecovery,      (base64url)
  revision }                                               (do servidor)
embrulho = 0x01 ‖ nonce(12) ‖ AES-256-GCM(chave de envelope, chave do projeto, AAD)
AAD      = 0x01 ‖ "opesvault/envelope/v1|" + idDoProjeto + "|" + ("password" | "recovery")
```

O AAD prende o embrulho ao projeto e ao propósito: um envelope copiado para outro projeto, ou um embrulho trocado de campo, não abre. Senha que não abre o envelope é `wrong_password` e **nunca** cria projeto novo (`03` §4). O envelope é substituído só com a revisão esperada (`putEnvelope`); duas trocas simultâneas viram conflito, nunca sobrescrita.

### 6.2 Registro

```
texto claro = JSON {kind, id, payload} completado com espaços até múltiplo de 64 bytes
id opaco    = hex(HMAC(chave dos ids, kind + "\n" + id))[0:32]
cifrado     = 0x01 ‖ nonce(12) ‖ AES-256-GCM(chave dos registros, texto claro, AAD)
AAD         = 0x01 ‖ "opesvault/record/v1|" + idDoProjeto + "|" + idOpaco
```

- Tipo, id real, datas e valores ficam **dentro** da cifra. O `(tipo, id, JSON)` do `Ledger` é mantido.
- Ao abrir, o app confere a etiqueta GCM (adulteração), o AAD (registro movido para outro id ou outro projeto) e recalcula o id opaco a partir do conteúdo (registro trocado de lugar). Falha em qualquer um: o registro é listado como **danificado** e não entra no livro.
- O completamento até 64 bytes esconde o tamanho exato; tamanhos aproximados continuam visíveis (§7).
- A revisão **não** entra no AAD (diferente da proposta inicial do `18` §3.2): a revisão é dada pelo servidor depois do envio, então o navegador não a conhece ao cifrar. A consequência é a da §11 (o servidor pode devolver uma versão antiga do mesmo registro).

### 6.3 Nome do projeto

AES-256-GCM com a chave do nome e AAD `"opesvault/project-name/v1|" + idDoProjeto`. O servidor lista projetos sem saber os nomes. Consequência: **o nome só aparece depois de desbloquear**; antes, a lista mostra o que o servidor sabe (data de criação, papel e integrantes).

### 6.4 Anexo

```
"OVB1" ‖ tamanho do bloco (u32) ‖ chave do anexo embrulhada (0x01 ‖ nonce ‖ chave ‖ etiqueta) ‖ blocos
bloco i = AES-256-GCM(chave do anexo, nonce = contador i, até 1 MiB, AAD)
AAD     = "opesvault/blob/v1|" + idDoProjeto + "|" + idDoAnexo + "|" + i + "|" + final(0/1) + "|" + tamanhoDoBloco
```

Cada anexo tem chave própria e aleatória, por isso o nonce pode ser contador. O AAD impede reordenar, cortar, trocar de anexo ou de projeto e mudar o tamanho do bloco. Anexos só são baixados e decifrados quando exibidos e ficam numa memória limitada (64 MiB) enquanto o projeto está desbloqueado; nunca vão para o disco em claro.

### 6.5 Ids

Projeto, registro e anexo: 128 bits em 32 hexadecimais minúsculos. O id do projeto é escolhido pelo navegador (entra no AAD do envelope antes de o servidor existir para ele). Ids de conta e de concessão são do servidor. O servidor só deriva caminhos de disco de ids validados por esse padrão.

## 7. O que o servidor vê

| Vê                                                                                                       | Não vê                                                   |
| -------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| E-mail de cada conta, data de criação, IPs e horários das requisições                                    | Senha da conta (só um derivado, guardado com scrypt)     |
| Quais contas são integrantes de cada projeto e quem é dono                                               | Senha do projeto, chave do projeto, chave de recuperação |
| Quantidade de registros por projeto, tamanho aproximado de cada um (múltiplos de 64 bytes) e quando muda | Tipo, id real e conteúdo dos registros                   |
| Quais registros mudam juntos (um envio) e com que frequência                                             | Nome do projeto                                          |
| Quantidade, tamanho e horário dos anexos                                                                 | Conteúdo dos anexos                                      |
| Quem tem a concessão de edição e o rótulo da aba (aleatório)                                             | O que está sendo editado                                 |
| Parâmetros do Argon2id e sais (públicos por projeto)                                                     |                                                          |

Isso é limitação conhecida, como as do `03` §1: o padrão de uso pode revelar, por exemplo, que um projeto recebe muitos lançamentos no começo do mês.

**O servidor guarda só a versão atual de cada registro**, e um registro apagado vira lápide (`ciphertext: null`) na revisão em que foi apagado — adotado provisoriamente, revisável (`18` §8, histórico no servidor). Não há histórico de versões no servidor.

## 8. Cache no navegador (IndexedDB)

- Guarda **só** texto cifrado e metadados de sincronização, por projeto: o envelope (público), o nome selado, o cursor de revisão, cada registro cifrado com sua revisão (lápides incluídas), a fila de alterações pendentes (já cifradas, com a revisão-base) e o retrato do projeto neste aparelho (abaixo).
- É o que permite abrir o projeto sem rede (o envelope em cache basta para desbloquear) e manter alterações ainda não enviadas depois de recarregar a página, com o projeto bloqueado.
- **Retrato do projeto neste aparelho** (W12, `packages/vault`, cache versão 2). Abrir um projeto grande decifrando registro por registro levava segundos demais (50 mil lançamentos, cerca de 100 mil registros). Por isso o cache guarda também, por projeto, um **retrato**: todos os registros já abertos numa geração do cache, num só bloco cifrado com a chave `opesvault/device-snapshot/v1`, derivada da chave do projeto, com o id do projeto e a geração no AAD (um retrato não passa por outro). Ao desbloquear, o app decifra esse bloco e só os registros gravados depois dele; o bloco é lido do IndexedDB enquanto o Argon2id roda. Garantias:
  - continua sendo só texto cifrado no IndexedDB, nunca vai ao servidor nem a outro aparelho, e o teste de varredura (`no_plaintext.test.ts`) passou a cobri-lo, lendo os bytes como texto;
  - é escrito poucos segundos depois de abrir um projeto com 2 000 registros ou mais e de novo quando 500 registros mudaram depois dele, e só quando a memória e o cache dizem o mesmo: nada pendente, em selagem ou em conflito, com a fila de aplicação de páginas segura;
  - a geração do cache sobe a cada transação que grava registros; cada registro guarda a geração em que foi gravado (índice), de modo que "o que veio depois do retrato" é uma faixa do índice; um retrato de geração posterior à do cache nunca é usado;
  - um retrato que não abre (alterado, de outra versão) é apagado e o projeto abre registro por registro, como antes; esquecer o projeto ou o aparelho e criar um projeto apagam o retrato;
  - nenhuma chave sai da thread principal: os Web Workers que decifravam registros em paralelo foram retirados nesta mesma etapa (deixavam a aba acima de 740 MiB);
  - o texto é comprimido (gzip, em fluxo) antes de ser selado (formato 2, W13); um retrato do formato 1, sem compressão, não abre, é apagado e escrito de novo. Comprimir antes de cifrar é seguro aqui: o retrato fica no aparelho e ninguém consegue misturar texto escolhido nele e observar o tamanho resultante, que é o que um ataque do tipo CRIME exige.
- **Primeiro download** (W13): num aparelho que nunca abriu o projeto, as páginas baixadas são gravadas cifradas, várias por transação, e abertas juntas no fim. Cada transação grava também o cursor e a marca de download em andamento, então o cache fica consistente se a abertura for cancelada ou a aba fechada no meio: a próxima abertura continua de onde parou. Cancelar descarta tudo o que já estava decifrado na memória e deixa o projeto bloqueado.
- Um teste (`web/packages/vault/test/no_plaintext.test.ts`) grava registros, anexo, nome, troca de senha e chave de recuperação, depois vasculha todo o IndexedDB e todo argumento enviado ao servidor procurando conteúdo, tipo, id real, nome, senhas e chave de recuperação. Nada pode aparecer.
- O app pede `navigator.storage.persist()` para o navegador não apagar o IndexedDB sob pressão de espaço. Mesmo assim, o navegador ou o usuário podem apagá-lo: alterações pendentes se perdem com ele. Por isso a sincronização é frequente, o app avisa quando há pendências ao fechar a aba (`18` §3.3) e, quando o navegador recusa a persistência e há alterações ainda não enviadas, mostra um aviso fixo abaixo da barra superior (W13).
- `localStorage` e `sessionStorage` não recebem nada do projeto (regra de lint). Preferências do aparelho, como o rótulo da aba, ficam fora do projeto.

## 9. Sessão, bloqueio e sincronização

### 9.1 Desbloquear e bloquear

- **Desbloquear** busca o envelope no servidor (ou no cache, sem rede), deriva a chave de envelope, abre a chave do projeto, decifra o cache, aplica as pendências, puxa as novidades e tenta obter a concessão de edição. O servidor nunca participa da decifração.
- **Bloquear** (botão, inatividade ou fechar a aba) descarta as chaves, todos os registros em claro, os anexos decifrados (sobrescritos com zeros), conflitos e temporizadores. Alterações ainda não enviadas ficam cifradas no IndexedDB; ao bloquear, o app ainda tenta enviá-las (texto cifrado, sem chave) e devolve a concessão de edição.
- O **bloqueio por inatividade** é configurável e conta a partir da última interação (teclado, ponteiro, toque, rolagem). Diferente do desktop (`03` §5), aqui ele apaga a chave: não é só ocultar a janela.

### 9.2 Um editor por vez

- Uma concessão de edição por projeto, de 60 s, renovada a cada 20 s enquanto a aba vive. Sem ela, escrever registros ou anexos é recusado pelo servidor (`no_lease`).
- Outra aba ou aparelho abre **só para leitura**, mostra quem está editando, puxa as novidades periodicamente e pode **assumir** a edição explicitamente. Quem perde a concessão passa a só leitura sem perder o que já tinha registrado: as pendências ficam na fila e voltam a subir quando a concessão for recuperada, com conferência de conflito.
- A mesma aba recarregada (mesmo rótulo de aba e mesma conta) recupera a própria concessão sem precisar assumir.
- Sem rede, a aba que era editora continua editando; as alterações esperam na fila.

### 9.3 Conflitos

- Cada alteração leva a revisão em que se baseou. O servidor recusa o envio inteiro se qualquer registro mudou depois dessa revisão (tudo ou nada).
- **Conflito nunca é resolvido em silêncio.** O app lista cada conflito com a versão local e a do servidor; a alteração local continua pendente até o usuário escolher manter a sua ou aceitar a do servidor.

### 9.4 Queda de rede no meio do envio

Se a resposta de um envio se perde, o app não sabe se ele foi aceito e **não reenvia às cegas**: puxa primeiro. Um registro puxado com texto cifrado idêntico ao pendente prova que o envio foi aceito (o nonce aleatório torna a coincidência impossível na prática); a pendência é dada por enviada. Assim nada se perde nem se duplica (`18` W2).

## 10. Senha e chave de recuperação

- **Criar projeto:** gera a chave do projeto, o envelope (senha e recuperação) e o nome selado. A chave de recuperação é **mostrada uma vez** e nunca é guardada nem enviada pelo app. Sem senha e sem chave de recuperação, não há recuperação (`03` §7): não existe porta dos fundos no servidor.
- **Trocar a senha:** exige a senha atual, gera sal novo e refaz só o embrulho da senha. Todos os integrantes passam a usar a nova (senha compartilhada).
- **Recuperar:** a chave de recuperação abre a chave do projeto e o usuário define uma senha nova (precisa do servidor, para gravar o envelope novo). A chave de recuperação continua valendo até ser regenerada.
- **Regenerar a chave de recuperação:** exige a senha; o embrulho antigo é substituído e a chave antiga deixa de abrir o envelope atual.
- **Limite:** como a chave do projeto não muda, um envelope antigo continua abrindo com a senha antiga ou a chave de recuperação antiga. Quem guardou uma cópia antiga do envelope (um integrante, o operador do servidor, um backup) e conhece a senha antiga ainda chega à chave do projeto. Trocar a senha não expulsa quem já a conhecia; para isso seria preciso rotacionar a chave do projeto e recifrar tudo, o que não existe nesta versão (§11).
- O cache do aparelho pode guardar o envelope anterior a uma troca de senha feita em outro aparelho; sem rede, a senha antiga ainda abre esse aparelho. Com rede, vale sempre o envelope do servidor.

## 11. O que não se promete

- **Limpeza de memória.** JavaScript não oferece apagar memória com garantia: o motor pode copiar ou mover buffers, cadeias de texto (como a senha digitada num campo) são imutáveis e ficam até o coletor de lixo, e a página pode ir para paginação, hibernação ou despejo de memória. O app sobrescreve os bytes que possui, usa chaves não extraíveis e descarta referências ao bloquear; isso encurta a vida dos segredos, não a garante (`03` §2).
- **Servidor malicioso: reter ou voltar no tempo.** O servidor não lê nem altera registros sem ser detectado, mas pode **omitir** registros, **não entregar** alterações de um integrante a outro, ou **devolver a versão anterior** de um registro (a revisão não está no AAD, §6.2), ou servir o projeto inteiro de um backup antigo. Isso é limitação conhecida. Mitigações existentes: o app nunca anda para trás — se o servidor responde com revisão menor que a já vista neste aparelho, o app mantém a cópia local e avisa (`server_behind`); envios com revisão-base que o servidor "esqueceu" viram conflito visível, nunca sobrescrita. Não há, nesta versão, prova de completude (assinatura ou cadeia de hashes do estado), que exigiria chaves por integrante.
- **Integrante removido.** Perde o acesso ao servidor, mas não esquece a senha nem a chave do projeto que já usou; pode ler cópias antigas que tenha guardado. Não há rotação da chave do projeto.
- **Metadados.** O que está na §7.
- **Script na aba.** O que está na §2.
- **Apagamento do IndexedDB pelo navegador.** Alterações não enviadas se perdem (§8).

## 12. Regras para o código (normativas)

- Senha, chave, segredo de login, chave de recuperação e conteúdo de registro nunca vão para log, mensagem de erro, URL, `localStorage`, `sessionStorage` ou servidor. Erros de cripto levam só um código (`CryptoError.code`).
- Criptografia só pelo `packages/crypto`. Nenhuma primitiva nova sem vetor conhecido e revisão deste documento.
- Chave em `CryptoKey` não extraível sempre que possível; bytes crus de chave só onde inevitável, sobrescritos depois do uso.
- Aleatoriedade injetável só em testes (vetores conhecidos); o código de produção usa `crypto.getRandomValues`.
- O `packages/vault` não importa o domínio (regra de lint) e só conhece `{kind, id, payload}`.
- Servidor (`20`): valida toda entrada com zod, limita tamanho de requisição, limita tentativas de login por IP e por e-mail, exige o cabeçalho `X-OpesVault: 1` em toda requisição que altera (CSRF), registra só método, rota, situação, duração e ids opacos (nunca corpo, e-mail ou segredo), e serve o app com CSP sem `unsafe-inline`/`unsafe-eval` (só `'wasm-unsafe-eval'`, que permite compilar WebAssembly para o Argon2id e não permite `eval` de JavaScript), `require-trusted-types-for 'script'`, `Cross-Origin-Opener-Policy: same-origin`, `Referrer-Policy: no-referrer`, `Permissions-Policy` restritiva, `X-Content-Type-Options: nosniff` e `frame-ancestors 'none'`.

- **Uma política só.** A CSP vem de `web/packages/vault/src/csp.ts`: o servidor a envia como cabeçalho e o build do app a grava como `<meta>`, a partir das mesmas diretivas (teste: o cabeçalho do servidor e o `<meta>` da página construída são iguais, e a página não tem script nem estilo embutido). `default-src 'none'`, sem `blob:` em `worker-src` (os workers são arquivos do próprio app) e sem mídia. A política `trusted-types` tem um único nome, `default`; ela só deixa passar o script do service worker, os workers empacotados em `/assets/<nome>.worker-<hash>.js` (e, só em desenvolvimento, os `.worker.ts` de `/src/`) e o HTML vazio. Nenhum outro caminho do mesmo site (rota da API, anexo) vira script de worker.
- **Integridade dos subrecursos (SRI).** Todo `<script>`, `<link rel="stylesheet">` e `<link rel="modulepreload">` do `index.html` construído leva `integrity="sha384-…"`, calculado sobre os bytes gravados em disco (plugin `opesvault-sri` do `vite.config.ts`, antes de o service worker ser gerado, para o pré-cache já ver o `index.html` final); teste em `e2e/security.spec.ts`. Limitação aceita: os blocos carregados sob demanda por `import()` não têm atributo de integridade (o navegador só o oferece por um mapa de importação embutido, que a CSP proíbe); são do mesmo site, cobertos pela CSP e pelo pré-cache.
- **Limites de uso no servidor:** entrar e criar conta (30 por minuto por IP, e 10 falhas por e-mail em 15 minutos), pedido do sal de login (60 por minuto por IP), criação de projeto e inclusão de integrante (60 por minuto por conta cada; a inclusão revela se um e-mail tem conta, então não pode ser sondada em massa) e um teto para toda a API (600 por minuto por IP, fora `/health`). Os contadores ficam na memória do processo e zeram ao reiniciar: aceito, o servidor é um único processo.
- **PDF não é de confiança.** Toda abertura de PDF (extração e visualização) usa `isEvalSupported: false` e `enableXfa: false`, sem busca sob demanda; o teste de segurança abre um PDF hostil (ações de JavaScript e de execução, arquivo embutido, 1500 páginas e laço na árvore de páginas) por Importar e como comprovante.

### 12.1 Revisão de segurança de W12 (06/10/2026)

Escopo: CSP e cabeçalhos, SRI, dependências, injeção, servidor e imagem Docker. Testes em `web/apps/app/e2e/security.spec.ts`, `web/apps/app/e2e-real/real.spec.ts` (`pnpm --filter @opesvault/app e2e:real`, servidor e SQLite reais) e `web/apps/server/test/security.test.ts`.

| #   | Achado                                                                                                                                                                                                                                                                                              | Gravidade                          | Situação                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | O cabeçalho do servidor (`default-src 'none'`, sem `trusted-types`) e o `<meta>` do app (`default-src 'self'`, com `trusted-types default`) eram duas políticas escritas em dois lugares                                                                                                            | média                              | Corrigido: fonte única (§12), com teste de igualdade                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| 2   | `worker-src` e `media-src` aceitavam `blob:` sem necessidade                                                                                                                                                                                                                                        | baixa                              | Corrigido: removidos; o leitor de PDF e os cálculos seguem funcionando                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 3   | A regra de Trusted Types para workers aceitava qualquer caminho do site terminado em `.worker-*.js`, inclusive rotas da API                                                                                                                                                                         | baixa                              | Corrigido: só `/assets/` na raiz, sem parâmetros nem credenciais (teste unitário com os desvios)                                                                                                                                                                                                                                                                                                                                                                                             |
| 4   | Sem SRI nos arquivos construídos                                                                                                                                                                                                                                                                    | média                              | Corrigido (§12). A primeira versão calculava o hash antes de o Vite terminar de alterar os blocos e o navegador bloqueava o app inteiro; achado pelo teste com o servidor real, e o hash passou a ser lido do disco                                                                                                                                                                                                                                                                          |
| 5   | Só entrar e criar conta tinham limite; o pedido do sal, a criação de projeto, a inclusão de integrante e o resto da API não                                                                                                                                                                         | média                              | Corrigido (§12)                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 6   | Depois de recarregar a página o app exigia a senha da conta de novo, apesar do cookie de sessão válido (a §2 e a §9 supõem que a sessão sobrevive à aba)                                                                                                                                            | média (uso), sem efeito nas chaves | Corrigido: `restoreAccount` lê `GET /auth/session`; a senha da conta nunca é guardada, e a do projeto continua sendo pedida                                                                                                                                                                                                                                                                                                                                                                  |
| 7   | O visualizador de PDF (`pdf_render.ts`) abria o arquivo com as opções padrão do pdf.js (`isEvalSupported`, XFA)                                                                                                                                                                                     | média                              | Corrigido: opções restritas (§12)                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 8   | Fixação de sessão, saída, CSRF e CORS                                                                                                                                                                                                                                                               | —                                  | Verificados e cobertos por teste: o servidor nunca adota um token enviado pelo cliente, cada entrada gera um token novo, a saída apaga a sessão no servidor (o token roubado deixa de valer), as 16 rotas que alteram dados recusam a requisição sem `X-OpesVault: 1` antes de qualquer outra coisa e não há CORS                                                                                                                                                                            |
| 9   | Injeção: texto hostil (marcação, URL `javascript:`, prefixos `=+-@`, bidirecional e largura zero, 4000 caracteres, laço de modelo) digitado em todos os campos de texto dos diálogos de Livro, Contas e cartões, Recorrências, Metas, Investimentos e em nome do projeto, busca e arquivo importado | —                                  | Nada executa, nenhum pedido sai do endereço, nenhum erro é registrado (o React escreve texto; não há `innerHTML` nem `dangerouslySetInnerHTML`; o ECharts usa texto rico)                                                                                                                                                                                                                                                                                                                    |
| 10  | O que o servidor guarda em disco                                                                                                                                                                                                                                                                    | —                                  | Só texto cifrado, ids, tamanhos, horários, e-mails e participação, verificado lendo o `opesvault.db`, o `-wal` e os anexos depois de uma sessão real no navegador (conta, projeto, conta do livro, lançamento): nenhum nome, descrição, valor, senha ou chave de recuperação. O rótulo da concessão de edição é aleatório (§7). O registro do servidor não leva IP, corpo, e-mail nem texto cifrado                                                                                          |
| 11  | Dependências                                                                                                                                                                                                                                                                                        | —                                  | `pnpm audit` (produção e todas): nenhuma vulnerabilidade conhecida. O lockfile tem 731 pacotes com hash de integridade, nenhum vindo de repositório de código ou de endereço avulso; o único script de instalação permitido é o do `esbuild` (`onlyBuiltDependencies`); o pnpm 10 bloqueia os demais                                                                                                                                                                                         |
| 12  | **A exportação CSV não neutraliza prefixos de fórmula** (`=`, `+`, `-`, `@`): uma descrição como `=HYPERLINK(…)` vira fórmula ao abrir o arquivo numa planilha. Os nomes de estabelecimento vêm de extratos e faturas, isto é, de arquivos de fora                                                  | **média**                          | **Não alterado, para decisão do usuário:** o desktop (`exports.py`, `ledger_csv`) também grava o texto como está, e a web tem paridade de exportação com ele (`18` §3.2). Mudar exige alterar os dois (por exemplo, prefixar `'` em células de texto que começam com esses caracteres, ou uma opção "para planilha") e o arquivo de referência de paridade. O teste de segurança só garante que a estrutura do CSV não se quebra (14 colunas por linha, aspas e ponto e vírgula preservados) |
| 13  | A inclusão de integrante responde 404 para e-mail sem conta, e a criação de conta responde 409 para e-mail existente: dá para sondar quais e-mails têm conta                                                                                                                                        | baixa                              | Aceito: o convite precisa dessa resposta; agora há limite por IP e por conta                                                                                                                                                                                                                                                                                                                                                                                                                 |
| 14  | A sessão dura 30 dias e sair de uma aba não encerra as outras sessões da conta                                                                                                                                                                                                                      | baixa                              | Aceito; sem troca de senha de conta nesta versão, não há o que revogar em massa                                                                                                                                                                                                                                                                                                                                                                                                              |
| 15  | O assistente de primeiros passos coleta integrantes, contas e cartões e **não grava** nada (`SetupScreen` sem `onFinish`)                                                                                                                                                                           | funcional                          | Corrigido na W12: o assistente aplica tudo pelo `onboarding.applySetup` (`18` §10); o teste com o servidor real confere a conta criada por ele                                                                                                                                                                                                                                                                                                                                               |

## 13. Backup, restauração e verificação

Arquivo cifrado com **o mesmo segredo do projeto (a senha do projeto)**, feito e lido só no navegador, sem rede (`18` W11). Substitui, na web, o `03` §7. Implementação: formato em `web/packages/crypto/src/backup.ts`, exportar, verificar e restaurar em `web/packages/vault/src/backup.ts`, testes em `web/packages/{crypto,vault}/test/backup.test.ts`. Mudar qualquer byte do formato exige subir a versão (campo `version`) e o vetor conhecido do teste.

### 13.1 Formato (versão 1)

```
arquivo = cabeçalho (32 bytes) ‖ conferência da chave (16 bytes) ‖ bloco 0 ‖ bloco 1 ‖ … ‖ último bloco
cabeçalho = "OVBK" ‖ versão u8 ‖ id do KDF u8 (1 = Argon2id) ‖ vias u8 ‖ passadas u8 ‖ memória KiB u32 ‖ tamanho do bloco u32 ‖ sal (16 bytes)
chave     = HKDF-SHA256(Argon2id(senha NFC, sal, parâmetros do cabeçalho), info "opesvault/backup/v1")      (AES-256-GCM, não extraível)
conferência = AES-256-GCM(chave, texto vazio, nonce = contador 0xFFFFFFFF, AAD = "opesvault/backup/v1|check|" ‖ cabeçalho)
bloco i   = AES-256-GCM(chave, texto claro de exatamente "tamanho do bloco" bytes (o último, de 1 a esse tamanho),
            nonce = 8 bytes zero ‖ i u32, AAD = "opesvault/backup/v1|chunk|" ‖ cabeçalho ‖ i u32 ‖ final u8)
```

Os números são big-endian. O texto claro é um fluxo de **quadros** cortado em blocos de 1 MiB (padrão; aceito de 256 B a 16 MiB), de modo que um registro ou um anexo pode atravessar blocos e a memória nunca guarda mais que um bloco e o quadro em montagem:

| Quadro                          | Conteúdo                                                                                                               |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `0x01` META (sempre o primeiro) | tamanho u32 ‖ JSON `{format, createdAt, projectName, app}`                                                             |
| `0x02` registro                 | tamanho u32 ‖ JSON `{kind, id, payload}` (o `(tipo, id, JSON)` do `Ledger`, em claro dentro da cifra)                  |
| `0x03` anexo                    | id do anexo (16 bytes) ‖ tamanho u32 ‖ bytes do anexo (já decifrados do cofre)                                         |
| `0xFF` END (sempre o último)    | tamanho u32 ‖ JSON `{records, blobs, missing}`; `missing` lista anexos que os registros citam mas o servidor não tinha |

Ordem gravada: META, todos os registros, todos os anexos, END.

### 13.2 O que cada escolha garante

- **Nada em claro, só o cabeçalho.** Nem o nome do projeto, nem o número de registros, nem os tipos. O cabeçalho mostra a versão, os parâmetros do KDF, o tamanho do bloco e o sal. O nome sugerido para o arquivo é neutro (`opesvault-backup-AAAA-MM-DD.ovbackup`), sem o nome do projeto.
- **Uma chave por arquivo.** O sal é aleatório a cada backup, então a chave nunca se repete e o nonce pode ser um contador (como nos anexos, §6.4). Parâmetros do Argon2id: os da §3 (64 MiB, 3 passadas, 1 via). Ao abrir valem os limites da §3 e o tamanho de bloco entre 256 B e 16 MiB, recusados **antes** de derivar a chave.
- **Integridade do arquivo todo.** O AAD de cada bloco amarra o cabeçalho inteiro (outro KDF, outro tamanho de bloco ou outro sal não abrem), a posição (reordenar, repetir ou tirar um bloco do meio falha) e o indicador de final (cortar o arquivo na fronteira de um bloco falha, porque o novo último bloco foi selado como "não final"; acrescentar dados falha porque o antigo último bloco passa a ser lido como "não final"). Blocos de outro backup, mesmo com a mesma senha, não abrem (outro sal, outra chave). Depois do END não pode haver mais nada, e as contagens do END têm de bater com o que foi lido.
- **Senha errada é distinta de arquivo danificado.** A conferência da chave (uma etiqueta GCM sobre texto vazio, presa ao cabeçalho) diz `wrong_password` sem ler conteúdo; depois dela, qualquer falha de bloco é `corrupted`. Um cabeçalho alterado aparece como senha errada (a conferência o cobre).
- **Erros.** `BackupError` leva só um código (`not_a_backup`, `unsupported_version`, `invalid_params`, `wrong_password`, `empty_password`, `corrupted`, `invalid_content`), nunca senha, nome ou conteúdo (§12). Versão desconhecida é recusada com mensagem própria, sem tentar ler.

### 13.3 Operações

- **Exportar.** Exige o projeto desbloqueado e **pede a senha do projeto de novo**: ela é conferida contra o envelope (`checkPassword`, sem abrir nada) e é a que protege o arquivo, para que um arquivo nunca fique protegido por uma senha digitada errada. Lê os registros da memória e os anexos do servidor (decifrados um por vez); não escreve nada no servidor. Um anexo que o servidor não tem entra em `missing` e o backup sai mesmo assim, com aviso; qualquer outra falha (sem conexão, bloqueado) interrompe, para não gerar um backup incompleto sem a pessoa saber. Os blocos cifrados vão para uma lista de partes de `Blob`; nada em claro vai para disco.
- **Verificar.** Decifra o arquivo inteiro, bloco a bloco, sem tocar em nenhum projeto, e confere: versão, senha, integridade, contagens, anexos citados por registros (`dangling`: citado e ausente de `missing`), SHA-256 de cada anexo contra o do registro (`hashMismatches`) e anexos que ninguém cita (`orphans`).
- **Restaurar.** Sempre num projeto **novo**, nunca sobre um existente: primeiro a verificação completa (um arquivo ruim não cria nada), depois `ProjectVault.create` (chave do projeto nova, **chave de recuperação nova**, mostrada uma vez) com a senha do arquivo, e então os registros em lotes e cada anexo com o **mesmo id** (os registros de documento continuam apontando para ele; ids de anexo valem por projeto). Se algo falhar depois de o projeto existir no servidor, ele é apagado de novo. A senha do projeto restaurado é a do arquivo (um backup antigo mantém a senha antiga, como no `03` §7); o nome é o do arquivo ou o que a pessoa digitar, e a pessoa pode trocar a senha em Configurações depois.
- **Limites conhecidos.** Quem tem o arquivo pode tentar adivinhar a senha **sem o limite de tentativas do servidor**; só o Argon2id encarece cada tentativa, então vale uma senha longa. Um backup é um instante: trocar a senha do projeto não altera backups antigos, e quem conhecia a senha antiga continua abrindo os arquivos antigos. A lista de partes de `Blob` do arquivo exportado fica na memória da aba (os navegadores costumam mandar `Blob` grande para o disco, mas isso não é garantido); a gravação direta em arquivo por fluxo (File System Access API) fica para depois e não muda o formato.
- **Lembrete.** A data do último backup gerado fica numa **preferência deste aparelho** por projeto (o arquivo está neste aparelho; um backup feito em outro não protege este, e o esquema persistido do projeto não muda). O aviso do domínio (`dom.alerts.backupAlert`) aparece na Visão geral quando passa de 30 dias, ou quando o projeto tem lançamentos e nunca houve backup neste aparelho.

## 14. Referências

- RFC 9106 — Argon2 Memory-Hard Function for Password Hashing.
- RFC 5869 — HMAC-based Extract-and-Expand Key Derivation Function (HKDF).
- NIST SP 800-38D — Galois/Counter Mode (GCM).
- RFC 4231 — Identifiers and Test Vectors for HMAC-SHA-224, -256, -384 e -512.
- RFC 7914 — The scrypt Password-Based Key Derivation Function.
- W3C Web Cryptography API; OWASP Password Storage Cheat Sheet.

Escolhas desta versão são do projeto, não garantias certificadas pelos fornecedores das bibliotecas.
