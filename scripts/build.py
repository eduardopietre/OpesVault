"""OPTIONAL: build the standalone executable with Nuitka, and optionally an installer.

    uv sync --group build
    uv run --group build python scripts/build.py              # standalone folder only
    uv run --group build python scripts/build.py --installer  # plus Inno Setup installer (Windows)

Development and tests never need this: run `uv run python -m opesvault`.

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


def build_installer() -> int:
    import shutil

    iscc = shutil.which("ISCC") or shutil.which("ISCC.exe")
    default = Path("C:/Program Files (x86)/Inno Setup 6/ISCC.exe")
    if iscc is None and default.exists():
        iscc = str(default)
    if iscc is None:
        print("Inno Setup (ISCC.exe) não encontrado; o instalador é opcional. A pasta standalone já pode ser usada.")
        return 0
    from opesvault import __version__

    script = ROOT / "packaging" / "windows" / "opesvault.iss"
    return subprocess.call([iscc, f"/DAppVersion={__version__}", str(script)], cwd=script.parent)


def ship_licenses() -> int:
    """Inventory + SBOM next to the executable ("Sobre" points users to it)."""
    dist = OUT / "opesvault_entry.dist"
    code = subprocess.call([sys.executable, str(ROOT / "scripts" / "inventario_licencas.py"), "--out", str(dist)])
    if code == 0:
        (dist / "THIRD_PARTY_LICENSES.md").replace(dist / "THIRD_PARTY_LICENSES.txt")
    return code


if __name__ == "__main__":
    OUT.mkdir(parents=True, exist_ok=True)
    code = subprocess.call(nuitka_command(), cwd=ROOT)
    if code == 0:
        code = ship_licenses()
    if code == 0 and "--installer" in sys.argv[1:]:
        code = build_installer()
    sys.exit(code)
