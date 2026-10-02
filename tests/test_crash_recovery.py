"""TA-06: a save killed at any stage leaves either the old or the new revision."""

import os
from pathlib import Path

import pytest

from opesvault.vault import sqlcipher_store as store
from opesvault.vault.client import VaultClient
from opesvault.vault.errors import ErrorCode, VaultError

from .conftest import PASSWORD, dev_worker_command
from .test_store import MARKER, make_snapshot


@pytest.mark.parametrize(
    ("stage", "expected_revision"),
    [("candidate_written", 1), ("candidate_verified", 1), ("replaced", 2)],
)
def test_killed_save_keeps_a_valid_vault(
    vault_path: Path, monkeypatch: pytest.MonkeyPatch, stage: str, expected_revision: int
) -> None:
    snap = make_snapshot()
    first = store.save(vault_path, PASSWORD, snap, None)

    monkeypatch.setenv("OPV_DEV_PASSWORD", PASSWORD)
    monkeypatch.setenv("OPV_DEV_FAULT_STAGE", stage)
    with pytest.raises(VaultError) as exc:
        VaultClient(dev_worker_command()).save(vault_path, snap, first.revision_id)
    assert exc.value.code is ErrorCode.UNCERTAIN

    info, loaded = store.load(vault_path, PASSWORD)
    assert info.revision == expected_revision
    assert loaded.manifest == snap.manifest

    # A dead worker cannot clean up: leftovers must be encrypted candidates only.
    leftovers = [p for p in vault_path.parent.iterdir() if p != vault_path]
    for leftover in leftovers:
        assert store.CANDIDATE_INFIX in leftover.name
        raw = leftover.read_bytes()
        assert MARKER.encode() not in raw
        assert not raw.startswith(store.PLAIN_SQLITE_HEADER)
        os.remove(leftover)
