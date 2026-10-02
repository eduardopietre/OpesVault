"""SQLCipher persistence of snapshots. Runs only inside the transient vault worker.

Connections live only for the duration of one call. Writes always go to a new
encrypted candidate next to the vault, which is verified before it atomically
replaces the previous version (docs/03 §4).
"""

import contextlib
import hashlib
import json
import os
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from pathlib import Path
from uuid import UUID, uuid4

from sqlcipher3 import dbapi2 as sqlcipher

from opesvault.vault.atomic import replace_durably
from opesvault.vault.errors import ErrorCode, VaultError
from opesvault.vault.model import (
    FORMAT_VERSION,
    DocumentMeta,
    Record,
    RevisionInfo,
    Snapshot,
    SnapshotManifest,
    utc_now,
)

PLAIN_SQLITE_HEADER = b"SQLite format 3\x00"
CANDIDATE_INFIX = ".candidate-"

# Test-only seam to simulate a crash between save stages; never set by the worker protocol.
FaultHook = Callable[[str], None]

_SCHEMA = (
    "CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT",
    "CREATE TABLE records (id TEXT PRIMARY KEY, kind TEXT NOT NULL, payload TEXT NOT NULL) STRICT",
    "CREATE TABLE documents (id TEXT PRIMARY KEY, sha256 TEXT NOT NULL, original_name TEXT NOT NULL,"
    " size INTEGER NOT NULL, data BLOB NOT NULL) STRICT",
)


def _key_pragma(password: str) -> str:
    if not password or "\x00" in password:
        raise VaultError(ErrorCode.WRONG_PASSWORD)
    # The passphrase goes through SQLCipher's own KDF; only quote-escaping is needed.
    return "PRAGMA key = '" + password.replace("'", "''") + "'"


def _harden(conn: sqlcipher.Connection) -> None:
    # SQLCipher writes decrypt failures to stderr by default.
    conn.execute("PRAGMA cipher_log_level = NONE")
    # Off by default since SQLCipher 4.5: zeroes memory that SQLCipher frees.
    conn.execute("PRAGMA cipher_memory_security = ON")


def _apply_session_pragmas(conn: sqlcipher.Connection) -> None:
    conn.execute("PRAGMA temp_store = MEMORY")
    conn.execute("PRAGMA trusted_schema = OFF")


def _is_plain_sqlite(path: Path) -> bool:
    with path.open("rb") as fh:
        return fh.read(len(PLAIN_SQLITE_HEADER)) == PLAIN_SQLITE_HEADER


@contextmanager
def _open(path: Path, password: str, *, readonly: bool) -> Iterator[sqlcipher.Connection]:
    if readonly:
        conn = sqlcipher.connect(f"{path.resolve().as_uri()}?mode=ro", uri=True, isolation_level=None)
    else:
        conn = sqlcipher.connect(str(path), isolation_level=None)
    try:
        _harden(conn)
        conn.execute(_key_pragma(password))
        _apply_session_pragmas(conn)
        if readonly:
            try:
                # The key is only checked when a page is actually decrypted.
                conn.execute("SELECT count(*) FROM sqlite_master").fetchone()
            except sqlcipher.DatabaseError:
                if _is_plain_sqlite(path):
                    raise VaultError(ErrorCode.NOT_A_VAULT) from None
                raise VaultError(ErrorCode.WRONG_PASSWORD) from None
        yield conn
    finally:
        conn.close()


def _read_revision(conn: sqlcipher.Connection) -> RevisionInfo:
    try:
        meta = dict(conn.execute("SELECT key, value FROM meta").fetchall())
    except sqlcipher.DatabaseError:
        raise VaultError(ErrorCode.NOT_A_VAULT) from None
    try:
        info = RevisionInfo(
            vault_id=UUID(meta["vault_id"]),
            format_version=int(meta["format_version"]),
            revision=int(meta["revision"]),
            revision_id=UUID(meta["revision_id"]),
            saved_at=meta["saved_at"],
        )
    except (KeyError, ValueError):
        raise VaultError(ErrorCode.NOT_A_VAULT) from None
    if info.format_version > FORMAT_VERSION:
        raise VaultError(ErrorCode.INCOMPATIBLE_FORMAT)
    return info


def read_revision(path: Path, password: str) -> RevisionInfo:
    if not path.is_file():
        raise VaultError(ErrorCode.NOT_FOUND)
    with _open(path, password, readonly=True) as conn:
        return _read_revision(conn)


def _read_records(conn: sqlcipher.Connection) -> tuple[Record, ...]:
    return tuple(
        Record(id=UUID(rid), kind=kind, payload=json.loads(payload))
        for rid, kind, payload in conn.execute("SELECT id, kind, payload FROM records ORDER BY rowid")
    )


def _load_from(conn: sqlcipher.Connection) -> tuple[RevisionInfo, Snapshot]:
    info = _read_revision(conn)
    if conn.execute("PRAGMA cipher_integrity_check").fetchall():
        raise VaultError(ErrorCode.VERIFY_FAILED)
    metas: list[DocumentMeta] = []
    blobs: list[bytes] = []
    for did, sha, name, size, data in conn.execute(
        "SELECT id, sha256, original_name, size, data FROM documents ORDER BY rowid"
    ):
        metas.append(DocumentMeta(id=UUID(did), sha256=sha, original_name=name, size=size))
        blobs.append(bytes(data))
    snapshot = Snapshot(
        manifest=SnapshotManifest(vault_id=info.vault_id, records=_read_records(conn), documents=tuple(metas)),
        blobs=tuple(blobs),
    )
    if not snapshot.check_consistency():
        raise VaultError(ErrorCode.VERIFY_FAILED)
    return info, snapshot


def load(path: Path, password: str) -> tuple[RevisionInfo, Snapshot]:
    if not path.is_file():
        raise VaultError(ErrorCode.NOT_FOUND)
    with _open(path, password, readonly=True) as conn:
        return _load_from(conn)


def _write_candidate(candidate: Path, password: str, snapshot: Snapshot, info: RevisionInfo) -> None:
    with _open(candidate, password, readonly=False) as conn:
        # Rollback journal stays in memory: a crash only loses the candidate, never the vault.
        conn.execute("PRAGMA journal_mode = MEMORY")
        conn.execute("BEGIN")
        for stmt in _SCHEMA:
            conn.execute(stmt)
        conn.executemany(
            "INSERT INTO meta (key, value) VALUES (?, ?)",
            [
                ("vault_id", str(info.vault_id)),
                ("format_version", str(info.format_version)),
                ("revision", str(info.revision)),
                ("revision_id", str(info.revision_id)),
                ("saved_at", info.saved_at.isoformat()),
            ],
        )
        conn.executemany(
            "INSERT INTO records (id, kind, payload) VALUES (?, ?, ?)",
            [(str(r.id), r.kind, json.dumps(r.payload, separators=(",", ":"))) for r in snapshot.manifest.records],
        )
        conn.executemany(
            "INSERT INTO documents (id, sha256, original_name, size, data) VALUES (?, ?, ?, ?, ?)",
            [
                (str(m.id), m.sha256, m.original_name, m.size, blob)
                for m, blob in zip(snapshot.manifest.documents, snapshot.blobs, strict=True)
            ],
        )
        conn.execute("COMMIT")


def _verify_candidate(candidate: Path, password: str, snapshot: Snapshot, info: RevisionInfo) -> None:
    """Re-read the candidate from disk without holding a second copy of every document."""
    if _is_plain_sqlite(candidate):
        raise VaultError(ErrorCode.VERIFY_FAILED)
    try:
        with _open(candidate, password, readonly=True) as conn:
            conn.create_function("opv_sha256", 1, lambda b: hashlib.sha256(b).hexdigest(), deterministic=True)
            if _read_revision(conn) != info:
                raise VaultError(ErrorCode.VERIFY_FAILED)
            if conn.execute("PRAGMA cipher_integrity_check").fetchall():
                raise VaultError(ErrorCode.VERIFY_FAILED)
            if conn.execute("PRAGMA integrity_check").fetchone() != ("ok",):
                raise VaultError(ErrorCode.VERIFY_FAILED)
            if _read_records(conn) != snapshot.manifest.records:
                raise VaultError(ErrorCode.VERIFY_FAILED)
            stored = conn.execute(
                "SELECT id, sha256, original_name, size, opv_sha256(data), length(data) FROM documents ORDER BY rowid"
            ).fetchall()
    except (VaultError, sqlcipher.Error):
        raise VaultError(ErrorCode.VERIFY_FAILED) from None
    expected = [(str(m.id), m.sha256, m.original_name, m.size, m.sha256, m.size) for m in snapshot.manifest.documents]
    if stored != expected:
        raise VaultError(ErrorCode.VERIFY_FAILED)


def _stat_token(path: Path) -> tuple[int, int]:
    st = path.stat()
    return st.st_mtime_ns, st.st_size


def save(
    path: Path,
    password: str,
    snapshot: Snapshot,
    base_revision_id: UUID | None,
    fault_hook: FaultHook | None = None,
) -> RevisionInfo:
    """Write `snapshot` as a new revision. `base_revision_id=None` creates a new vault."""
    hook = fault_hook or (lambda _stage: None)
    if not snapshot.check_consistency():
        raise VaultError(ErrorCode.VERIFY_FAILED)

    if base_revision_id is None:
        if path.exists():
            raise VaultError(ErrorCode.ALREADY_EXISTS)
        revision, before = 1, None
    else:
        if not path.is_file():
            raise VaultError(ErrorCode.NOT_FOUND)
        before = _stat_token(path)
        # Authenticates the password against the saved version before anything is written.
        current = read_revision(path, password)
        if current.revision_id != base_revision_id or current.vault_id != snapshot.manifest.vault_id:
            raise VaultError(ErrorCode.REVISION_MISMATCH)
        revision = current.revision + 1

    info = RevisionInfo(
        vault_id=snapshot.manifest.vault_id,
        format_version=FORMAT_VERSION,
        revision=revision,
        revision_id=uuid4(),
        saved_at=utc_now(),
    )
    candidate = path.with_name(f"{path.name}{CANDIDATE_INFIX}{info.revision_id.hex}")
    replaced = False
    try:
        _write_candidate(candidate, password, snapshot, info)
        hook("candidate_written")
        _verify_candidate(candidate, password, snapshot, info)
        hook("candidate_verified")
        # Detects the vault being swapped by someone else while we were writing.
        if before is not None and (not path.is_file() or _stat_token(path) != before):
            raise VaultError(ErrorCode.REVISION_MISMATCH)
        if before is None and path.exists():
            raise VaultError(ErrorCode.ALREADY_EXISTS)
        try:
            replace_durably(candidate, path)
        except OSError:
            raise VaultError(ErrorCode.REPLACE_FAILED) from None
        replaced = True
        hook("replaced")
    except sqlcipher.Error:
        raise VaultError(ErrorCode.IO_ERROR) from None
    finally:
        if not replaced:
            with contextlib.suppress(FileNotFoundError):
                os.remove(candidate)
    return info
