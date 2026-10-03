# Fase 7 — Validação real: situação e roteiro

Versão 1.0 • 03/10/2026. Acompanha a fase 7 do `09` §1.2. Critério para avançar: G0–G7 aprovados; layouts prioritários com 3 documentos conferidos por versão; TA parciais (`15`) reavaliados. Este documento diz o que já foi verificado, com números, e o que falta, passo a passo.

## 1. Situação

| Item | Situação | Evidência |
|---|---|---|
| G0 — suíte no Windows | **Aprovado** | 341 testes passam, inclusive os 5 `windows` (`11` §2.1) |
| G1 — executável | Parcial: aprovado em modo Python | `python -m opesvault --self-test`: `all_ok`, SQLCipher 4.12 com OpenSSL. Falta o build Nuitka, que compila C (decisão do usuário) |
| G2 — RAM e tempo | **Medido** | Abrir 2,65 s com 250 MiB; pico da UI 833 MiB, acima da meta (fase 8) |
| G3 — queda durante o salvamento | Parcial | `tests/test_crash_recovery.py` passa no Windows. Falta o desligamento forçado (§2.2) |
| G4 — nenhum arquivo em claro | **Aprovado em modo Python** | `scripts/fase7_gates.py disco`: sessão completa (importar PDF comum, PDF com senha e CSV; visualizar; salvar; reabrir; salvar) sem nenhum arquivo novo em `%TEMP%` nem em `%LOCALAPPDATA%`; na pasta, só o cofre e o `.lock`. Falta repetir no executável |
| G5 — antivírus | **Aprovado em modo Python** | `scripts/fase7_gates.py antivirus`: 20 salvamentos seguidos de um cofre de 250 MiB com o Defender ativo (proteção em tempo real), **nenhuma falha**, 1,8 s em média e 3,4 s no pior caso |
| G6 — janela de senha | Pendente | Interativo (§2.3) |
| G7 — restauração em outra máquina | Pendente | Precisa de outro Windows (§2.4) |
| Escalas 150% e 200% | **Verificado** | Capturas em 1280 × 720 lógicos (1920 × 1080 e 2560 × 1440): nada cortado nem sobreposto. O PDF passou a ser renderizado na densidade real da tela |
| Leitor de tela | Parcial | `scripts/auditar_acessibilidade.py` e o teste `test_every_control_has_an_accessible_name`: todos os controles das telas e dos diálogos principais têm nome (23 corrigidos). Falta o teste com NVDA ou Narrador (§2.5) |
| PDF com senha | **Verificado** | AES-256, AES-128, RC4-128 e só proprietário (`tests/test_pdf_password.py`) |
| IA local | **Escolhido por avaliação** | `gemma4:12b`: 97% de acerto, 1 erro (`09` §4). Falta confirmar com descrições reais |
| Notas de terceiros | Pendente | Exige baixar arquivos de dois repositórios públicos (§2.6) |
| Corpus de documentos reais | Pendente | Exige os documentos da família (§3) |
| TA-18 e TA-24 | Continuam parciais | Pedem uma visão de patrimônio por integrante, que ainda não existe (só o resultado por competência tem essa visão). É funcionalidade nova, não teste |

## 2. O que depende do usuário

### 2.1 G1 — executável (decisão)

O build compila C com o Nuitka (cerca de 25 min) e usa o compilador do Visual Studio ou baixa o MinGW. Depois:

```powershell
uv run --group build python scripts/build.py
build\nuitka\opesvault_entry.dist\OpesVault.exe --self-test fase0-selftest.json
```

Passa quando `all_ok` é `true`, `new_temp_entries` está vazio e `worker_relaunch` funciona. Com o executável, repita G4 e G6 nele.

### 2.2 G3 — desligamento forçado

1. No app, use um cofre de teste com alguns PDFs grandes importados (o salvamento precisa durar alguns segundos).
2. Durante um Ctrl+S, desligue a máquina pelo botão (não pelo menu).
3. Ao ligar, abra o cofre: deve abrir na revisão anterior ou na nova, nunca corrompido. Se houver arquivos `*.candidate-*` ao lado, o app oferece removê-los.

### 2.3 G6 — janela de senha

No app (e depois no executável), ao abrir e ao salvar, a janela de senha deve aparecer **na frente** e com o cursor no campo, mesmo com outra janela ativa.

### 2.4 G7 — outra máquina

Copie o `.opesvault` por pendrive para outro Windows sem internet e abra com o app copiado. Deve abrir com a senha e mostrar os mesmos dados.

### 2.5 Leitor de tela

Com o NVDA (gratuito) ou o Narrador (Ctrl+Win+Enter), percorra com Tab a Visão geral, o Livro, Importar e um formulário de lançamento. Cada controle deve ser anunciado com um nome que faça sentido; anote os que não forem.

### 2.6 Notas de terceiros (autorização)

O README de `tests/fixtures/terceiros/notas_corretagem/` traz os comandos: clonar dois repositórios públicos (LGPL-3.0 e Apache-2.0) em commits fixos e copiar 8 PDFs anonimizados. Os 19 testes hoje pulados passam a rodar.

## 3. Corpus de documentos reais

1. Escolha os bancos e produtos prioritários (decisão pendente do `09` §4). Os layouts atuais: Nubank (cartão PDF, cartão CSV, conta CSV), Itaú (cartão e extrato PDF), Bradesco (cartão PDF), OFX genérico e notas SINACOR.
2. Junte **3 documentos por layout** numa pasta **fora do repositório**, de preferência num volume cifrado (BitLocker). Ex.: `D:\OpesVault-corpus\`.
3. Rode `uv run python scripts/validar_layouts.py D:\OpesVault-corpus --gerar-esperado`. Cada documento ganha um rascunho `X.esperado.json`.
4. Confira cada rascunho contra o original, corrija e marque `"conferido": true`.
5. Rode `uv run python scripts/validar_layouts.py D:\OpesVault-corpus`. O relatório mostra só nomes de campos e posições, sem valores, e pode ser compartilhado para ajustar os parsers. `--detalhes` mostra valores e não deve ser compartilhado.
6. Com 3 documentos conferidos sem divergência, o parser passa a `validated_with_real_documents = True`.

Os documentos e os `*.esperado.json` nunca entram no git (`.gitignore`).
