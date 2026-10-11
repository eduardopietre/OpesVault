"""Regenerates src/opesvault/catalogs/banks.py from the public list of Brazilian banks.

    uv run python scripts/atualizar_bancos.py bancos.json

Input: data/bancos.json of github.com/guibranco/BancosBrasileiros (public domain, Unlicense),
compiled from the Banco Central's lists of STR and SPI participants. The app embeds the
result so it works offline; this script only runs when the list is refreshed.
"""

import json
import sys
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TARGET = ROOT / "src" / "opesvault" / "catalogs" / "banks.py"


def main() -> int:
    source = Path(sys.argv[1])
    rows = json.loads(source.read_text(encoding="utf-8-sig"))
    out = []
    for row in rows:
        compe = (row.get("COMPE") or "").strip()
        if not compe.isdigit() or row.get("DateRemoved"):
            continue
        cnpj = "".join(c for c in (row.get("Document") or "") if c.isdigit())
        name = " ".join((row.get("LongName") or row.get("ShortName") or "").split())
        short = " ".join((row.get("ShortName") or name).split())
        out.append((compe.zfill(3), (row.get("ISPB") or "").strip(), cnpj if len(cnpj) == 14 else "", short, name))
    out.sort()
    lines = [
        "# ruff: noqa: E501 - generated data, one institution per line",
        '"""Brazilian banks and payment institutions with a COMPE code (generated, do not edit).',
        "",
        "Source: github.com/guibranco/BancosBrasileiros, data/bancos.json (public domain), compiled from",
        "the Banco Central's participant lists. Regenerate with scripts/atualizar_bancos.py.",
        '"""',
        "",
        f'UPDATED = "{date.today().isoformat()}"',
        "",
        "# (COMPE, ISPB, CNPJ digits or '', short name, full name)",
        "BANKS: tuple[tuple[str, str, str, str, str], ...] = (",
    ]
    lines += [f"    {row!r}," for row in out]
    lines.append(")")
    TARGET.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"{len(out)} instituições em {TARGET}; rode `uv run ruff format` em seguida")
    return 0


if __name__ == "__main__":
    sys.exit(main())
