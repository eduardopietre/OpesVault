"""License inventory and SBOM of the runtime dependencies (phase 10).

Reads uv.lock (exact versions and wheel hashes) and the installed metadata (license
fields), and writes:

  build/licencas/THIRD_PARTY_LICENSES.md   human-readable inventory with obligations
  build/licencas/sbom.cdx.json             CycloneDX 1.5 SBOM

Usage:
  uv run python scripts/inventario_licencas.py [--out DIR] [--check]

--check fails (exit 1) when a runtime package lacks a license or a Windows x64 wheel
hash, or when a package with native code has no reviewed note below.
"""

import argparse
import importlib.metadata as metadata
import json
import sys
import tomllib
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from uuid import uuid4

ROOT = Path(__file__).resolve().parents[1]
ROOT_PACKAGE = "opesvault"

# Packages that ship compiled code or bundle third-party libraries. Each note says what
# is inside and what distribution requires; reviewed by hand, never generated.
NATIVE_NOTES: dict[str, str] = {
    "pyside6": "Qt for Python. LGPL-3.0 escolhida: Qt fica em DLLs separadas (modo standalone), com texto da "
    "licença e indicação de onde obter o código-fonte do Qt; o usuário pode trocar as DLLs.",
    "pyside6-essentials": "Módulos Qt essenciais (mesma licença e obrigações do PySide6).",
    "pyside6-addons": "Módulos Qt adicionais (mesma licença e obrigações do PySide6). Avaliar retirar do pacote os "
    "módulos não usados.",
    "shiboken6": "Runtime de bindings do PySide6 (LGPL-3.0).",
    "pypdfium2": "Inclui o binário do PDFium (BSD-3-Clause/Apache-2.0) com bibliotecas embutidas (FreeType, "
    "libjpeg-turbo, OpenJPEG, LittleCMS, zlib, libpng, ICU, Abseil). Distribuir os avisos de cada uma.",
    "sqlcipher3": "Inclui SQLCipher (BSD-3-Clause, Zetetic) e OpenSSL 3.x embutido (Apache-2.0). Acompanhar "
    "avisos de segurança do OpenSSL e atualizar o sqlcipher3 quando houver correção.",
    "matplotlib": "Licença baseada na PSF; inclui fontes DejaVu (licença Bitstream Vera/Arev) e STIX (OFL-1.1).",
    "numpy": "BSD-3-Clause; o wheel Windows inclui OpenBLAS (BSD-3-Clause) e runtime do gfortran (GPL-3.0 com "
    "GCC Runtime Library Exception, que permite a distribuição).",
    "pillow": "MIT-CMU; inclui libjpeg-turbo, libpng, zlib, libtiff, libwebp, FreeType, LittleCMS, OpenJPEG.",
    "pydantic-core": "Extensão em Rust (MIT); dependências Rust com licenças MIT/Apache-2.0.",
    "cryptography": "Apache-2.0 OU BSD-3-Clause; inclui OpenSSL próprio (Apache-2.0). Mesmo acompanhamento do "
    "OpenSSL do sqlcipher3.",
    "cffi": "MIT-0; extensão em C.",
    "fonttools": "MIT; módulos acelerados compilados com Cython.",
    "kiwisolver": "BSD-3-Clause; extensão em C++.",
    "contourpy": "BSD-3-Clause; extensão em C++.",
    "charset-normalizer": "MIT; pode incluir módulos compilados com mypyc.",
}


@dataclass(frozen=True)
class Component:
    name: str
    version: str
    license: str
    wheel: str | None
    sha256: str | None
    requires: tuple[str, ...]
    note: str | None


def load_lock() -> dict[str, dict]:
    data = tomllib.loads((ROOT / "uv.lock").read_text("utf-8"))
    return {p["name"]: p for p in data["package"]}


def runtime_closure(packages: dict[str, dict]) -> list[str]:
    """Runtime dependencies of the app, without the dev and build groups."""
    seen: set[str] = set()
    stack = [d["name"] for d in packages[ROOT_PACKAGE].get("dependencies", [])]
    while stack:
        name = stack.pop()
        if name in seen:
            continue
        seen.add(name)
        stack.extend(d["name"] for d in packages[name].get("dependencies", []))
    return sorted(seen)


def windows_wheel(package: dict) -> tuple[str | None, str | None]:
    """The wheel the Windows x64 build installs: cp312 win_amd64, abi3, or pure Python."""
    wheels = package.get("wheels", [])

    def score(wheel: dict) -> int:
        name = wheel["url"].rsplit("/", 1)[-1]
        if "win_amd64" in name and ("cp312" in name or "abi3" in name or "py3" in name):
            return 3
        if name.endswith("-none-any.whl"):
            return 2
        return 0

    best = max(wheels, key=score, default=None)
    if best is None or score(best) == 0:
        return None, None
    return best["url"].rsplit("/", 1)[-1], best["hash"].removeprefix("sha256:")


def license_of(name: str) -> str:
    try:
        md = metadata.metadata(name)
    except metadata.PackageNotFoundError:
        return ""
    expression = md.get("License-Expression")
    if expression:
        return expression.strip()
    text = (md.get("License") or "").strip()
    if text and "\n" not in text and len(text) <= 80:
        return text
    classifiers = [c.split(" :: ")[-1] for c in md.get_all("Classifier") or [] if c.startswith("License ::")]
    if classifiers:
        return " / ".join(classifiers)
    return "ver arquivo de licença do pacote" if text else ""


def collect() -> list[Component]:
    packages = load_lock()
    components = []
    for name in runtime_closure(packages):
        package = packages[name]
        wheel, digest = windows_wheel(package)
        components.append(
            Component(
                name=name,
                version=package["version"],
                license=license_of(name),
                wheel=wheel,
                sha256=digest,
                requires=tuple(sorted(d["name"] for d in package.get("dependencies", []))),
                note=NATIVE_NOTES.get(name),
            )
        )
    return components


def problems(components: list[Component]) -> list[str]:
    found = []
    for c in components:
        if not c.license:
            found.append(f"{c.name}: licença não identificada")
        if c.sha256 is None:
            found.append(f"{c.name}: sem wheel para Windows x64 no uv.lock")
        native = c.wheel is not None and not c.wheel.endswith("-none-any.whl")
        if native and c.note is None:
            found.append(f"{c.name}: código nativo sem nota revisada em NATIVE_NOTES")
    return found


def render_markdown(components: list[Component]) -> str:
    lines = [
        "# Licenças de terceiros — OpesVault",
        "",
        f"Gerado em {datetime.now(UTC):%d/%m/%Y} a partir do `uv.lock` por `scripts/inventario_licencas.py`.",
        "Componentes de execução incluídos no pacote Windows. Ferramentas de desenvolvimento e de build",
        "(pytest, ruff, pyright, Nuitka) não são distribuídas.",
        "",
        "| Pacote | Versão | Licença | Wheel Windows (SHA-256) |",
        "|---|---|---|---|",
    ]
    for c in components:
        digest = f"`{c.sha256[:16]}…`" if c.sha256 else "—"
        lines.append(f"| {c.name} | {c.version} | {c.license or '—'} | {digest} |")
    lines += ["", "## Componentes nativos e obrigações", ""]
    for c in components:
        if c.note:
            lines.append(f"- **{c.name} {c.version}** — {c.note}")
    lines += [
        "",
        "## Componentes fora do pacote Python",
        "",
        "- **Python 3.12** (PSF-2.0), embutido pelo Nuitka.",
        "- **Nuitka** gera o executável; o runtime incluído segue a licença Apache-2.0.",
        "- **Ollama** e modelos locais são opcionais, instalados à parte pelo usuário, e não fazem parte do pacote.",
        "",
        "Os textos integrais das licenças ficam nas pastas `*.dist-info/licenses` de cada pacote",
        "e devem acompanhar a distribuição.",
        "",
    ]
    return "\n".join(lines)


def render_sbom(components: list[Component]) -> dict:
    def ref(c: Component) -> str:
        return f"pkg:pypi/{c.name}@{c.version}"

    from opesvault import __version__

    return {
        "bomFormat": "CycloneDX",
        "specVersion": "1.5",
        "serialNumber": f"urn:uuid:{uuid4()}",
        "version": 1,
        "metadata": {
            "timestamp": datetime.now(UTC).isoformat(timespec="seconds"),
            "component": {"type": "application", "name": "OpesVault", "version": __version__},
        },
        "components": [
            {
                "type": "library",
                "bom-ref": ref(c),
                "name": c.name,
                "version": c.version,
                "purl": ref(c),
                **({"licenses": [{"expression": c.license}]} if c.license else {}),
                **({"hashes": [{"alg": "SHA-256", "content": c.sha256}]} if c.sha256 else {}),
                **({"description": c.note} if c.note else {}),
            }
            for c in components
        ],
        "dependencies": [
            {"ref": ref(c), "dependsOn": [ref(d) for d in components if d.name in c.requires]} for c in components
        ],
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--out", type=Path, default=ROOT / "build" / "licencas")
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    components = collect()
    issues = problems(components)
    if args.check:
        for issue in issues:
            print(issue)
        return 1 if issues else 0
    args.out.mkdir(parents=True, exist_ok=True)
    (args.out / "THIRD_PARTY_LICENSES.md").write_text(render_markdown(components), "utf-8")
    (args.out / "sbom.cdx.json").write_text(json.dumps(render_sbom(components), indent=2), "utf-8")
    print(f"{len(components)} componentes; {len(issues)} pendência(s). Saída em {args.out}")
    for issue in issues:
        print(f"  - {issue}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
