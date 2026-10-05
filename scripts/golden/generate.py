"""Reference files for the web port (docs/18 §4).

Runs the desktop domain over fixed scenarios and writes inputs and expected outputs as JSON
into web/packages/domain/golden/. The TypeScript domain must reproduce each file exactly;
decimals are compared as text, without tolerance.

    uv run python -m scripts.golden.generate [NAME ...]
"""

import argparse
import importlib
import json
import sys
from collections.abc import Callable
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "web" / "packages" / "domain" / "golden"


def _discover() -> dict[str, str]:
    """Every scripts/golden/cases_<name>.py is a generator named <name>."""
    here = Path(__file__).resolve().parent
    return {p.stem.removeprefix("cases_"): f"scripts.golden.{p.stem}" for p in sorted(here.glob("cases_*.py"))}


GENERATORS: dict[str, str] = _discover()


def _load(name: str) -> Callable[[], Any]:
    return importlib.import_module(GENERATORS[name]).generate


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("names", nargs="*", help="generators to run (default: all)")
    args = parser.parse_args(argv)
    names = args.names or sorted(GENERATORS)
    unknown = [n for n in names if n not in GENERATORS]
    if unknown:
        print("unknown generators:", ", ".join(unknown), file=sys.stderr)
        return 2
    OUT.mkdir(parents=True, exist_ok=True)
    for name in names:
        data = _load(name)()
        path = OUT / f"{name}.json"
        path.write_text(json.dumps(data, ensure_ascii=False, indent=1, sort_keys=False) + "\n", encoding="utf-8")
        print(f"{path.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
