# Migração para a web: arquitetura e roadmap

Versão 1.2 • 05/10/2026. Registra as decisões do usuário que levam o OpesVault do desktop para a web e o caminho completo até o lançamento hospedado pelo próprio usuário e, depois, ao Firebase. O trabalho acontece na branch `web`. Enquanto durar a migração, este documento prevalece sobre os outros no que tratar da web; no restante, os `docs/` continuam valendo (domínio, cálculos, importação, interface).

## 1. Decisões (05/10/2026)

| Decisão | Escolha | Revê |
|---|---|---|
| Forma do produto | Aplicativo web; **a web substitui o desktop**. O código Qt é removido ao fim da migração (W13) | `02` §1, §7; `00` (offline, Windows) |
| Modelo de segurança | **Zero-knowledge**: senha e chave nunca saem do navegador; o servidor só guarda registros cifrados, autentica e sincroniza | `03` §3 (o worker transitório deixa de existir) |
| Linguagem do domínio | **TypeScript**, reescrito do Python com paridade comprovada por arquivos de referência gerados pelo Python atual (§4) | `02` §3 |
| Interface | **React + TypeScript + Vite**, aplicação estática (SPA) instalável (PWA) | `02` §3, `16` (o sistema visual é portado, não reinventado) |
| Chave durante a sessão | A chave fica na memória da aba enquanto o projeto está desbloqueado, para **sincronizar automaticamente**; bloqueio por inatividade apaga chave e dados abertos | `03` §4 ("Salvar sempre pede senha"), `07` §7 |
| Login | Contas locais no servidor agora; Firebase Auth depois. O servidor recebe só um derivado da senha, nunca a senha nem a chave (§3.3) | — |
| Servidor | Hospedado pelo usuário (Docker); depois Firebase, sem tocar no domínio nem na interface (porta `SyncBackend`, §3.4) | `00` (sem cloud) |
| Cofres existentes | **Sem migração** de cofres do desktop. Projetos começam na web | — |
| Base da branch | `web` parte da `claude/kind-einstein-koj3tq` (inclui IA local em todas as telas e Assistente) | — |
| CI | **Sem CI.** As verificações (`pnpm check`) rodam localmente, como hoje | — |
| Recuperação | **Chave de recuperação** gerada na criação do projeto: também abre o envelope da chave do projeto; mostrada uma vez para o usuário guardar, nunca enviada ao servidor em claro | — |
| Senha do projeto | **Senha compartilhada** por todos os integrantes, como no desktop. Senha compartilhada não isola integrantes (`03` §1) | — |
| Paridade | Todas as telas e diálogos atuais funcionam na web **da mesma forma**, agora responsivos e com animações (§5) | — |

## 2. O que muda e o que continua

**Continua (portado, não reinventado):** partidas dobradas, invariantes, dinheiro exato e `ROUND_HALF_UP` explícito, "desconhecido não é zero", sinais de XIRR e Dietz isolados por método, imposto sem nenhuma tabela embutida, IA como sugestão com aprovação, regras da interface do `16` (uma ação primária, ir ao objeto, gráfico e tabela juntos, mês compartilhado, desfazer por ação), textos em português e o termo "Projeto".

**Muda:**
- O cofre deixa de ser um arquivo SQLCipher e vira um conjunto de **registros cifrados um a um** (§3.2). O formato `(tipo, id, JSON)` do `Ledger` é mantido dentro da cifra.
- O "Salvar com senha" vira **sincronização automática** com estado sempre visível (sincronizado, pendente, offline, conflito).
- Anexos (PDFs) viram blobs cifrados **carregados sob demanda**, o que resolve a dívida de RAM da fase 8.
- O Ollama continua local: é o navegador que chama o Ollama da máquina do usuário (§3.6).
- O app funciona offline como PWA: os registros cifrados ficam no IndexedDB e sobem quando houver conexão.

**Sai:** PySide6, Matplotlib, Nuitka, Inno Setup, worker do cofre, SQLCipher, gates G1–G7 do Windows (`11`, `17`). Saem só em W13, depois da paridade comprovada.

## 3. Arquitetura alvo

### 3.1 Repositório

```
web/                                  monorepo pnpm, TypeScript estrito
├─ packages/
│  ├─ domain/      domínio puro: dinheiro, Ledger, contas, faturas, investimentos, imposto,
│  │               importação, IA (cliente e prompts), Assistente. Sem React, sem DOM, sem rede
│  ├─ crypto/      Argon2id (wasm), HKDF e AES-256-GCM (WebCrypto), envelope de chaves
│  ├─ vault/       registros cifrados, cache IndexedDB, fila offline, porta SyncBackend
│  ├─ backend-http/      adaptador do servidor próprio
│  ├─ backend-firebase/  adaptador do Firebase (W14)
│  └─ ui/          sistema visual: tokens, componentes, animações, gráficos
├─ apps/
│  ├─ app/         a aplicação React (páginas, rotas, shell, PWA)
│  └─ server/      Hono (Node): contas, projetos, registros, blobs, concessão de edição
└─ tools/          verificações de paridade e scripts
scripts/golden/    gerador Python de arquivos de referência (removido em W13; os JSON ficam)
```

O domínio não importa nada de `ui`, `vault` ou rede, e uma regra de lint garante isso, como o domínio Python que hoje não depende de Qt.

### 3.2 Formato dos dados (zero-knowledge)

- **Chave do projeto:** 256 bits aleatórios, gerada no navegador. Cifra todos os registros e anexos.
- **Chave de envelope:** Argon2id(senha do projeto, sal do envelope) e HKDF, com parâmetros fixados no `19` §3. Cifra a chave do projeto (trocar a senha só recifra o envelope). Ver nota 1 da §3.8.
- **Segredo de login:** Argon2id(senha da conta, sal de login do servidor) e HKDF, enviado ao servidor no lugar da senha da conta (o servidor guarda só um hash scrypt dele, `19` §5).
- **Registro:** `{id opaco, revisão, texto cifrado}`. Tipo, id real, datas e valores ficam **dentro** da cifra. AES-256-GCM com nonce aleatório e dados associados `(projeto, id opaco)`, para que um registro não possa ser trocado de lugar nem de projeto. Ver nota 2 da §3.8.
- **Anexo:** blob cifrado com chave própria, embrulhada pela chave do projeto. Só é baixado e aberto quando exibido.
- **O servidor vê:** quantidade, tamanho e horário dos registros e das contas. Nada além disso. Isso é limitação conhecida e documentada, como as do `03` §1.
- **Recuperação:** a chave de recuperação (aleatória, exibida uma vez em grupos legíveis) deriva uma segunda chave de envelope, que embrulha a mesma chave do projeto. Com ela, o usuário define uma senha nova sem o servidor participar da decifração (o servidor só recebe o envelope novo). Sem senha e sem chave de recuperação, não há recuperação.
- **Senha compartilhada:** uma senha por projeto, a mesma para todos os integrantes. O login no servidor é por conta; abrir o projeto é pela senha do projeto.

### 3.3 Sessão, bloqueio e sincronização

- Desbloquear deriva a chave mestra, abre o envelope e decifra os registros na memória da aba. O servidor nunca participa da decifração.
- Cada ação do usuário fecha um passo de desfazer e marca registros como alterados (o `Ledger.dirty` portado). A sincronização envia só esses registros, agrupados e com espera curta.
- **Um editor por vez:** uma concessão de edição por projeto, renovada enquanto a aba vive. Outra aba ou outro aparelho abre só para leitura e pode assumir a edição. Edição simultânea continua fora do escopo (`09` §5).
- Revisão otimista por registro: conflito nunca é resolvido em silêncio. A interface mostra e pede decisão.
- Bloqueio por inatividade e o botão Bloquear apagam chave, dados abertos e desfazer. Alterações ainda não enviadas ficam cifradas no IndexedDB.
- Fechar a aba com alterações pendentes avisa, como o "Salvar e seguir" do `16` §5.

### 3.4 Servidor e porta `SyncBackend`

`SyncBackend` é a única fronteira do app com a rede de dados:

```
signUp / signIn / signOut            (segredo de login, nunca a senha)
listProjects / createProject / deleteProject
getEnvelope / putEnvelope            (chave do projeto embrulhada)
pull(desde a revisão) / push(registros, revisão esperada)
getBlob / putBlob / deleteBlob
acquireEditLease / renewEditLease / releaseEditLease
```

- **`backend-http`** fala com `apps/server`: Hono em Node 22 com SQLite (padrão) ou Postgres, e blobs em disco ou num armazenamento compatível com S3. Distribuição: imagem Docker e `docker compose` com Caddy (TLS automático).
- **`backend-firebase`** (W14): Firebase Auth (o segredo de login vira a "senha" do Firebase), Firestore (`projects/{id}/records/{opaco}`), Cloud Storage para blobs e regras de segurança por integrante do projeto.
- **Suíte de contrato:** os mesmos testes rodam contra cada adaptador. Um adaptador novo só entra quando a suíte inteira passa.
- **Mudar de servidor é copiar texto cifrado.** Como o servidor nunca tem a chave, levar um projeto do servidor próprio para o Firebase não exige abrir os dados.

### 3.5 Tecnologias

| Área | Escolha | Por quê |
|---|---|---|
| Linguagem | TypeScript estrito (`strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`) | Erros de tipo no lugar de erros de valor |
| Dinheiro e quantidades | `decimal.js`, com arredondamento sempre explícito; `number` proibido para dinheiro por regra de lint | Mesma regra do `Decimal` (`02` §6) |
| Datas | `Temporal` (com polyfill): `PlainDate` para datas financeiras, `Instant` para eventos técnicos | Datas locais sem fuso, como o `02` §6 exige |
| Validação na fronteira | `zod` com objetos `strict` | Equivale ao Pydantic com `extra="forbid"` |
| Interface | React 19, Vite, TanStack Router | SPA estática |
| Estado | O `Ledger` do domínio exposto por `useSyncExternalStore`, com seletores memorizados pelo `change_count` | Uma única fonte de verdade, sem cópia em outro store |
| Tabelas | TanStack Table + TanStack Virtual | Livro com 50 mil linhas sem travar |
| Estilo | Tailwind CSS v4 sobre os tokens do `16` §2 em variáveis CSS (claro e escuro) | Tokens em um só lugar, como o `ui/theme.py` |
| Componentes acessíveis | Radix UI (diálogos, menus, abas, popovers, combobox) | Teclado e leitor de tela corretos de saída |
| Animações | Motion (`motion/react`) | Transições de layout, entrada e saída, gestos |
| Gráficos | Apache ECharts (carregado sob demanda) | Animações, tooltip, eixo secundário, zoom e exportação de imagem |
| Formulários | React Hook Form + zod | A validação dos diálogos reaproveita os esquemas do domínio |
| PDF (leitura) | `pdfjs-dist` num Web Worker: texto com posição e renderização em canvas | Substitui `pdfplumber` e `pypdfium2`; nada vai ao disco |
| PDF (relatórios) | `pdf-lib` | Relatório mensal, anual e do imposto gerados no navegador |
| Criptografia | WebCrypto (AES-GCM, HKDF) + `hash-wasm` (Argon2id) | Primitivas padronizadas, nada caseiro (`03` §2) |
| Armazenamento local | IndexedDB (só texto cifrado), `navigator.storage.persist()` | Funciona offline sem expor dados |
| Testes | Vitest, fast-check (propriedades e fuzzing), Playwright (telas, capturas, fluxos), axe-core | Equivalem a pytest, testes de propriedade, `test_every_screen` e auditoria de acessibilidade |
| Lint e formatação | ESLint (flat config, typescript-eslint) + Prettier | Regras próprias: sem `number` para dinheiro, sem `console` com dados, fronteiras entre pacotes |
| Servidor | Hono, Node 22, SQLite/Postgres, Docker | Roda igual em Node, Cloud Run e Functions |

### 3.6 IA local

- O navegador chama o Ollama da máquina do usuário em `http://localhost:<porta>`. O usuário configura `OLLAMA_ORIGINS` com a origem do app, e o app explica como na tela de IA.
- Os prompts versionados (`ai/prompts.py`), a validação pelo significado, a lista de conferência e o Assistente com aprovação explícita de cada alteração são portados sem mudança de regra.
- Mandar texto do projeto para um Ollama no servidor, ou para um modelo de nuvem, quebra o zero-knowledge. Isso fica fora até decisão do usuário (§8).

### 3.7 Segurança no navegador

Com a chave na aba, uma injeção de script é o pior cenário. Por isso:
- CSP estrita, sem `unsafe-inline` nem `unsafe-eval`.
- Trusted Types e nenhum script de terceiros (sem CDN, analytics ou fontes remotas).
- SRI nos arquivos do app e auditoria de dependências no lockfile.
- Nenhum dado em `localStorage`. Preferências do aparelho também ficam fora do projeto.
- Logs só com códigos (o `diagnostics` portado). O servidor não registra corpo de requisição.

### 3.8 Notas de W1 e W2 (05/10/2026)

Ajustes feitos ao implementar a criptografia, o cofre e o servidor. O normativo é o `19`.

1. **Duas senhas, duas derivações.** A versão anterior desta seção derivava a chave de envelope e o segredo de login da mesma "chave mestra". Com a decisão de senha compartilhada por projeto e conta própria por pessoa (§1), são senhas diferentes: a senha da conta gera só o segredo de login; a senha do projeto gera só a chave de envelope.
2. **A revisão não entra nos dados associados do registro.** A revisão é atribuída pelo servidor depois do envio; o navegador não a conhece ao cifrar. O registro fica preso ao projeto e ao id opaco, e o id opaco é conferido contra o conteúdo decifrado. Devolver uma versão antiga do mesmo registro continua possível para um servidor malicioso; é limitação documentada no `19` §11, com a mitigação de nunca andar para trás.
3. **O navegador escolhe o id do projeto** (`createProject(projectId, …)`), porque ele entra nos dados associados do envelope e do nome antes de o projeto existir no servidor.
4. **O nome do projeto só aparece depois de desbloquear** (cifrado com a chave do projeto). A tela de projetos (W7) mostra antes disso o que o servidor sabe: data de criação, papel e integrantes.
5. **Concessão de edição:** a mesma aba recarregada (mesma conta e mesmo rótulo de aba, guardado pelas preferências da aba) recupera a própria concessão sem assumir. Escrever sem a concessão atual é o erro `no_lease`, novo na porta `SyncBackend`.
6. **Escolhas provisórias** (§8), adotadas provisoriamente e revisáveis: Argon2id com 64 MiB, 3 passadas, 1 via e saída de 32 bytes; o servidor guarda só a versão atual de cada registro (lápide para apagados), sem histórico; a IA não sai do navegador.
7. **CSP com `'wasm-unsafe-eval'`.** O Argon2id roda em WebAssembly, e o navegador só compila WebAssembly com essa permissão. Ela não libera `eval` de JavaScript; `unsafe-inline` e `unsafe-eval` continuam proibidos (`19` §12).
8. **Servidor em W2:** SQLite (`node:sqlite`, sem dependência nativa) atrás da interface `Storage`, e anexos em disco; Postgres e armazenamento compatível com S3 ficam para quando forem necessários, sem mudar a porta. O pedido de sal de login é um POST, para o e-mail não aparecer em URLs.

## 4. Paridade do domínio: como provar que a reescrita calcula igual

1. **Gerador de referência em Python** (`scripts/golden/`): roda o domínio atual sobre cenários e grava entrada e saída esperada em JSON (`web/packages/domain/golden/`). Cenários incluídos:
   - exemplos A–F do `06`;
   - cofre de demonstração (`tests/demo_vault.py`);
   - faturas e pagamento atrasado;
   - retornos (TWR, XIRR, Dietz), resgate e imposto;
   - orçamento, projeção, indicadores e comparações;
   - parsers sobre os PDFs sintéticos;
   - casos gerados pelo fuzzing.
2. **Teste diferencial:** cada módulo TS precisa reproduzir o JSON exatamente. Decimais são comparados como texto, sem tolerância.
3. **Testes portados:** os ~520 testes Python são traduzidos por módulo, junto com o código. A matriz TA-01…TA-36 do `15` ganha uma coluna "web".
4. **Congelamento:** quando um módulo atinge a paridade, seus JSON ficam congelados. Em W13 o Python sai e os JSON continuam como especificação executável.

## 5. Interface: mesma forma, responsiva, bonita e animada

### 5.1 Princípios
- **Mesma forma:** cada tela, aba, diálogo e comando atual existe na web com o mesmo comportamento (§6). "Mesma forma" vale para fluxo e conteúdo. O visual pode evoluir dentro do `16`.
- **Responsiva:** quatro faixas com container queries. O `Adaptive` do `16` vira grade que empilha.

  | Faixa | Largura | Navegação |
  |---|---|---|
  | Larga | ≥ 1440 px (alvo 1920×1080) | Barra lateral fixa e inspetor ao lado |
  | Média | 1024–1439 px | Barra lateral recolhível; o inspetor vira painel deslizante |
  | Tablet | 640–1023 px | Gaveta lateral; tabelas com colunas prioritárias |
  | Celular | < 640 px | Barra inferior com 4 destinos + "Mais"; tabelas viram listas de cartões; diálogos viram folhas de baixo |

- **Teclado:** todo comando tem atalho e entra na paleta de comandos (Ctrl+K). Ctrl+1…9 conflita com o navegador; as seções passam a usar Alt+1…9 e sequências `g` + letra.
- **Acessibilidade:** WCAG 2.2 AA, nome acessível em todo controle (auditoria automática), foco visível, estado nunca só por cor.

### 5.2 Animações
- **Biblioteca:** Motion, com tokens de duração (120, 200, 320 ms) e curvas no tema.
- **O que anima:**
  - troca de página com deslize e fade curtos;
  - entrada e saída de linhas e cartões;
  - inspetor e painéis com layout compartilhado;
  - diálogos e folhas com mola;
  - números da Visão geral contando até o valor;
  - gráficos desenhados na entrada e ao trocar o mês;
  - esqueletos durante decifração e sincronização;
  - indicador de sincronização vivo;
  - confirmação de ação aprovada.
- **O que não anima:** digitação, rolagem de tabelas grandes e qualquer coisa que atrase a leitura de um valor.
- **Regras:** só `transform` e `opacity`; `prefers-reduced-motion` desliga deslocamentos e mantém só fades curtos; 60 fps medidos no Livro com 50 mil linhas.

### 5.3 Visual
- Tokens do `16` §2 portados para variáveis CSS, claro e escuro, e revisados para a web (tipografia variável embutida, sem fonte remota).
- Componentes do `16` §3 com nome igual (`PageHeader`, `EmptyState`, `Section`, `Collapsible`, `ChartPanel`, `Adaptive`, `ElidedText`, `decide`/`confirm`, `notify`), para que as regras do CLAUDE.md continuem valendo.
- Capturas de toda tela em claro, escuro e nas quatro faixas (Playwright), revisadas a cada fase como hoje com `capturar_telas.py`.

## 6. Inventário de paridade

Cada linha só é concluída quando a tela web faz tudo o que a tela Qt faz, passa no teste de todas as telas da web (§7, W12) e foi revisada nas capturas.

| Tela atual | Partes e diálogos a portar | Fase |
|---|---|---|
| Início, login e criação | Entrar, criar conta, criar projeto, lista de projetos (substitui recentes e Abrir/Restaurar), assistente inicial (integrantes, contas, cartões, conclusão) | W7 |
| Shell | Barra lateral com contagens, barra superior (projeto, estado de sincronização, operador), menus como paleta, bloqueio de tela, desfazer/refazer, ajuda (F1), arrastar arquivos em qualquer tela | W7 |
| Visão geral | Atenção ao abrir, indicadores, mês a mês, "Antes de fechar o mês", fechar e reabrir mês, relatório do mês em PDF | W8 |
| Orçamento | Grade do mês, definir o mês, alterar valor, comparação | W8 |
| Calendário | Mês por dia com situação, abrir o ponto de pagamento ou vínculo | W8 |
| Livro financeiro | Tabela virtualizada, filtros e filtros salvos, inspetor, novo lançamento, edição (`OperationDialog`, `OperationEditDialog`, `SimpleEditDialog`), rateio, reclassificar, marcadores, reembolso, dedutível, conferência de saldo, sugestões de IA com lista de conferência, exportar CSV | W8 |
| Contas e cartões | Abas: contas do livro (`AccountDialog`, `CardDialog`, `CategoryDialog`, `MemberDialog`), contas bancárias (`BankAccountDialog`, `ValuesDialog`, `InvestmentDialog`), faturas (`BillPaymentDialog`), financiamentos (`LoanDialog`, `PayInstallmentDialog`, `PrepaymentDialog`), regras (`RuleDialog`) | W9 |
| Recorrências | Regras, previsões, exceções, assinaturas, vincular realizado | W9 |
| Metas | Metas, progresso, gráfico e tabela (`GoalDialog`) | W9 |
| Reembolsos e acertos | A receber, quem deve a quem (`ReimbursementDialog`, `ReceiveDialog`, `SettlementDialog`) | W9 |
| Documentos | Lista, visualizador de PDF sob demanda, senha de PDF, comprovantes | W9 |
| Investimentos | Lista, detalhe com gráficos e números, eventos (avaliação, aporte, distribuição, resgate), negociações e notas, simulador de resgate, características | W10 |
| Relatórios | Todos os gráficos do `07` §4 com tabela, filtros por conta, integrante e categoria, "Ver lançamentos", exportar imagem, relatório anual em PDF, marcadores, estabelecimentos, dedutíveis, fechamento do ano | W10 |
| Imposto de renda | Ano e declarante, pendências, documentos do ano, rendimentos, pagamentos, bens e dívidas, renda variável, simplificada × completa, informes; diálogos `ParametersDialog`, `VariableRulesDialog`, `PaymentDialog`, `FilingDialog`, `DeclaredAssetDialog`, `TaxIdDialog`, `MemberTaxDialog`, `PeopleDialog`, `ReportDialog`, `NatureDialog`, `IncomeDetailDialog`, `OperationsDialog` | W10 |
| Importar e revisar | Fila, conferência com PDF ao lado e evidência destacada, `ItemDialog`, aprovação, duplicatas, regras que aprendem, IA após importar, cancelamento | W11 |
| Assistente | Conversa, atividade de cada ferramenta, aprovação de cada alteração (`ApprovalDialog`), atalhos para o Livro filtrado | W11 |
| Configurações | Projeto (vale na hora, sincronizado), IA local (porta, GPU, `OLLAMA_ORIGINS`), segurança (trocar senha, bloqueio por inatividade, chave de recuperação), backup (exportar arquivo cifrado, restaurar, verificar, lembrete), privacidade deste aparelho | W11 |
| Gerais | Cobertura (`CoverageDialog`), marcadores (`TagDialog`, `RenameTagDialog`), `BudgetGridDialog`, `BudgetDialog`, `ReclassifyDialog`, `AiReviewDialog`, `Decision` | Com a tela que os usa |

## 7. Fases

Cada fase tem critério de saída verificável. Nenhuma tela entra antes de o domínio que ela usa ter paridade.

### W0 — Fundação
- Monorepo pnpm em `web/`, TypeScript estrito, ESLint + Prettier, Vitest, Playwright, scripts equivalentes aos comandos do CLAUDE.md.
- Regras de lint próprias: fronteiras entre pacotes, `number` proibido para dinheiro, `console` proibido fora de `diagnostics`, `localStorage` só em `preferences`.
- Gerador Python de referência (`scripts/golden/`) com o primeiro lote (dinheiro e `Ledger`).
- **Saída:** `pnpm check` (formatação, lint, tipos e testes) passa limpo; o primeiro JSON de referência foi gerado.

### W1 — Criptografia e cofre
- `packages/crypto`: Argon2id, HKDF, AES-GCM, envelope, troca de senha, chave de recuperação (gerar, exibir uma vez, recuperar e gerar outra, invalidando a anterior).
- `packages/vault`: registro cifrado, cache IndexedDB, fila offline, bloqueio.
- Documento normativo `19_SEGURANCA_WEB.md`, sucessor do `03` para a web: modelo de ameaça, parâmetros, formato, o que o servidor vê, o que não se promete.
- **Saída:**
  - vetores de teste conhecidos;
  - adulterar, trocar de lugar ou reaproveitar um registro é detectado;
  - teste que vasculha o IndexedDB e o tráfego e não encontra texto claro;
  - senha errada nunca vira "projeto novo".

### W2 — Servidor e sincronização
- `apps/server` com contas, projetos, envelopes, registros, blobs e concessão de edição; limites de tamanho e de tentativas; logs só com códigos.
- `SyncBackend`, `backend-http` e a suíte de contrato.
- `docker compose` com Caddy e guia de instalação.
- **Saída:**
  - a suíte de contrato passa;
  - dois navegadores: um edita e o outro lê e assume a edição;
  - queda de rede no meio do envio não perde nem duplica registro;
  - o servidor reiniciado mantém tudo.

### W3 — Núcleo do domínio
- `money`, `model`, `ledger` (invariantes, partidas dobradas, histórico, `dirty`, `change_count`), coleções rastreadas, `registry` de tipos, `migrations` (esquema web começa na versão 1), `periods`, `queries`, `search`, `undo`.
- **Saída:** paridade com os JSON do núcleo; TA-15, TA-16, TA-18, TA-32 e RF-22 portados e verdes.

### W4 — Domínio do dia a dia
- Cartões e faturas (inclui pagamento atrasado, `04` §5), recorrências, assinaturas, orçamento, calendário, avisos, metas, reembolsos e acertos, marcadores, dedutíveis, conferência de saldo, contas bancárias e titulares, financiamentos, estabelecimentos, comparações, indicadores, projeção, fechamento do ano, suspeitos, filtros salvos, anexos, assistente inicial, configurações do projeto, exportações (CSV, JSON).
- Listas embutidas: `catalogs/banks` (gerado) e `catalogs/irpf`.
- Dados dos gráficos (`charts/data`) com proveniência e tabela de valores.
- **Saída:** paridade com os JSON de cada módulo e com o cofre de demonstração inteiro.

### W5 — Investimentos e imposto de renda
- `investments/*`: posições, avaliações, fluxos, lotes, negociações, notas, TWR, XIRR, Dietz, simulação, perfil, índices informados.
- `tax/*`: declaração, registros, pendências, lista de conferência, simulação, renda variável. Nenhuma tabela fiscal embutida.
- **Saída:** exemplos A–F do `06` idênticos; resultado indisponível continua `null` com motivo.

### W6 — Importação e IA
- Fonte em memória (PDF via pdf.js num Worker, CSV, OFX), detecção de tipo real, hash e recusa de repetido, senha de PDF usada uma vez.
- Parsers portados com versão, limitações e `validated_with_real_documents`, isolados num Worker (equivalente ao `run_parser`). Geometria do pdf.js conferida contra a do pdfplumber nos sintéticos.
- Pipeline, conferências, sugestões, regras do usuário, regras que aprendem, duplicatas e aprovação.
- Cliente Ollama (só loopback), prompts versionados, ferramentas do Assistente (leituras e alterações com `prepare`/`apply`).
- Fuzzing com fast-check, como o `test_fuzz.py`.
- **Saída:** os PDFs sintéticos dão exatamente o valor esperado revisado; o fuzzing longo roda sem exceção escapando; o servidor falso do Ollama é portado e os testes de IA e do Assistente passam.

### W7 — Sistema visual e shell
- Tokens, temas claro e escuro, tipografia, ícones embutidos.
- Componentes do `16` §3, animações (§5.2), as quatro faixas responsivas, paleta de comandos.
- Shell: navegação, barra superior com estado de sincronização, bloqueio, desfazer, ajuda, arrastar arquivos.
- Início, login, criação de conta e de projeto, assistente inicial.
- PWA: instalação, offline e atualização avisada.
- **Saída:** catálogo de componentes com capturas em claro, escuro e nas quatro faixas; criar conta, criar projeto, bloquear e desbloquear funcionam de ponta a ponta contra o servidor.

### W8 — Telas do dia a dia
- Visão geral, Orçamento, Calendário e Livro financeiro, com todos os diálogos da §6.
- **Saída:** a linha de cada tela na §6 está concluída; o Livro com 50 mil lançamentos rola a 60 fps e filtra em menos de 100 ms.

### W9 — Telas de cadastro
- Contas e cartões (cinco abas), Recorrências, Metas, Reembolsos e acertos, Documentos.
- **Saída:** as linhas da §6 concluídas.

### W10 — Telas de acompanhamento
- Investimentos, Relatórios (todos os gráficos do `07` §4 e os PDFs) e Imposto de renda.
- **Saída:** as linhas da §6 concluídas; cada gráfico confere com a sua tabela (como o teste atual de gráficos).

### W11 — Importação, Assistente e Configurações
- Importar e revisar, Assistente, Configurações e backup.
- Backup na web: exportar um arquivo cifrado com a mesma senha, restaurar num projeto novo, verificar o arquivo sem restaurar.
- **Saída:** as linhas da §6 concluídas; importar, revisar e aprovar um extrato sintético funciona de ponta a ponta; um backup exportado é restaurado idêntico.

### W12 — Qualidade e paridade final
- Teste de todas as telas da web (Playwright, sucessor do `test_every_screen.py`): aciona cada botão e item de menu com o projeto de demonstração e confere erros, passos de desfazer, estado sem projeto (TA-31) e transbordamento nas quatro faixas.
- Matriz TA-01…TA-36 completa na coluna web.
- Desempenho: abrir um projeto com 50 mil lançamentos em menos de 3 s num notebook comum; memória da aba abaixo de 500 MiB sem anexos abertos.
- Acessibilidade: axe sem violações; navegação completa só pelo teclado; teste com NVDA (manual, com o usuário).
- Segurança: revisão do CSP, das dependências e do que o servidor guarda; teste de injeção nos campos de texto e nos PDFs.
- **Saída:** todos os itens acima verdes e revisados com o usuário.

### W13 — Lançamento hospedado e saída do desktop
- Imagem Docker publicada, guia de instalação, atualização e backup do servidor (só texto cifrado).
- Remoção de `src/opesvault`, `packaging/`, dependências Qt e Nuitka, scripts e documentos que só valem para o desktop (`11`, `17`). O gerador Python sai e os JSON de referência ficam.
- `docs/` atualizados: `02`, `03` (aponta para o `19`), `07`, `13`, `15`, `16` e o CLAUDE.md.
- **Saída:** o usuário usa a versão web hospedada no dia a dia; `main` recebe a branch `web`.

### W14 — Firebase (futuro)
- `backend-firebase`: Auth, Firestore, Storage, regras de segurança por integrante, App Check.
- Hospedagem do SPA no Firebase Hosting com os mesmos cabeçalhos de segurança.
- Ferramenta para copiar um projeto entre servidores (só texto cifrado).
- **Saída:** a suíte de contrato passa contra o emulador do Firebase; um projeto copiado do servidor próprio abre idêntico.

## 8. Decisões pendentes do usuário

| Assunto | Opções | Precisa até |
|---|---|---|
| Parâmetros do Argon2id | Adotado provisoriamente, revisável: 64 MiB, 3 passadas, 1 via, 32 bytes (`19` §3); medir no celular mais fraco que for usado | W1 |
| Histórico no servidor | Adotado provisoriamente, revisável: só a versão atual, com lápides (`19` §7). Alternativa: guardar versões antigas cifradas por N dias | W2 |
| IA fora do navegador | Adotado provisoriamente, revisável: só o Ollama local da máquina. Alternativa: um Ollama no servidor, sabendo que o texto passa em claro por ele | W6 |
| Domínio e hospedagem | Onde o servidor próprio roda (casa, VPS) e com qual domínio | W13 |
| Fórmulas na exportação CSV | Hoje o texto vai como está, como no desktop (`19` §12.1, achado 12): uma descrição de extrato como `=HYPERLINK(…)` vira fórmula ao abrir o CSV numa planilha. Opções: prefixar `'` nas células de texto que começam com `=`, `+`, `-` ou `@` (muda o desktop e o arquivo de referência de paridade), ou uma opção "para planilha" na exportação | W13 |
| Backup antes de migrar o esquema | Hoje a migração só vira dado no servidor numa entrega atômica, e o backup é um ato explícito (`15`, TA-33). Alternativa: exportar um backup automático antes de enviar um projeto migrado | W13 |

## 9. Riscos

| Risco | Efeito | Resposta |
|---|---|---|
| Reescrita calcula diferente | Valor errado na tela | Paridade por JSON de referência sem tolerância (§4), módulo a módulo |
| Script injetado na aba | Leitura de tudo enquanto desbloqueado | CSP estrita, Trusted Types, nenhum terceiro, auditoria de dependências (§3.7) |
| Senha esquecida | Perda total do projeto | Chave de recuperação; aviso claro na criação; lembrete se ela nunca foi confirmada |
| Chave de recuperação perdida ou exposta | Perda ou acesso indevido | Exibida uma vez, confirmação de que foi guardada, gerar outra invalida a anterior |
| Navegador apaga o IndexedDB | Perda de alterações não enviadas | `storage.persist()`, sincronização frequente, aviso de pendências |
| pdf.js extrai diferente do pdfplumber | Parsers quebram | Comparar a geometria nos sintéticos antes de portar cada parser |
| Memória do navegador | Aba lenta ou encerrada | Anexos sob demanda, tabelas virtualizadas, metas de W12 |
| Ollama recusa a origem do app | IA indisponível | Diagnóstico na tela de IA com o passo a passo do `OLLAMA_ORIGINS`; o app funciona inteiro sem IA |
| Prender-se ao servidor escolhido | Migração cara | Porta `SyncBackend`, suíte de contrato e dados opacos (§3.4) |
| Escopo enorme | Branch longa demais | Fases com saída verificável; `main` só recebe a web em W13 |

## 10. Andamento

Atualizado a cada fase. Detalhes técnicos em `web/README.md` e `web/PORTING.md`.

| Fase | Situação | Verificação |
|---|---|---|
| W0 | Concluída | `pnpm check`; `Dec` reproduz o `decimal` do Python dígito a dígito (aritmética, arredondamentos, ln, exp, potências) |
| W1 | Concluída | Vetores conhecidos, testes de adulteração e varredura sem texto claro no IndexedDB e nas requisições; normativo em `19` |
| W2 | Concluída | Suíte de contrato contra o servidor em memória e o HTTP; `docker compose` com Caddy executado de ponta a ponta; guia em `20` |
| W3 | Concluída | Livro, consultas, busca, reclassificação, migração e desfazer idênticos ao Python em cenários aleatórios com semente |
| W4 | Concluída | 19 módulos do dia a dia com arquivos de referência (3 cenários de 14 meses) e os casos do pytest |
| W5 | Concluída | Exemplos A–F do `06`, XIRR/TWR/Dietz dígito a dígito, imposto, catálogos e contas bancárias |
| W6 | Concluída | Texto do pdf.js idêntico ao do pdfplumber nos sintéticos; parsers, fluxo de revisão, IA e fuzzing |
| W7 | Concluída | Componentes, shell, quatro faixas, animações, PWA; e2e sem erros nem transbordamento em 5 tamanhos, claro e escuro, axe sem violações |
| Integração do domínio | Concluída | Avisos, calendário, gráficos, exportações, notas de corretagem, informes, Assistente e projeto de demonstração, com paridade (2 036 testes no total) |
| W8 | Concluída | Visão geral (com relatório do mês para impressão), Orçamento, Calendário e Livro financeiro |
| W9 | Concluída | Contas e cartões (8 abas), Recorrências, Metas, Reembolsos e acertos, Documentos |
| W10 | Concluída | Investimentos (XIRR num Web Worker), Relatórios (13 relatórios, relatório anual para impressão), Imposto de renda (12 diálogos, informes, relatório para a declaração) |
| W11 | Concluída | Importar e revisar (leitura num Web Worker), Assistente (aprovação de cada alteração), Configurações e backup cifrado (`19` §13); 501 testes de ponta a ponta em 5 tamanhos, claro e escuro |
| W12 | Pronta para revisão com o usuário | Teste de todas as telas (passeio por todos os botões e menus em 4 tamanhos, estado sem projeto TA-31, fluxos só pelo teclado); matriz TA na coluna web: 29 automatizados, 2 substituídos por garantias equivalentes, 5 parciais, nenhum pendente (`15`); desempenho com 50 006 lançamentos: abrir em 2,6 s com 470 MiB na aba; revisão de segurança (`19` §12.1); 607 testes de ponta a ponta e 2 100 unitários. Falta: o teste com NVDA e a revisão com o usuário, e as decisões da §8 |

Notas desta etapa:
- O app usa o domínio por um `Workspace` (`apps/app/src/data/`): cada ação do usuário é um passo de desfazer e só os registros alterados vão, cifrados, ao cofre. Com a sincronização automática, o desfazer vale para a sessão da aba, mesmo depois de sincronizado (o estado anterior é enviado como nova alteração).
- Corrigido no cofre: uma exclusão feita enquanto o envio da criação ainda não tinha resposta era descartada, e o registro ficava no servidor.
- Zod roda sem compilação dinâmica (a CSP proíbe `eval`); a CSP do app permite `wasm-unsafe-eval` só para o Argon2id.
- W11, Configurações e backup: cinco seções (Projeto, IA local, Segurança, Backup e salvamento, Privacidade deste aparelho), cada bloco dizendo se vale para o projeto (sincroniza) ou só para o aparelho. Backup em arquivo cifrado, em blocos, versionado, que se exporta, se verifica e se restaura sempre como projeto novo (formato e garantias em `19` §13). O lembrete de backup usa a data do último backup **deste aparelho**, preferência por projeto, para não mudar o esquema persistido. O bloqueio por inatividade passou a contar de fato a atividade da aba (antes o cofre nunca recebia o toque) e não tem opção "desligado". Recuperar o projeto com a chave de recuperação e restaurar um backup também saem da tela de projetos.
- W12, desempenho (projeto gerado com 50 006 lançamentos, cerca de 100 mil registros, Chromium sem janela num contêiner de 4 núcleos; `pnpm --filter @opesvault/app perf`, resultados em `apps/app/build/perf/results.json`): abrir o projeto neste aparelho leva **2,6 s** (antes 11 s) e a aba fica em **470 MiB** (meta: 3 s e 500 MiB); o Livro rola a 60 quadros por segundo e os filtros respondem em 30 a 130 ms. O ganho vem do **retrato do projeto neste aparelho** (`19` §8): um só bloco cifrado com todos os registros, decifrado ao abrir no lugar de 100 mil registros um a um, lido do IndexedDB enquanto o Argon2id roda. Também ajudaram: decifrar e selar em lotes, avisos e contagens calculados depois de pintar a tela (`data/later.ts`), código das telas carregado sob demanda, tabela do Livro com menos trabalho por quadro. Os Web Workers que decifravam em paralelo saíram: com o retrato serviam só a casos de uma vez por aparelho e deixavam a aba acima de 740 MiB.
- Limitação conhecida: a **primeira abertura num aparelho novo** baixa e grava todos os registros no IndexedDB, o que levou 85 s com 50 mil lançamentos nesse contêiner (quase tudo é a gravação do IndexedDB; decifrar é 4 s). Acontece uma vez por aparelho; um indicador de progresso nessa espera fica como melhoria para a W13.
- W12, paridade: o assistente de primeiros passos coletava integrantes, contas e cartões e não gravava nada (`19` §12.1, achado 15). Agora pede o mesmo que o do desktop (titulares, instituição, saldo de abertura e data; portador, 4 últimos dígitos e conta de pagamento do cartão) e aplica tudo de uma vez pelo `onboarding.applySetup`, que confere antes de gravar: um dado errado fica na tela e nada é gravado pela metade.
- W12, testes: os testes de um link entre telas passaram a conferir a navegação feita (`test/navigations.ts`), não o endereço depois de a página de destino consumir o `ref`; os testes de TA-31 leem o primeiro lançamento do Livro em vez de um nome fixo.

- W12, ajustes de shell e telas (07/10/2026): passar o ponteiro ou o foco num item da barra lateral (ou selecioná-lo na paleta) já carrega o código da tela (`page_code.ts`); cada ação tem nome no desfazer ("Desfazer: reclassificar 3 lançamentos", e "Desfeito: …"/"Refeito: …" no aviso), dado pela tela ou deduzido do que mudou (`data/action_names.ts`); `?` abre "Atalhos de teclado", e os atalhos vêm de uma só lista (`shell/shortcuts.ts`) que também alimenta a ajuda (F1), as dicas dos botões e o `aria-keyshortcuts`; a demonstração abre no último mês completo com lançamentos, igual em Visão geral, Orçamento, Livro e Relatórios (os testes de ponta a ponta escritos sobre os dados do mês corrente abrem com `?demo&mes=atual`); Orçamento vazio cria o plano pela média dos gastos dos últimos 3 meses (conferido na grade antes de salvar), Metas vazia abre a nova meta com o exemplo de uma reserva de emergência, e Investimentos vazio leva a Contas › Contas bancárias com o formulário de novo investimento.
