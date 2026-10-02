"""Phase 10: the license inventory covers every runtime dependency (scripts/inventario_licencas.py)."""

import importlib.util
import json
from pathlib import Path
from types import ModuleType

ROOT = Path(__file__).resolve().parents[1]


def load_script() -> ModuleType:
    spec = importlib.util.spec_from_file_location("inventario", ROOT / "scripts" / "inventario_licencas.py")
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_every_runtime_dependency_is_inventoried() -> None:
    inventory = load_script()
    components = inventory.collect()
    names = {c.name for c in components}
    assert {"pyside6", "sqlcipher3", "pypdfium2", "matplotlib", "pdfplumber", "pydantic"} <= names
    assert not names & {"pytest", "ruff", "pyright", "nuitka", "psutil"}  # dev tools are not shipped
    assert inventory.problems(components) == []


def test_sbom_and_markdown(tmp_path: Path) -> None:
    inventory = load_script()
    components = inventory.collect()
    sbom = inventory.render_sbom(components)
    assert sbom["bomFormat"] == "CycloneDX" and len(sbom["components"]) == len(components)
    refs = {c["bom-ref"] for c in sbom["components"]}
    assert all(dep in refs for entry in sbom["dependencies"] for dep in entry["dependsOn"])
    assert all(c["hashes"][0]["content"] for c in sbom["components"])
    json.dumps(sbom)
    text = inventory.render_markdown(components)
    assert "LGPL-3.0" in text and "OpenSSL" in text
