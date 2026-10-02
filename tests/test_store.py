import os
import sqlite3
from pathlib import Path
from uuid import uuid4

import pytest
from sqlcipher3 import dbapi2 as sqlcipher

from opesvault.devtools.synthetic_pdf import make_pdf
from opesvault.vault import sqlcipher_store as store
from opesvault.vault.errors import ErrorCode, VaultError
from opesvault.vault.model import Document, Record, Snapshot

from .conftest import PASSWORD

MARKER = "PADARIA_SINTETICA_MARCADOR"


def make_snapshot(vault_id=None, n_docs: int = 2) -> Snapshot:
    docs = tuple(Document.from_bytes(f"doc{i}.pdf", make_pdf([MARKER, f"doc {i}"])) for i in range(n_docs))
    records = (Record(id=uuid4(), kind="tx", payload={"description": MARKER, "amount": "10.50"}),)
    return Snapshot.build(vault_id or uuid4(), records, docs)


def test_create_save_load_roundtrip(vault_path: Path) -> None:
    snap = make_snapshot()
    first = store.save(vault_path, PASSWORD, snap, None)
    second = store.save(vault_path, PASSWORD, snap, first.revision_id)
    info, loaded = store.load(vault_path, PASSWORD)

    assert (first.revision, second.revision) == (1, 2)
    assert info == second
    assert loaded.manifest == snap.manifest
    assert loaded.blobs == snap.blobs


def test_vault_bytes_are_encrypted(vault_path: Path) -> None:
    store.save(vault_path, PASSWORD, make_snapshot(), None)
    raw = vault_path.read_bytes()
    assert MARKER.encode() not in raw
    assert b"%PDF" not in raw
    assert not raw.startswith(store.PLAIN_SQLITE_HEADER)
    with pytest.raises(sqlite3.DatabaseError):
        sqlite3.connect(vault_path).execute("SELECT * FROM sqlite_master").fetchall()


def test_only_the_vault_file_remains(vault_path: Path) -> None:
    snap = make_snapshot()
    info = store.save(vault_path, PASSWORD, snap, None)
    store.save(vault_path, PASSWORD, snap, info.revision_id)
    store.load(vault_path, PASSWORD)
    assert sorted(p.name for p in vault_path.parent.iterdir()) == [vault_path.name]


def test_wrong_password_on_load_and_save_changes_nothing(vault_path: Path) -> None:
    info = store.save(vault_path, PASSWORD, make_snapshot(), None)
    before = vault_path.read_bytes()
    with pytest.raises(VaultError) as exc:
        store.load(vault_path, PASSWORD + "x")
    assert exc.value.code is ErrorCode.WRONG_PASSWORD
    with pytest.raises(VaultError) as exc:
        store.save(vault_path, PASSWORD + "x", make_snapshot(info.vault_id), info.revision_id)
    assert exc.value.code is ErrorCode.WRONG_PASSWORD
    assert vault_path.read_bytes() == before


def test_empty_password_rejected(vault_path: Path) -> None:
    with pytest.raises(VaultError):
        store.save(vault_path, "", make_snapshot(), None)
    assert not vault_path.exists()


def test_plain_sqlite_file_is_not_a_vault(vault_path: Path) -> None:
    sqlite3.connect(vault_path).execute("CREATE TABLE t (x)").connection.commit()
    with pytest.raises(VaultError) as exc:
        store.load(vault_path, PASSWORD)
    assert exc.value.code is ErrorCode.NOT_A_VAULT


def test_create_refuses_existing_file(vault_path: Path) -> None:
    vault_path.write_bytes(b"something")
    with pytest.raises(VaultError) as exc:
        store.save(vault_path, PASSWORD, make_snapshot(), None)
    assert exc.value.code is ErrorCode.ALREADY_EXISTS
    assert vault_path.read_bytes() == b"something"


def test_stale_base_revision_is_refused(vault_path: Path) -> None:
    snap = make_snapshot()
    first = store.save(vault_path, PASSWORD, snap, None)
    store.save(vault_path, PASSWORD, snap, first.revision_id)
    before = vault_path.read_bytes()
    with pytest.raises(VaultError) as exc:
        store.save(vault_path, PASSWORD, snap, first.revision_id)
    assert exc.value.code is ErrorCode.REVISION_MISMATCH
    assert vault_path.read_bytes() == before


def test_externally_replaced_vault_is_detected(vault_path: Path, tmp_path: Path) -> None:
    """TA-09: another vault copied over ours must not be overwritten."""
    snap = make_snapshot()
    ours = store.save(vault_path, PASSWORD, snap, None)
    other = tmp_path / "other.opesvault"
    store.save(other, PASSWORD, make_snapshot(snap.manifest.vault_id), None)
    os.replace(other, vault_path)
    with pytest.raises(VaultError) as exc:
        store.save(vault_path, PASSWORD, snap, ours.revision_id)
    assert exc.value.code is ErrorCode.REVISION_MISMATCH


def test_replacement_during_write_is_detected(vault_path: Path) -> None:
    snap = make_snapshot()
    info = store.save(vault_path, PASSWORD, snap, None)

    def swap(stage: str) -> None:
        if stage == "candidate_verified":
            vault_path.write_bytes(vault_path.read_bytes() + b"\0")

    with pytest.raises(VaultError) as exc:
        store.save(vault_path, PASSWORD, snap, info.revision_id, fault_hook=swap)
    assert exc.value.code is ErrorCode.REVISION_MISMATCH
    assert sorted(p.name for p in vault_path.parent.iterdir()) == [vault_path.name]


def test_newer_format_is_refused(vault_path: Path) -> None:
    store.save(vault_path, PASSWORD, make_snapshot(), None)
    conn = sqlcipher.connect(str(vault_path))
    conn.execute(store._key_pragma(PASSWORD))
    conn.execute("UPDATE meta SET value = '999' WHERE key = 'format_version'")
    conn.commit()
    conn.close()
    with pytest.raises(VaultError) as exc:
        store.load(vault_path, PASSWORD)
    assert exc.value.code is ErrorCode.INCOMPATIBLE_FORMAT


def test_tampered_page_is_detected(vault_path: Path) -> None:
    store.save(vault_path, PASSWORD, make_snapshot(n_docs=3), None)
    raw = bytearray(vault_path.read_bytes())
    raw[len(raw) // 2] ^= 0xFF
    vault_path.write_bytes(bytes(raw))
    with pytest.raises(VaultError) as exc:
        store.load(vault_path, PASSWORD)
    assert exc.value.code in {ErrorCode.VERIFY_FAILED, ErrorCode.WRONG_PASSWORD, ErrorCode.NOT_A_VAULT}


def test_inconsistent_snapshot_is_never_written(vault_path: Path) -> None:
    snap = make_snapshot()
    broken = Snapshot(manifest=snap.manifest, blobs=(b"x",) * len(snap.blobs))
    with pytest.raises(VaultError) as exc:
        store.save(vault_path, PASSWORD, broken, None)
    assert exc.value.code is ErrorCode.VERIFY_FAILED
    assert not vault_path.exists()


def test_hardening_pragmas_are_applied(vault_path: Path) -> None:
    store.save(vault_path, PASSWORD, make_snapshot(), None)
    with store._open(vault_path, PASSWORD, readonly=True) as conn:
        assert conn.execute("PRAGMA cipher_memory_security").fetchone()[0] == "1"
        assert conn.execute("PRAGMA temp_store").fetchone()[0] == 2
        assert conn.execute("PRAGMA cipher_log_level").fetchone()[0] == "NONE"


@pytest.mark.parametrize("position", [0.3, 0.5, 0.8])
def test_tampered_page_is_detected_by_fast_open(vault_path: Path, position: float) -> None:
    store.save(vault_path, PASSWORD, make_snapshot(n_docs=3), None)
    raw = bytearray(vault_path.read_bytes())
    raw[int(len(raw) * position)] ^= 0xFF
    vault_path.write_bytes(bytes(raw))
    with pytest.raises(VaultError):
        store.load_raw(vault_path, PASSWORD)
