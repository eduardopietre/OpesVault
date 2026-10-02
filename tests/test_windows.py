"""Windows-only gates (docs/02 §8). Skipped elsewhere; run on the reference Windows machine."""

import subprocess
import sys
import threading
import time
from pathlib import Path

import pytest

from opesvault.vault import sqlcipher_store as store
from opesvault.vault.atomic import replace_durably

from .conftest import PASSWORD
from .test_store import make_snapshot

pytestmark = pytest.mark.windows


def test_replace_waits_for_a_transient_reader(tmp_path: Path) -> None:
    """An antivirus-like handle on the vault delays, but does not break, the replace."""
    target = tmp_path / "v.opesvault"
    candidate = tmp_path / "v.opesvault.candidate-x"
    target.write_bytes(b"old")
    candidate.write_bytes(b"new")
    handle = target.open("rb")  # Python opens without FILE_SHARE_DELETE.
    threading.Timer(0.5, handle.close).start()
    replace_durably(candidate, target)
    assert target.read_bytes() == b"new"


def test_replace_blocked_for_long_keeps_old_vault(tmp_path: Path) -> None:
    target = tmp_path / "v.opesvault"
    candidate = tmp_path / "v.opesvault.candidate-x"
    target.write_bytes(b"old")
    candidate.write_bytes(b"new")
    with target.open("rb"), pytest.raises(OSError):
        replace_durably(candidate, target)
    assert target.read_bytes() == b"old"


def test_lock_blocks_another_process(vault_path: Path) -> None:
    from opesvault.vault.lock import VaultLock

    code = (
        "import sys; from pathlib import Path; from opesvault.vault.lock import VaultLock;"
        "from opesvault.vault.errors import VaultError\n"
        "try:\n VaultLock(Path(sys.argv[1])).acquire(); sys.exit(0)\n"
        "except VaultError: sys.exit(7)"
    )
    with VaultLock(vault_path):
        result = subprocess.run([sys.executable, "-c", code, str(vault_path)], check=False)
    assert result.returncode == 7


def test_save_time_is_recorded(vault_path: Path) -> None:
    snap = make_snapshot(n_docs=5)
    started = time.perf_counter()
    store.save(vault_path, PASSWORD, snap, None)
    print(f"save on Windows: {time.perf_counter() - started:.2f}s")
