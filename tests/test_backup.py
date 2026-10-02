import os
from datetime import datetime
from pathlib import Path

import pytest

from opesvault.vault import sqlcipher_store as store
from opesvault.vault.backup import (
    copy_for_restore,
    create_backup,
    list_backups,
    prune_backups,
    remove_candidates,
    stale_candidates,
)
from opesvault.vault.client import VaultClient
from opesvault.vault.errors import ErrorCode, VaultError

from .conftest import PASSWORD, dev_worker_command
from .test_store import MARKER, make_snapshot


def _vault(vault_path: Path) -> int:
    info = store.save(vault_path, PASSWORD, make_snapshot(), None)
    return info.revision


def test_backup_is_encrypted_copy_and_restores_ta07(vault_path: Path, tmp_path: Path) -> None:
    revision = _vault(vault_path)
    backup = create_backup(vault_path, revision, tmp_path / "backups")
    assert MARKER.encode() not in backup.read_bytes()
    restored = copy_for_restore(backup, tmp_path / "restaurado.opesvault")
    _, snapshot = store.load(restored, PASSWORD)
    _, original = store.load(vault_path, PASSWORD)
    assert snapshot.manifest == original.manifest and snapshot.blobs == original.blobs
    with pytest.raises(VaultError) as exc:
        copy_for_restore(backup, vault_path)  # never overwrites the current vault
    assert exc.value.code is ErrorCode.ALREADY_EXISTS


def test_backup_never_overwrites(vault_path: Path, tmp_path: Path) -> None:
    revision = _vault(vault_path)
    when = datetime(2026, 1, 1, 12, 0, 0)
    create_backup(vault_path, revision, tmp_path, when)
    with pytest.raises(VaultError):
        create_backup(vault_path, revision, tmp_path, when)


def test_prune_keeps_newest_and_pinned(vault_path: Path, tmp_path: Path) -> None:
    revision = _vault(vault_path)
    dest = tmp_path / "b"
    made = [create_backup(vault_path, revision + i, dest, datetime(2026, 1, 1 + i)) for i in range(5)]
    deleted = prune_backups(dest, vault_path.stem, keep=2, pinned={made[0].name})
    remaining = [b.path for b in list_backups(dest, vault_path.stem)]
    assert made[0] in remaining and made[-1] in remaining
    assert len(remaining) == 3 and len(deleted) == 2
    (dest / "outro-arquivo.opesvault").write_bytes(b"x")
    prune_backups(dest, vault_path.stem, keep=1, pinned=set())
    assert (dest / "outro-arquivo.opesvault").exists()  # never touches foreign files


def test_stale_candidates_are_found_and_only_they_are_removed(vault_path: Path) -> None:
    _vault(vault_path)
    leftover = vault_path.with_name(vault_path.name + ".candidate-abc")
    leftover.write_bytes(os.urandom(64))
    other = vault_path.with_name("outro.opesvault")
    other.write_bytes(b"x")
    found = stale_candidates(vault_path)
    assert found == [leftover]
    assert remove_candidates(vault_path, [*found, vault_path, other]) == 1
    assert vault_path.exists() and other.exists() and not leftover.exists()


def test_change_password_through_worker(vault_path: Path, monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    info = store.save(vault_path, PASSWORD, make_snapshot(), None)
    backup = create_backup(vault_path, info.revision, tmp_path / "b")
    monkeypatch.setenv("OPV_DEV_PASSWORD", PASSWORD)
    monkeypatch.setenv("OPV_DEV_NEW_PASSWORD", "nova senha forte")
    changed = VaultClient(dev_worker_command()).change_password(vault_path, info.revision_id)
    assert changed.revision == 2
    store.load(vault_path, "nova senha forte")
    with pytest.raises(VaultError):
        store.load(vault_path, PASSWORD)
    store.load(backup, PASSWORD)  # old backups keep the old password


def test_change_password_with_wrong_current(vault_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    info = store.save(vault_path, PASSWORD, make_snapshot(), None)
    before = vault_path.read_bytes()
    monkeypatch.setenv("OPV_DEV_PASSWORD", "errada")
    monkeypatch.setenv("OPV_DEV_NEW_PASSWORD", "x")
    with pytest.raises(VaultError) as exc:
        VaultClient(dev_worker_command()).change_password(vault_path, info.revision_id)
    assert exc.value.code is ErrorCode.WRONG_PASSWORD
    assert vault_path.read_bytes() == before
