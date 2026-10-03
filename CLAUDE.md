# CLAUDE.md

OpesVault: aplicativo desktop Windows, 100% offline, para finanças familiares, com cofre cifrado por família. A especificação completa está em `docs/`, e **ela é a fonte de verdade**. Este arquivo não a resume: diz onde procurar, registra decisões posteriores aos docs e lista as armadilhas de implementação.

## Estado atual

As **fases 0 a 6** estão implementadas e testadas (`docs/13`). Das fases 7 a 10 foi feito tudo o que não depende de documentos reais nem do build (`docs/09` §1.4). Regras de categoria, orçamento, avisos ao abrir e desfazer já foram feitos (`docs/13` §2.2).

- **Windows, em Python:** o desenvolvimento passou para o Windows. G0 foi aprovado (suíte completa, inclusive os testes `windows`); G1 foi aprovado só em modo Python (`--self-test`); G2 foi medido. O build Nuitka e os gates G3–G7 seguem pendentes (`docs/11` §2.1).
- **Desempenho:** com 250 MiB e 50 mil lançamentos, abrir leva 2,65 s, mas o pico de RAM da UI (833 MiB) passa da meta. Carregar documentos sob demanda (fase 8) continua necessário.
- **Interface:** passou por duas revisões, a visual e a de fluxos (`docs/16` §2–§5). Avisos levam ao objeto e à ação. Faturas são pagas na aba Faturas. Configurações não têm botão Aplicar. "Salvar…" retoma a ação interrompida. Visão geral, Orçamento, Livro e Relatórios compartilham o mês.
- **Esquema do domínio 2:** integrantes têm papel. Cofres do esquema 1 são migrados ao abrir (`domain/migrations.py`).
- **Faturas:** pagamento atrasado quita primeiro a fatura vencida (`docs/04` §5).
- **Ainda sintético:** os layouts de faturas e extratos, até haver documentos reais.
- **Fase 7 em andamento** (`docs/17`): G4 e G5 aprovados em modo Python, escalas 150/200% verificadas, todos os controles com nome acessível. Faltam o build (G1), G3, G6, G7, o teste com leitor de tela, as notas de terceiros e o corpus de documentos reais. As funcionalidades das fases 11 a 14 estão em `docs/09` §1.3 e dependem das decisões do §4. A dívida técnica está no §1.5.

## Comandos

```
uv sync                                  # dependências (uv sync --group build para o Nuitka)
uv run pytest -q                         # testes; os marcados "windows" são pulados fora do Windows
uv run ruff format . && uv run ruff check . && uv run pyright
uv run python -m opesvault               # o aplicativo
uv run python -m opesvault --self-test relatorio.json   # autoteste (G1 em modo Python)
uv run python scripts/fase0_medir_ram.py --mib 50 250
uv run --group build python scripts/build.py   # opcional, ~25 min (--installer: Inno Setup, também opcional)
OPV_FUZZ_ITERATIONS=3000 uv run pytest tests/test_fuzz.py   # fuzzing longo (~45 s)
uv run python scripts/inventario_licencas.py [--check]       # licenças + SBOM em build/licencas
uv run python scripts/validar_layouts.py PASTA_DO_CORPUS     # documentos reais, fora do git (docs/15 §2)
uv run python scripts/capturar_telas.py [--dark] [--size 900x640]  # capturas de todas as telas (build/telas)
uv run python scripts/avaliar_modelos.py [MODELO ...]       # compara modelos do Ollama local (build/ia)
uv run python scripts/fase7_gates.py disco|antivirus        # G4 e G5 em modo Python (build/fase7)
uv run python scripts/auditar_acessibilidade.py             # controles sem nome para leitor de tela
```

Desenvolva e teste direto em Python. O build Nuitka é **opcional**: só rode quando o usuário pedir ou quando a mudança afetar empacotamento (dependências nativas, plugins Qt, relançamento do worker).

Testes e capturas rodam sem janela. No Windows, a plataforma Qt é `minimal:enable_fonts`; o `offscreen` não tem banco de fontes ali e mede com uma fonte genérica. No Linux é `offscreen`, e o Qt precisa de `libegl1`, `libgl1`, `libxkbcommon0` e `libfontconfig1`. O `tests/conftest.py` e o `scripts/capturar_telas.py` já escolhem a plataforma certa.

No Windows, se o `uv sync` falhar com "arquivo em uso" (os error 32, antivírus) ou "wheel inválido", o cache global ficou corrompido. Rode com `UV_CACHE_DIR` apontando para uma pasta temporária, ou peça ao usuário para rodar `uv cache clean`.

## Decisões tomadas depois dos docs (prevalecem sobre eles)

- Idioma: código, identificadores, comentários e commits em **inglês**. Textos de interface, mensagens ao usuário e `docs/` em **português brasileiro**.
- Tooling: **Python 3.12**, **uv** (com lockfile versionado), **ruff** (lint e formatação), **pyright** e **pytest**.
- Importação aceita **PDF, CSV e OFX** (`docs/05` §1 e §3).
- Repositório **privado** e **sem CI** por enquanto. A branch principal é a `main`. Os gates do Windows que exigem build ou intervenção física (G3–G7) são executados manualmente pelo usuário.
- Pagamento de fatura feito depois do vencimento quita primeiro as faturas vencidas com saldo, da mais antiga para a mais nova (`docs/04` §5).
- Cofres recentes só são lembrados com consentimento explícito (`docs/07` §1); a lista nasce desligada.

## Onde procurar

| Preciso de… | Ler |
|---|---|
| Escopo, princípios, o que está fora | `docs/00` |
| Requisitos RF/RNF e fluxos | `docs/01` |
| Componentes e o que cada um **não** deve fazer | `docs/02` §2 |
| Senha, sessão, gravação atômica, backup | `docs/03` (normativo para tudo que toca o cofre) |
| Entidades, invariantes, partidas dobradas | `docs/04` |
| Pipeline de PDF, Ollama, duplicatas | `docs/05` |
| Fórmulas de retorno, resgate, imposto | `docs/06` (os exemplos A–F são casos de teste) |
| Telas e gráficos | `docs/07` |
| Testes de aceitação TA-01…TA-36 | `docs/08` |
| Roadmap (próximas fases), dívida técnica, ADRs, riscos, decisões pendentes | `docs/09` |
| Resultados da fase 0 e roteiro Windows | `docs/11` |
| Projetos de referência e particularidades de layouts | `docs/12` |
| O que foi implementado por fase, cobertura e pendências | `docs/13` |
| Fuzzing, registro técnico, licenças, SBOM, OpenSSL | `docs/14` |
| Qual teste cobre cada TA; validação de layouts reais | `docs/15` |
| Arquitetura da janela, tokens, componentes e regras de interface | `docs/16` |
| Situação da fase 7 e o que falta fazer com o usuário | `docs/17` |

Se dois documentos entrarem em conflito, vale o `docs/00` §2. Conflitos de segurança ou cálculo devem ser levados ao usuário, nunca resolvidos pela interpretação mais simples. Mudar de stack, adicionar cloud, reter chave para autosave ou permitir edição simultânea exige nova decisão do usuário.

## Armadilhas de implementação

- **Dinheiro:** nunca use `float`, nem como passo intermediário. Converta a entrada de `str` direto para `Decimal`. Coluna `REAL` não pode ser fonte autoritativa. O arredondamento padrão de gestão, "empate para longe de zero", é `ROUND_HALF_UP` e **não** o `ROUND_HALF_EVEN` padrão do `Decimal`. Passe o modo explicitamente.
- **Desconhecido não é zero:** campo ausente fica `None`, com estado de qualidade. Isso vale para saldo, imposto, custo, data e avaliação.
- **Sinais em `docs/06` §5:** no XIRR, aporte é **negativo**; no Modified Dietz, Cᵢ é **positivo** para aporte. Isole cada convenção dentro da função do método.
- **Segredos:** a senha é digitada no processo transitório do cofre, e a UI principal nunca a recebe. Não guarde senha ou chave em atributo, cache, closure ou log. Não passe segredo por argumento de linha de comando. Não serialize o snapshot entre processos com `pickle`; valide na fronteira com Pydantic.
- **Disco:** não grave texto extraído, miniatura, render de PDF ou banco temporário sem cifra. Não use a API de backup do SQLite comum. Teste que não há fallback silencioso para SQLite sem cifra.
- **Empacotamento:** use Nuitka em modo `standalone`, não `onefile`. O `onefile` descompacta em `%TEMP%` a cada execução, o que viola a higiene de disco e deixa lento cada processo de salvar.
- **Logs:** apenas códigos de erro e IDs opacos. Nada de nomes, valores, descrições, CPF ou conteúdo de PDF, nem em mensagens de exceção que possam acabar logadas.
- **IA:** a saída do Ollama é sugestão sem escrita direta. Texto de PDF é dado, nunca instrução. O app precisa funcionar inteiro sem Ollama. A consulta segue três passos (`importing/ai_suggestions.py`): `plan_requests` lê o livro na thread visual, `ask` fala com o modelo em segundo plano **sem tocar no livro** e `apply_suggestions` grava na thread visual. Testes usam o fixture `ollama` (`tests/conftest.py`, servidor falso em `tests/fake_ollama.py`); nunca o Ollama real.
- **Worker do cofre:** cada abrir/salvar inicia `--vault-worker`, que pede a senha e morre. A UI nunca recebe a senha. `scripts/dev_worker.py` aceita senha por variável de ambiente e **só** pode ser usado em testes; ele fica fora do pacote de propósito.
- **Tipos persistidos:** todo módulo que registra um tipo com `Ledger.register_kind` ou uma guarda precisa constar em `registry.MODULES`. Imports só por efeito colateral não sobrevivem ao `ruff --fix`; por isso a lista é explícita e testada.
- **Mudar uma entidade persistida:** as entidades usam `extra="forbid"`, então um campo novo quebra a leitura em versões anteriores. Suba `SCHEMA_VERSION` (`domain/ledger.py`) e acrescente um passo em `domain/migrations.py` que complete os registros antigos. Teste com registros no formato anterior (`tests/test_member_role.py`). Registre a mudança no `docs/09` §5.
- **Parsers:** um por instituição + produto + layout, com `version`, `limitations` e `validated_with_real_documents`. Nunca deduza o ano pelo relógio; use a data do próprio documento.
- **Investimentos:** avaliação não é fluxo, aporte não é rendimento, e resultado indisponível é `None` com motivo. Métodos de retorno só calculam quando os dados permitem.
- **Thread da UI:** não extraia PDF, não chame modelo e não faça operação de cofre na thread visual. Trabalho em segundo plano que altera a sessão chama `Page.set_busy`, que bloqueia salvar e editar.
- **Desfazer:** cada chamada a `Page.changed()` fecha um passo de desfazer (`MainWindow.on_changed` → `UndoStack.seal`); chame-a uma vez por ação do usuário. Alterações fora das coleções rastreadas, do setter de `meta` e de `Session.add_document`/`remove_document` não entram no diário e não podem ser desfeitas.
- **Gravação incremental:** o salvamento só leva o que está em `Ledger.dirty`. Toda alteração passa por `Ledger.put`, pelas coleções rastreadas ou pelo setter de `meta`; mutar um objeto já guardado não é visto e não é gravado. Documentos entram e saem por `Session.add_document` e `remove_document`.
- **Parsers como código não confiável:** chame-os por `pipeline.run_parser`, que isola falhas em `ParseFailed`. Valor ilegível ou data impossível vai para as linhas não mapeadas, nunca vira exceção. Rode o fuzzing depois de mexer num parser.
- **Interface:** não fixe cores nem tamanhos de fonte em widgets. Use os tokens de `ui/theme.py` pelas propriedades `textStyle`, `role` e `tone`. Use os componentes de `ui/components.py`: `PageHeader`, `EmptyState`, `Section` (com `add_actions`), `scroll_body`, `menu_button`, `flow_row`, `decide`/`confirm`. Nada de `QMessageBox.question`. Tabelas curtas usam `summary_table`/`fit_to_rows`; listas em abas usam `frameless`. Toda página monta o layout com `page_layout()`. Confira o resultado com `scripts/capturar_telas.py` em claro, escuro e janela estreita.
- **Fluxos entre telas:** use `Page.navigate(alvo, ref, act=...)`, que leva ao objeto, e implemente `Page.reveal` na página de destino. O mês compartilhado passa por `Page.month_chosen` e `follow_month`. Edições que uma página acumula (um campo sendo digitado) entram na sessão por `Page.flush`, chamado antes de salvar ou fechar. Configuração do cofre vale na hora e é gravada pelo Salvar; preferência do computador grava na hora em `QSettings`.
- **Qt e enums:** `QComboBox.currentData()` devolve um `StrEnum` como `str` simples, e `model_copy` não revalida. Converta (`MemberRole(...)`) antes de copiar uma entidade.
- **Tabelas:** `resizeColumnsToContents` desfaz o esticamento de colunas. O `common.set_rows` reaplica esse esticamento; quem redimensionar fora dele precisa reaplicar também.
- **Testes de UI e o registro do Windows:** `MainWindow.app_settings()` usa `QSettings`, que no Windows grava no registro do usuário. Testes que mexem em preferências devem redirecionar para um arquivo temporário, como no fixture `settings_file` de `tests/test_flows.py`.
- **Exceções:** mensagens de `DomainError` são para o usuário e podem citar dados; por isso o registro técnico (`diagnostics.record`) guarda só código, tipo e local. Nunca registre `str(exc)`.

## Dados de teste

Nunca versione PDF real, cofre ou exportação; o `.gitignore` bloqueia esses arquivos. PDFs sintéticos ficam em `tests/fixtures/sinteticos/`, com o valor esperado revisado ao lado. A outra exceção é `tests/fixtures/terceiros/`: notas anonimizadas de outros projetos, com licença e origem no README da pasta. Anonimizar significa alterar o conteúdo e os metadados, não só cobrir com tarja.

## Ambiente

O desenvolvimento acontece no Windows e pode acontecer no Linux. Domínio, cálculos e parsers precisam ser testáveis sem Windows nem Qt. Testes que dependem de Windows (empacotamento, substituição atômica, SQLCipher no `.exe`) devem ser marcados e pulados fora do Windows, com instrução de execução manual.
