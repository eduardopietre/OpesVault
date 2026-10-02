# Fase 0 — Viabilidade: implementação, medições e roteiro Windows

Versão 1.1 • 02/10/2026. Complementa `09` §1 e `02` §8. Registra o que foi construído, o que foi medido fora do Windows e o que ainda precisa ser executado na máquina Windows de referência.

**Situação:** fase 0 encerrada por decisão do usuário. Os gates G0–G7 são presumidos aprovados e continuam como validação pendente, a executar quando houver acesso à máquina Windows. O desenvolvimento segue em Python, e o build Nuitka é opcional.

## 1. O que existe

| Parte | Arquivo | Função |
|---|---|---|
| Persistência cifrada | `src/opesvault/vault/sqlcipher_store.py` | Abrir, carregar e gravar snapshot; candidato cifrado, verificação e substituição |
| Substituição atômica | `src/opesvault/vault/atomic.py` | `fsync` do candidato; `MoveFileExW` com `WRITE_THROUGH` no Windows; novas tentativas em violação de compartilhamento |
| Processo transitório | `src/opesvault/vault/worker.py` | Pede a senha, executa uma operação, responde e termina |
| Cliente da UI | `src/opesvault/vault/client.py` | Inicia o worker a cada abrir/salvar; nunca recebe a senha |
| Canal entre processos | `src/opesvault/vault/framing.py`, `protocol.py` | Cabeçalho JSON validado por Pydantic + blobs binários; sem `pickle` |
| Bloqueio de edição | `src/opesvault/vault/lock.py` | Arquivo lateral `.lock`, que sobrevive à troca do cofre |
| Sessão em RAM | `src/opesvault/session.py` | Estado salvo/não salvo; edições feitas durante a gravação continuam não salvas |
| Renderização | `src/opesvault/pdf_render.py` | PDFium → `QImage` em memória, sem arquivo temporário |
| Janela de teste | `src/opesvault/ui/` | Novo/abrir/salvar, anexar PDFs e visualizar; não é a interface do `07` |
| Autoteste do executável | `src/opesvault/selftest.py` | `OpesVault.exe --self-test relatorio.json` |
| Medição | `scripts/fase0_medir_ram.py` | Pico de RAM e tempos com N MiB de PDFs sintéticos e 50 mil registros |
| Build | `scripts/build.py` | Nuitka `--standalone` |
| Worker de desenvolvimento | `scripts/dev_worker.py` | Recebe a senha por variável de ambiente, só para testes; fica fora do pacote |

O domínio financeiro ainda não existe. O snapshot guarda registros opacos (`kind` + `payload`) e documentos, o suficiente para validar o mecanismo do cofre.

### Fluxo de salvar

1. A UI congela o snapshot e inicia `OpesVault --vault-worker`, passando os dados pelo stdin.
2. O worker pede a senha na própria janela e abre o cofre atual, o que autentica a senha.
3. Ele confere se a revisão do arquivo é a mesma da base da sessão.
4. Grava `<cofre>.candidate-<id>` cifrado, com o journal em memória.
5. Reabre o candidato e verifica HMAC de todas as páginas, `integrity_check`, revisão, registros e o SHA-256 de cada documento.
6. Confere que o arquivo original não foi trocado durante a gravação.
7. Faz a substituição atômica, responde à UI e termina.

## 2. Resultados no ambiente de desenvolvimento (Linux, 4 CPUs, 16 GiB)

**Não valem como gate:** são uma referência para comparar com o Windows.

**Cenário medido:** 250 MiB de PDFs sintéticos incompressíveis (125 × 2 MiB) e 50 mil registros.

| Métrica | Resultado |
|---|---|
| Criar cofre | 16,2 s |
| Salvar (Ctrl+S) | 15,7 s |
| Abrir | 8,2 s |
| Pico de RAM da UI | ~360 MiB |
| Pico de RAM do worker | ~400 MiB (era 646 MiB antes de a verificação deixar de carregar todos os documentos de novo) |
| Tamanho do cofre | 263 MiB (5% acima dos PDFs) |
| Autoteste: criar / salvar / abrir com dados mínimos | 0,34 s / 0,53 s / 0,19 s |
| Reinício do worker | 0,23 s em Python puro; 0,19 s no executável Nuitka |
| Build Nuitka `--standalone` (Linux) | ~25 min sem ccache; 239 MiB em 50 arquivos; `--self-test` com `all_ok: true` e nenhum arquivo novo no diretório temporário |

Decomposição de um salvamento de 250 MiB:

| Etapa | Tempo |
|---|---|
| Escrita cifrada | ~4,5 s |
| Verificação completa | ~6,3 s |
| Transferência e validação entre processos | ~4 s |

Testes automatizados: 45 passam e 5 são exclusivos do Windows. Cobrem:
- gravação, leitura e cifragem em repouso;
- senha errada sem alterar o arquivo;
- arquivo SQLite comum recusado;
- revisão desatualizada e cofre trocado externamente (TA-09);
- formato mais novo recusado;
- página adulterada;
- processo morto em cada etapa do salvamento (TA-06);
- bloqueio de segunda instância (TA-08);
- edições durante a gravação;
- protocolo malformado;
- diálogo de senha;
- renderização sem arquivo temporário.

## 3. Problemas encontrados

| # | Problema | Situação |
|---|---|---|
| P1 | O SQLCipher grava erros de decifragem no stderr por padrão. | Resolvido: `cipher_log_level = NONE`, e o worker redireciona stdout/stderr para o nulo. |
| P2 | `cipher_memory_security` vem desligado desde o SQLCipher 4.5. | Resolvido: ligado em toda conexão. O custo medido foi desprezível. |
| P3 | O `sqlcipher3` 0.6.2 traz o OpenSSL 3.6.0 estaticamente no `.pyd` do Windows. Correções de segurança do OpenSSL dependem de nova versão do binding, não do Windows Update. | Aberto: monitorar versões do `sqlcipher3`. |
| P4 | O binding vem compilado com `ENABLE_LOAD_EXTENSION`. | Mitigado: o Python mantém o carregamento de extensões desativado e `trusted_schema = OFF`. |
| P5 | `os.replace` não usa `MOVEFILE_WRITE_THROUGH`; a troca pode ser dada como feita antes de chegar ao disco. | Resolvido com `MoveFileExW` via `ctypes`. Validar no Windows (G3). |
| P6 | Antivírus e indexador abrem o arquivo recém-gravado e fazem a substituição falhar. | Mitigado com 6 tentativas e espera crescente. Se persistir, o erro é `REPLACE_FAILED` e o cofre anterior é mantido. Medir no Windows. |
| P7 | Se o worker morre no meio do salvamento, o candidato cifrado fica no disco. | Aberto: falta a rotina de localizar e verificar candidatos (`03` §4). Os testes confirmam que os restos são sempre cifrados. |
| P8 | Salvar reescreve e reverifica o cofre inteiro: ~16 s para 250 MiB. Somado à senha a cada Ctrl+S, deixa o salvamento lento. | **Decisão necessária** (seção 5). |
| P9 | Qt ou bibliotecas C podem imprimir no stdout e corromper o protocolo do worker. | Resolvido: o protocolo usa cópias dos descritores, e os descritores 0, 1 e 2 apontam para o nulo. |
| P10 | O worker importava Qt antes de ler o pedido, então um erro de Qt derrubava até respostas sem senha. | Resolvido: Qt só é carregado quando a senha é pedida. |
| P11 | A janela de senha de outro processo pode abrir atrás da principal no Windows. | Mitigado com `AllowSetForegroundWindow`. Confirmar no Windows (G6). |
| P12 | O SQLCipher só valida a chave ao decifrar uma página, então abrir o handle não prova a senha. | Resolvido: há uma leitura real logo após a chave (`08` §3). |
| P13 | Strings Python são imutáveis: não há como zerar a senha. | Limitação conhecida (`03` §2). O impacto fica restrito ao worker, que termina após cada operação. |
| P14 | O `sqlcipher3` não traz tipos para o pyright. | Resolvido com stubs em `typings/sqlcipher3/`. |
| P15 | O Nuitka detecta o Python do uv como "Python Build Standalone", um flavor com suporte limitado. | No Linux o build funcionou mesmo assim. No Windows, se o build falhar, usar o Python oficial do python.org. |
| P16 | O executável tem 239 MiB, porque o plugin PySide6 inclui todos os plugins Qt (Wayland, impressão, TLS…). | Aberto: enxugar plugins e módulos Qt na fase 6. Não bloqueia a fase 0. |
| P17 | O `pdfminer` importa `unittest`, o que deixa o build mais lento e maior. | Aceito por enquanto: ainda não há como excluir sem quebrar o `pdfplumber`. |

## 4. Roteiro no Windows (gates G1–G7)

Pré-requisitos:
- Windows 10/11 x64;
- Python 3.12 oficial;
- `uv`;
- Visual Studio Build Tools com C++. O Nuitka pode baixar o MinGW se faltar.

```powershell
git clone <repo>; cd OpesVault
uv sync --group build
uv run pytest -q                                   # G0: suíte completa, incluindo os testes "windows"
uv run python scripts/fase0_medir_ram.py --mib 50 125 250 --out fase0-ram.json   # G2
uv run --group build python scripts/build.py       # G1
build\nuitka\opesvault_entry.dist\OpesVault.exe --self-test fase0-selftest.json   # G1
```

| Gate | Verificação | Passa quando |
|---|---|---|
| G0 | `pytest` no Windows | Todos passam, inclusive `tests/test_windows.py` |
| G1 | Build `standalone` + `--self-test` no executável | `all_ok: true`; SQLCipher com provedor `openssl`; `new_temp_entries` vazio; `worker_relaunch` funcionando |
| G2 | Medição de RAM e tempo | Registrar `fase0-ram.json`; definir o limite operacional (`01` §4) |
| G3 | Queda durante o salvamento | Repetir `tests/test_crash_recovery.py`; depois desligar a máquina à força durante um Ctrl+S de 250 MiB e reabrir o cofre: deve abrir na revisão anterior ou na nova |
| G4 | Sem arquivo claro | Depois de abrir/salvar/visualizar no executável, procurar em `%TEMP%`, na pasta do cofre e em `%LOCALAPPDATA%` arquivos criados no período. Só podem existir o cofre e o `.lock` |
| G5 | Antivírus | Com o Defender ativo, salvar 20 vezes seguidas um cofre de 250 MiB; anotar quantas falharam com `REPLACE_FAILED` |
| G6 | Janela de senha | No executável, a janela aparece na frente e com foco ao abrir e ao salvar |
| G7 | Restauração em outra máquina | Copiar o `.opesvault` por pendrive para outro Windows sem internet e abri-lo com o executável copiado |

Devolva os arquivos `fase0-ram.json` e `fase0-selftest.json`, a saída do `pytest` e anotações de G3–G7. Os relatórios não contêm senhas nem dados reais.

## 5. Decisões pendentes

> **Atualização de 02/10/2026 — custo do salvamento (P8) decidido.** Com o usuário ausente e a pedido dele ("resolva tudo que for possível"), foi adotada a opção (c), gravação incremental, que era a recomendação deste documento. Como funciona:
>
> - o candidato é uma cópia byte a byte do arquivo cifrado;
> - só as mudanças rastreadas são aplicadas nele;
> - a verificação cobre o HMAC de todas as páginas, a contagem total de registros e documentos, a releitura de cada linha alterada e o hash de cada documento novo;
> - a troca continua atômica;
> - cofres novos, migrados ou com troca de senha são regravados por completo.
>
> Medição com 50 mil lançamentos e 250 MiB de PDFs, Linux:
>
> | Métrica | Antes | Depois |
> |---|---|---|
> | Ctrl+S típico | ~21 s | ~3,7 s |
> | Memória do worker ao salvar | 817 MiB | 50 MiB |
> | Abrir | ~15 s | ~8,7 s |
>
> A abertura melhorou porque os registros trafegam como linhas JSON validadas uma única vez, o histórico antigo só é interpretado quando consultado e as páginas são autenticadas na própria leitura. A decisão pode ser revista; ela não altera o formato do arquivo.

1. **Custo do salvamento (P8).** Opções, em ordem crescente de complexidade:
   - (a) aceitar o custo e medir no Windows antes de decidir;
   - (b) reduzir a verificação, sem tocar na reescrita completa: o HMAC de todas as páginas cobre corrupção, e o `integrity_check` estrutural passaria a rodar só em backups;
   - (c) gravação incremental: copiar o arquivo cifrado byte a byte para o candidato e aplicar apenas as diferenças da sessão. A atomicidade se mantém, mas o snapshot passa a precisar de rastreamento de alterações.

   Recomendação: decidir depois de G2. Se o Windows ficar acima de ~20 s, optar por (c).
2. **Restos de candidatos (P7).** Na abertura, listar `<cofre>.candidate-*`, verificar cada um com a senha e oferecer descarte. Isso precisa de definição de UX.
3. **Versões e licenças.** Os dados do `--self-test` alimentam o inventário (`02` §3). Ainda falta o inventário de licenças de Qt (LGPL), PDFium e OpenSSL embutido no `sqlcipher3`.
