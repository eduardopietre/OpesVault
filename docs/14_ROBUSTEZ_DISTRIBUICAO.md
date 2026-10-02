# Robustez e distribuição

Versão 1.0 • 02/10/2026. Registra o que a fase 10 (`09` §1.2) entregou: fuzzing, registro técnico, inventário de licenças e SBOM, e a revisão de segurança feita até aqui. O que depende do Windows ou de versões validadas na fase 7 está em §5.

## 1. Fuzzing de documentos

`tests/test_fuzz.py` gera variações de cada documento sintético a partir de sementes fixas. Uma falha sempre se reproduz.

- **Texto de PDF:** linhas apagadas, duplicadas, trocadas ou truncadas; números trocados por valores hostis (datas impossíveis, sinais conflitantes, 400 dígitos, `NaN`, `Infinity`, menos Unicode); instruções no texto. Todos os parsers rodam sobre cada variação, inclusive os de outro layout.
- **Bytes de PDF:** bytes trocados, inseridos e cortados, passando pelo pipeline inteiro.
- **CSV e OFX:** as mesmas mutações de texto, em UTF-8 e cp1252, pelo pipeline inteiro.
- **Entradas degeneradas:** arquivo vazio, só cabeçalho, OFX com milhares de transações vazias, CSV de 10 mil linhas, bytes nulos.

**Contrato:**
- Um documento ruim só produz um resultado classificado: `SourceError`, `DomainError` ou um lote com avisos.
- Uma recusa não deixa nada gravado na sessão.
- Um parser que falha vira `ParseFailed`: o arquivo fica guardado como lote sem layout e o usuário pode tentar outro layout. A mensagem leva o identificador do parser e o código `PARSE_FAILED`, nunca texto do documento.
- Valores ilegíveis e datas impossíveis vão para as linhas não mapeadas, sem derrubar o documento.

**Execução:** o padrão roda 60 variações por documento (alguns segundos). Para uma rodada longa, use `OPV_FUZZ_ITERATIONS=3000 uv run pytest tests/test_fuzz.py`, que leva cerca de 45 s. A rodada de 3000 passou depois das correções desta fase.

**Falhas encontradas e corrigidas:**
- valor com sinais conflitantes derrubava o parser;
- data de vencimento impossível no cabeçalho da Nubank;
- erros tardios do pdfminer (estrutura corrompida descoberta página a página);
- CSV com quebra de linha dentro de campo;
- layout de outro formato forçado pelo usuário;
- reprocessar um lote apagava o lote anterior antes de saber se o novo layout funcionava.

## 2. Registro técnico

`src/opesvault/diagnostics.py` grava uma linha JSON por ocorrência em:

- Windows: `%LOCALAPPDATA%\OpesVault\logs\opesvault.log`;
- Linux: `~/.local/state/opesvault/logs/opesvault.log`.

O arquivo gira em 256 KiB e guarda uma geração anterior.

| Gravado | Nunca gravado |
|---|---|
| instante, versão, código (`UNHANDLED`, `JOB_FAILED`, `IMPORT_FAILED`, `WORKER_INTERNAL`…) | mensagem da exceção |
| tipo da exceção | argumentos, variáveis locais |
| identificador de ocorrência mostrado ao usuário | caminhos de cofres e documentos |
| cadeia `opesvault.modulo.funcao:linha` | nomes, valores, descrições, texto de documentos |

As mensagens de exceção ficam de fora porque os erros de domínio são escritos para o usuário e podem citar o que ele digitou. Pelo mesmo motivo, `MoneyError` deixou de repetir o texto que não conseguiu interpretar.

Exceções não tratadas, na thread principal, em slots do Qt ou em outras threads, passam pelo registro e mostram ao usuário só o identificador da ocorrência. Os ganchos padrão do Python, que imprimiriam o traceback com mensagens, são substituídos. Uma falha ao gravar o registro (disco cheio, pasta sem permissão) é ignorada para não virar outra falha.

Os testes usam uma pasta temporária (`OPV_LOG_DIR`), nunca o perfil do usuário.

## 3. Licenças e SBOM

`uv run python scripts/inventario_licencas.py` lê o `uv.lock` (versões exatas e hashes dos wheels Windows x64) e os metadados instalados (licenças). Gera em `build/licencas/`:

- `THIRD_PARTY_LICENSES.md`: tabela de pacotes e obrigações dos componentes nativos;
- `sbom.cdx.json`: SBOM CycloneDX 1.5 com `purl`, licença, SHA-256 e dependências.

O `scripts/build.py` copia os dois para a pasta do executável (`THIRD_PARTY_LICENSES.txt`), e o instalador os leva junto. A tela "Sobre" aponta para eles.

`--check` falha quando um pacote de execução não tem licença identificada, não tem wheel Windows no lock ou contém código nativo sem nota revisada. `tests/test_licenses.py` roda essa verificação, então uma dependência nova não entra sem revisão.

**Obrigações principais:**
- **Qt/PySide6 (LGPL-3.0):** as DLLs do Qt ficam separadas (modo `standalone`, nunca `onefile`), o usuário pode substituí-las, e o pacote leva o texto da licença e onde obter o código-fonte do Qt.
- **PDFium (pypdfium2):** BSD-3-Clause/Apache-2.0, com os avisos das bibliotecas embutidas (FreeType, libjpeg-turbo, OpenJPEG, LittleCMS, zlib, ICU).
- **OpenSSL:** embutido no `sqlcipher3` e no `cryptography`. Ver §4.
- **numpy:** o runtime do gfortran tem a GCC Runtime Library Exception, que permite a distribuição.

## 4. Acompanhamento do OpenSSL e revisão de segurança

**OpenSSL.** O SQLCipher usa o OpenSSL embutido no wheel do `sqlcipher3` (3.6 na versão 0.6.2). A cada aviso de segurança do OpenSSL:

1. verificar se afeta as funções usadas pelo SQLCipher (PBKDF2, AES-256-CBC, HMAC-SHA512);
2. se afetar, atualizar o `sqlcipher3` quando houver wheel corrigido e repetir os gates G1 e G2;
3. registrar a decisão no `09` §5.

O `cryptography` (dependência do pdfminer) traz outro OpenSSL, usado só para PDFs protegidos por senha.

**Revisão do worker e das exportações (feita nesta fase):**
- O worker recebe só caminho, revisão-base e blobs pelo pipe. A senha é digitada nele; nenhuma linha de comando ou variável de ambiente a carrega (o `scripts/dev_worker.py` de testes fica fora do pacote).
- Falhas internas do worker agora vão para o registro técnico com código, sem traceback no stderr.
- Desbloquear a tela (bloqueio visual por inatividade) usa o worker. Ele confere a senha e também a revisão aberta, para que outro cofre com senha conhecida, copiado por cima, não desbloqueie a tela.
- A exportação exige confirmação, avisa que o arquivo fica sem cifra e não altera o cofre (TA-34). Erro de gravação vira mensagem, não exceção.
- Parser é tratado como código não confiável sobre entrada não confiável (§1).

## 5. Pendências da fase 10

- Fixar versões depois dos gates G1/G2 no Windows (fase 7).
- Assinatura do instalador: exige certificado de assinatura de código, uma decisão do usuário.
- Retirar do pacote os módulos Qt não usados (`pyside6-addons`) para reduzir tamanho e superfície; validar com o Nuitka no Windows.
- Ícone do aplicativo (`09` §4).
