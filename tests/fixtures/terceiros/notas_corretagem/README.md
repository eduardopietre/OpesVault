# Notas de corretagem de terceiros (fixtures)

Notas reais **anonimizadas** publicadas por outros projetos de código aberto. Usadas só como referência de layout e em testes de parser. A auditoria de dados pessoais está em `docs/12` §4. O Banco Inter está fora de interesse e suas notas não entram.

## Arquivos esperados

| Arquivo | Corretora | Páginas | Senha | Origem |
|---|---|---|---|---|
| `leitor-de-notas-de-corretagem/clear_multi_page.pdf` | Clear | 3 | — | L |
| `leitor-de-notas-de-corretagem/clear_single_page_sell.pdf` | Clear | 1 | — | L |
| `leitor-de-notas-de-corretagem/clear_single_page_sell_pwd.pdf` | Clear | 1 | `456` | L |
| `leitor-de-notas-de-corretagem/rico_multi_page.pdf` | Rico | 2 | — | L |
| `leitor-de-notas-de-corretagem/rico_single_page.pdf` | Rico | 1 | — | L |
| `leitor-de-notas-de-corretagem/rico_single_page_pwd.pdf` | Rico | 1 | `123` | L |
| `leitor-de-notas-de-corretagem/nubank_single_page.pdf` | NuInvest | 1 | — | L |
| `correpy/b3_one_page.pdf` | Clear | 1 | — | C |

- **L:** [planetsLightningArrester/leitor-de-notas-de-corretagem](https://github.com/planetsLightningArrester/leitor-de-notas-de-corretagem), commit `6cacd7a5023c820acd13c0ecd786ff3d4c8f52f9`, pasta `backend/src/__tests__/notes/`. Licença LGPL-3.0, cópia em `leitor-de-notas-de-corretagem/LICENSE`.
- **C:** [thiagosalvatore/correpy](https://github.com/thiagosalvatore/correpy), commit `fd96711b834d7aaf9e0b6b335db31717c2d4c6a4`, arquivo `tests/fixtures/b3_one_page.pdf`. Licença Apache-2.0, cópia em `correpy/LICENSE`.

As senhas são de teste, publicadas pelo projeto de origem; não pertencem a ninguém.

## Como adicionar (PowerShell ou bash, a partir da raiz do repositório)

```bash
git clone https://github.com/planetsLightningArrester/leitor-de-notas-de-corretagem.git /tmp/leitor
git -C /tmp/leitor checkout 6cacd7a5023c820acd13c0ecd786ff3d4c8f52f9
git clone https://github.com/thiagosalvatore/correpy.git /tmp/correpy
git -C /tmp/correpy checkout fd96711b834d7aaf9e0b6b335db31717c2d4c6a4

D=tests/fixtures/terceiros/notas_corretagem
mkdir -p $D/leitor-de-notas-de-corretagem $D/correpy
for f in clear_multi_page clear_single_page_sell clear_single_page_sell_pwd \
         rico_multi_page rico_single_page rico_single_page_pwd nubank_single_page; do
  cp /tmp/leitor/backend/src/__tests__/notes/$f.pdf $D/leitor-de-notas-de-corretagem/
done
cp /tmp/leitor/LICENSE $D/leitor-de-notas-de-corretagem/LICENSE
cp /tmp/correpy/tests/fixtures/b3_one_page.pdf $D/correpy/
cp /tmp/correpy/LICENSE $D/correpy/LICENSE

uv run pytest -q tests/test_fixtures_terceiros.py   # deve passar sem "skipped"
git add $D && git commit -m "Add anonymized third-party brokerage note fixtures"
```

No Windows, troque `/tmp/...` por uma pasta temporária, `mkdir -p` por `New-Item -ItemType Directory -Force` e o laço por `foreach`.
