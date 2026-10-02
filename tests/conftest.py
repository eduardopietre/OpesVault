import os
import sys
from collections.abc import Iterator
from pathlib import Path

import pytest

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

ROOT = Path(__file__).resolve().parents[1]
DEV_WORKER = ROOT / "scripts" / "dev_worker.py"
PASSWORD = "senha de teste ç'\"%"


def pytest_configure(config: pytest.Config) -> None:
    config.addinivalue_line("markers", "windows: needs a real Windows machine; run manually (see docs/fase0)")


def pytest_collection_modifyitems(items: list[pytest.Item]) -> None:
    if sys.platform == "win32":
        return
    skip = pytest.mark.skip(reason="Windows-only gate; run manually on Windows")
    for item in items:
        if "windows" in item.keywords:
            item.add_marker(skip)


@pytest.fixture
def vault_path(tmp_path: Path) -> Path:
    return tmp_path / "familia.opesvault"


@pytest.fixture
def dev_worker_env(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    monkeypatch.setenv("OPV_DEV_PASSWORD", PASSWORD)
    yield


def dev_worker_command() -> list[str]:
    return [sys.executable, str(DEV_WORKER)]
