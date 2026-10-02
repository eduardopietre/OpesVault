# CLAUDE.md

OpesVault: aplicativo desktop Windows, 100% offline, para finanças familiares, com cofre cifrado por família. A especificação completa está em `docs/`, e **ela é a fonte de verdade**. Este arquivo não a resume: diz onde procurar, registra decisões posteriores aos docs e lista as armadilhas de implementação.

## Estado atual

As **fases 0 a 6** estão implementadas e testadas em Python no Linux (`docs/13`). Das fases 7 a 10 foi feito tudo o que não depende do Windows nem de documentos reais (`docs/09` §1.3). Os gates do Windows (`docs/11` §4) são presumidos aprovados e continuam pendentes de execução real. Os layouts de faturas e extratos são sintéticos até haver documentos reais. O salvamento é incremental (`docs/11` §5); a abertura (~8,7 s com 50 mil lançamentos) segue acima da meta. A próxima etapa é a **fase 7 — validação real** (`docs/09` §1.2); a dívida técnica conhecida está em `docs/09` §1.3.

## Comandos

```
uv sync                                  # dependências (uv sync --group build para o Nuitka)
uv run pytest -q                         # testes; os marcados "windows" são pulados fora do Windows
uv run ruff format . && uv run ruff check . && uv run pyright
uv run python -m opesvault               # janela de teste da fase 0
uv run python scripts/fase0_medir_ram.py --mib 50 250
uv run --group build python scripts/build.py   # opcional, ~25 min (--installer: Inno Setup, também opcional)
OPV_FUZZ_ITERATIONS=3000 uv run pytest tests/test_fuzz.py   # fuzzing longo (~45 s)
uv run python scripts/inventario_licencas.py [--check]       # licenças + SBOM em build/licencas
uv run python scripts/validar_layouts.py PASTA_DO_CORPUS     # documentos reais, fora do git (docs/15 §2)
```

Desenvolva e teste direto em Python. O build Nuitka é **opcional**: só rode quando o usuário pedir ou quando a mudança afetar empacotamento (dependências nativas, plugins Qt, relançamento do worker).

No Linux, o Qt precisa de `libegl1`, `libgl1`, `libxkbcommon0` e `libfontconfig1`; sem tela, use `QT_QPA_PLATFORM=offscreen`.

## Decisões tomadas depois dos docs (prevalecem sobre eles)

- Idioma: código, identificadores, comentários e commits em **inglês**. Textos de interface, mensagens ao usuário e `docs/` em **português brasileiro**.
- Tooling: **Python 3.12**, **uv** (com lockfile versionado), **ruff** (lint e formatação), **pyright** e **pytest**.
- Importação aceita **PDF, CSV e OFX** (`docs/05` §1 e §3).
- Repositório **privado** e **sem CI** por enquanto. Os gates específicos do Windows são executados manualmente pelo usuário numa máquina Windows.

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

Se dois documentos entrarem em conflito, vale o `docs/00` §2. Conflitos de segurança ou cálculo devem ser levados ao usuário, nunca resolvidos pela interpretação mais simples. Mudar de stack, adicionar cloud, reter chave para autosave ou permitir edição simultânea exige nova decisão do usuário.

## Armadilhas de implementação

- **Dinheiro:** nunca use `float`, nem como passo intermediário. Converta a entrada de `str` direto para `Decimal`. Coluna `REAL` não pode ser fonte autoritativa. O arredondamento padrão de gestão, "empate para longe de zero", é `ROUND_HALF_UP` e **não** o `ROUND_HALF_EVEN` padrão do `Decimal`. Passe o modo explicitamente.
- **Desconhecido não é zero:** campo ausente fica `None`, com estado de qualidade. Isso vale para saldo, imposto, custo, data e avaliação.
- **Sinais em `docs/06` §5:** no XIRR, aporte é **negativo**; no Modified Dietz, Cᵢ é **positivo** para aporte. Isole cada convenção dentro da função do método.
- **Segredos:** a senha é digitada no processo transitório do cofre, e a UI principal nunca a recebe. Não guarde senha ou chave em atributo, cache, closure ou log. Não passe segredo por argumento de linha de comando. Não serialize o snapshot entre processos com `pickle`; valide na fronteira com Pydantic.
- **Disco:** não grave texto extraído, miniatura, render de PDF ou banco temporário sem cifra. Não use a API de backup do SQLite comum. Teste que não há fallback silencioso para SQLite sem cifra.
- **Empacotamento:** use Nuitka em modo `standalone`, não `onefile`. O `onefile` descompacta em `%TEMP%` a cada execução, o que viola a higiene de disco e deixa lento cada processo de salvar.
- **Logs:** apenas códigos de erro e IDs opacos. Nada de nomes, valores, descrições, CPF ou conteúdo de PDF, nem em mensagens de exceção que possam acabar logadas.
- **IA:** a saída do Ollama é sugestão sem escrita direta. Texto de PDF é dado, nunca instrução. O app precisa funcionar inteiro sem Ollama.
- **Worker do cofre:** cada abrir/salvar inicia `--vault-worker`, que pede a senha e morre. A UI nunca recebe a senha. `scripts/dev_worker.py` aceita senha por variável de ambiente e **só** pode ser usado em testes; ele fica fora do pacote de propósito.
- **Tipos persistidos:** todo módulo que registra um tipo com `Ledger.register_kind` ou uma guarda precisa constar em `registry.MODULES`. Imports só por efeito colateral não sobrevivem ao `ruff --fix`; por isso a lista é explícita e testada.
- **Parsers:** um por instituição + produto + layout, com `version`, `limitations` e `validated_with_real_documents`. Nunca deduza o ano pelo relógio; use a data do próprio documento.
- **Investimentos:** avaliação não é fluxo, aporte não é rendimento, e resultado indisponível é `None` com motivo. Métodos de retorno só calculam quando os dados permitem.
- **Thread da UI:** não extraia PDF, não chame modelo e não faça operação de cofre na thread visual. Trabalho em segundo plano que altera a sessão chama `Page.set_busy`, que bloqueia salvar e editar.
- **Gravação incremental:** o salvamento só leva o que está em `Ledger.dirty`. Toda alteração passa por `Ledger.put`, pelas coleções rastreadas ou pelo setter de `meta`; mutar um objeto já guardado não é visto e não é gravado. Documentos entram e saem por `Session.add_document` e `remove_document`.
- **Parsers como código não confiável:** chame-os por `pipeline.run_parser`, que isola falhas em `ParseFailed`. Valor ilegível ou data impossível vai para as linhas não mapeadas, nunca vira exceção. Rode o fuzzing depois de mexer num parser.
- **Exceções:** mensagens de `DomainError` são para o usuário e podem citar dados; por isso o registro técnico (`diagnostics.record`) guarda só código, tipo e local. Nunca registre `str(exc)`.

## Dados de teste

Nunca versione PDF real, cofre ou exportação; o `.gitignore` bloqueia esses arquivos. PDFs sintéticos ficam em `tests/fixtures/sinteticos/`, com o valor esperado revisado ao lado. A outra exceção é `tests/fixtures/terceiros/`: notas anonimizadas de outros projetos, com licença e origem no README da pasta. Anonimizar significa alterar o conteúdo e os metadados, não só cobrir com tarja.

## Ambiente

O desenvolvimento pode acontecer em Linux. Domínio, cálculos e parsers precisam ser testáveis sem Windows nem Qt. Testes que dependem de Windows (empacotamento, substituição atômica, SQLCipher no `.exe`) devem ser marcados e pulados fora do Windows, com instrução de execução manual.
