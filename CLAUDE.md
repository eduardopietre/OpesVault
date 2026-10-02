# CLAUDE.md

OpesVault: aplicativo desktop Windows, 100% offline, para finanças familiares, com cofre cifrado por família. A especificação completa está em `docs/`, e **ela é a fonte de verdade**. Este arquivo não a resume: diz onde procurar, registra decisões posteriores aos docs e lista as armadilhas de implementação.

## Estado atual

O repositório só tem documentação. A próxima etapa autorizada é a **fase 0, de viabilidade** (`docs/09` §1 e `docs/02` §8): executável Windows com SQLCipher, Qt e PDFium empacotados, salvar/restaurar pelo processo transitório e medição de RAM. Não construa telas em escala nem módulos de domínio amplos antes de os gates passarem.

## Decisões tomadas depois dos docs (prevalecem sobre eles)

- Nome do produto: **OpesVault**. Extensão do cofre: **`.opesvault`**. Os docs ainda dizem "Organizador Financeiro Local" e `.fincofre`.
- Idioma: código, identificadores, comentários e commits em **inglês**. Textos de interface, mensagens ao usuário e `docs/` em **português brasileiro**.
- Tooling: **Python 3.12**, **uv** (com lockfile versionado), **ruff** (lint e formatação), **pyright** e **pytest**.
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
| ADRs, riscos, pendências | `docs/09` |

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
- **Thread da UI:** não extraia PDF, não chame modelo e não faça operação de cofre na thread visual.

## Dados de teste

Nunca versione PDF real, cofre ou exportação; o `.gitignore` bloqueia esses arquivos. PDFs sintéticos ficam em `tests/fixtures/sinteticos/`, a única pasta onde `*.pdf` é permitido, com o valor esperado revisado ao lado. Anonimizar significa alterar o conteúdo e os metadados, não só cobrir com tarja.

## Ambiente

O desenvolvimento pode acontecer em Linux. Domínio, cálculos e parsers precisam ser testáveis sem Windows nem Qt. Testes que dependem de Windows (empacotamento, substituição atômica, SQLCipher no `.exe`) devem ser marcados e pulados fora do Windows, com instrução de execução manual.
