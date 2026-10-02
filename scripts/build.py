"""Build the standalone executable with Nuitka.

    uv sync --group build
    uv run --group build python scripts/build.py

Uses `--standalone`, never `--onefile`: onefile unpacks the whole application
into %TEMP% on every launch, including every vault worker launch (CLAUDE.md).
Output: build/nuitka/opesvault_entry.dist/OpesVault[.exe]
"""

import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "build" / "nuitka"


def nuitka_command() -> list[str]:
    cmd = [
        sys.executable,
        "-m",
        "nuitka",
        "--standalone",
        "--enable-plugin=pyside6",
        "--include-package=opesvault",
        "--include-package=pypdfium2_raw",
        # Developer tooling must never end up in the shipped executable.
        "--nofollow-import-to=pytest",
        "--nofollow-import-to=psutil",
        "--nofollow-import-to=tkinter",
        "--nofollow-import-to=PIL.ImageTk",
        "--output-filename=OpesVault",
        f"--output-dir={OUT}",
        "--assume-yes-for-downloads",
        "--report=" + str(OUT / "nuitka-report.xml"),
    ]
    if sys.platform == "win32":
        cmd += [
            "--windows-console-mode=disable",
            "--company-name=OpesVault",
            "--product-name=OpesVault",
            "--file-version=0.1.0.0",
            "--product-version=0.1.0.0",
        ]
    cmd.append(str(ROOT / "scripts" / "opesvault_entry.py"))
    return cmd


if __name__ == "__main__":
    OUT.mkdir(parents=True, exist_ok=True)
    sys.exit(subprocess.call(nuitka_command(), cwd=ROOT))
