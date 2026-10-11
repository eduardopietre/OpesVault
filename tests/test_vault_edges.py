"""Edge cases of the vault: refusals, verification failures, the worker protocol and file hygiene.

Every failure must end in an error code, leave the previous vault intact and leave no
candidate or partial file behind (docs/03 §4).
"""

import io
import json
import os
import sqlite3
import struct
import sys
from pathlib import Path
from uuid import uuid4

import pytest
from sqlcipher3 import dbapi2 as sqlcipher

from opesvault.vault import atomic, backup, framing
from opesvault.vault import client as client_module
from opesvault.vault import sqlcipher_store as store
from opesvault.vault.client import VaultClient
from opesvault.vault.errors import ErrorCode, VaultError
from opesvault.vault.lock import VaultLock, lock_path_for
from opesvault.vault.model import Document, Record, RevisionInfo, Snapshot, SnapshotDelta
from opesvault.vault.protocol import (
    ChangePasswordRequest,
    OpenRequest,
    SaveDeltaRequest,
    UnlockRequest,
    WorkerRequest,
    WorkerResponse,
)
from opesvault.vault.worker import Purpose, handle, serve

from .conftest import PASSWORD
from .test_store import MARKER, make_snapshot

NEW_PASSWORD = "nova senha ç'\"%"


class ScriptedProvider:
    def __init__(self, answers: list[str | None]) -> None:
        self.answers = list(answers)
        self.calls: list[tuple[Purpose, ErrorCode | None]] = []

    def ask(self, purpose: Purpose, previous_error: ErrorCode | None) -> str | None:
        self.calls.append((purpose, previous_error))
        return self.answers.pop(0)


def _only_vault_left(vault: Path) -> None:
    assert sorted(p.name for p in vault.parent.iterdir()) == [vault.name]


def _code(exc: pytest.ExceptionInfo[VaultError]) -> ErrorCode:
    return exc.value.code


def _sql(vault: Path, *statements: str) -> None:
    """Changes the encrypted vault behind the store's back (simulates tampering with the key)."""
    conn = sqlcipher.connect(str(vault))
    try:
        conn.execute(store._key_pragma(PASSWORD))
        for statement in statements:
            conn.execute(statement)
        conn.commit()
    finally:
        conn.close()


# ── password change in the worker ────────────────────


def test_change_password_reencrypts_the_saved_revision(vault_path: Path) -> None:
    snap = make_snapshot()
    info = store.save(vault_path, PASSWORD, snap, None)
    provider = ScriptedProvider(["errada", PASSWORD, NEW_PASSWORD])
    response, blobs = handle(ChangePasswordRequest(path=vault_path, base_revision_id=info.revision_id), (), provider)
    assert response.error is None and blobs == ()
    assert response.revision is not None and response.revision.revision == 2
    assert provider.calls == [
        ("change_current", None),
        ("change_current", ErrorCode.WRONG_PASSWORD),
        ("change_new", None),
    ]
    with pytest.raises(VaultError) as exc:
        store.load(vault_path, PASSWORD)
    assert _code(exc) is ErrorCode.WRONG_PASSWORD  # the old password no longer opens it
    _, loaded = store.load(vault_path, NEW_PASSWORD)
    assert loaded.manifest == snap.manifest and loaded.blobs == snap.blobs
    _only_vault_left(vault_path)


@pytest.mark.parametrize(
    ("answers", "expected"),
    [
        ([None], ErrorCode.CANCELLED),
        ([PASSWORD, None], ErrorCode.CANCELLED),
        ([PASSWORD, ""], ErrorCode.CANCELLED),  # an empty new password never means "keep the old one"
        (["a", "b", "c"], ErrorCode.WRONG_PASSWORD),
        ([PASSWORD, "com\x00nulo"], ErrorCode.WRONG_PASSWORD),  # unusable new password
    ],
)
def test_change_password_refusals_keep_the_old_password(
    vault_path: Path, answers: list[str | None], expected: ErrorCode
) -> None:
    info = store.save(vault_path, PASSWORD, make_snapshot(), None)
    before = vault_path.read_bytes()
    request = ChangePasswordRequest(path=vault_path, base_revision_id=info.revision_id)
    response, _ = handle(request, (), ScriptedProvider(answers))
    assert response.error is expected
    assert vault_path.read_bytes() == before
    _only_vault_left(vault_path)


def test_change_password_of_another_revision_or_missing_vault(vault_path: Path) -> None:
    store.save(vault_path, PASSWORD, make_snapshot(), None)
    response, _ = handle(
        ChangePasswordRequest(path=vault_path, base_revision_id=uuid4()), (), ScriptedProvider([PASSWORD])
    )
    assert response.error is ErrorCode.REVISION_MISMATCH
    missing = vault_path.with_name("nao-existe.opesvault")
    response, _ = handle(
        ChangePasswordRequest(path=missing, base_revision_id=uuid4()), (), ScriptedProvider([PASSWORD])
    )
    assert response.error is ErrorCode.NOT_FOUND


# ── other worker requests ────────────────────────────


def test_unlock_errors_other_than_wrong_password_end_at_once(vault_path: Path) -> None:
    provider = ScriptedProvider([PASSWORD])
    response, _ = handle(UnlockRequest(path=vault_path, base_revision_id=uuid4()), (), provider)
    assert response.error is ErrorCode.NOT_FOUND and len(provider.calls) == 1
    info = store.save(vault_path, PASSWORD, make_snapshot(), None)
    response, _ = handle(
        UnlockRequest(path=vault_path, base_revision_id=info.revision_id), (), ScriptedProvider(["a", "b", "c"])
    )
    assert response.error is ErrorCode.WRONG_PASSWORD


def test_open_of_missing_vault_does_not_ask_again(vault_path: Path) -> None:
    provider = ScriptedProvider([PASSWORD])
    response, blobs = handle(OpenRequest(path=vault_path), (), provider)
    assert response.error is ErrorCode.NOT_FOUND and blobs == () and len(provider.calls) == 1


def _delta_adding(info: RevisionInfo, snap: Snapshot, document: Document | None = None) -> SnapshotDelta:
    added = (document.meta,) if document else ()
    return SnapshotDelta(
        vault_id=info.vault_id,
        upserts=(Record(id=uuid4(), kind="tx", payload={"description": "novo"}),),
        documents_added=added,
        record_count=len(snap.manifest.records) + 1,
        document_count=len(snap.manifest.documents) + len(added),
    )


def test_worker_saves_a_delta(vault_path: Path) -> None:
    snap = make_snapshot()
    info = store.save(vault_path, PASSWORD, snap, None)
    extra = Document.from_bytes("novo.pdf", b"%PDF novo")
    request = SaveDeltaRequest(
        path=vault_path, base_revision_id=info.revision_id, delta=_delta_adding(info, snap, extra)
    )
    provider = ScriptedProvider([PASSWORD])
    response, _ = handle(request, (extra.data,), provider)
    assert response.error is None and response.revision is not None and response.revision.revision == 2
    assert provider.calls == [("save", None)]
    _, loaded = store.load(vault_path, PASSWORD)
    assert len(loaded.manifest.records) == 2 and extra.data in loaded.blobs


def test_serve_maps_os_errors_and_crashes_to_codes(
    vault_path: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("OPV_LOG_DIR", str(tmp_path / "logs"))

    class Failing:
        def __init__(self, exc: Exception) -> None:
            self.exc = exc

        def ask(self, purpose: Purpose, previous_error: ErrorCode | None) -> str | None:
            raise self.exc

    def run(provider: object) -> tuple[int, WorkerResponse]:
        request = io.BytesIO()
        framing.write_message(request, WorkerRequest(request=OpenRequest(path=vault_path)))
        request.seek(0)
        out = io.BytesIO()
        status = serve(request, out, provider)  # type: ignore[arg-type]
        response, _ = framing.read_message(io.BytesIO(out.getvalue()), WorkerResponse)
        return status, response

    status, response = run(Failing(OSError("disco cheio em C:\\Users\\Ana\\familia.opesvault")))
    assert status == 1 and response.error is ErrorCode.IO_ERROR
    status, response = run(Failing(RuntimeError(f"segredo {MARKER}")))
    assert status == 1 and response.error is ErrorCode.INTERNAL
    log = (tmp_path / "logs" / "opesvault.log").read_text(encoding="utf-8")
    entry = json.loads(log.splitlines()[-1])
    assert entry["code"] == "WORKER_INTERNAL" and entry["type"] == "RuntimeError"
    assert MARKER not in log and "Ana" not in log  # only codes and code locations


def test_lazy_dialog_provider_loads_the_dialog_once(monkeypatch: pytest.MonkeyPatch) -> None:
    from opesvault.ui import password_dialog
    from opesvault.vault.worker import _LazyDialogProvider

    created: list[object] = []

    class FakeDialog:
        def __init__(self) -> None:
            created.append(self)

        def ask(self, purpose: Purpose, previous_error: ErrorCode | None) -> str | None:
            return f"{purpose}:{previous_error}"

    monkeypatch.setattr(password_dialog, "DialogPasswordProvider", FakeDialog)
    provider = _LazyDialogProvider()
    assert created == []  # Qt is not touched until a password is needed
    assert provider.ask("open", None) == "open:None"
    assert provider.ask("open", ErrorCode.WRONG_PASSWORD) == "open:WRONG_PASSWORD"
    assert len(created) == 1


# ── client side of the protocol ──────────────────────

_FAKE_WORKER = """
import json, os, sys
from opesvault.vault.framing import read_message, write_message
from opesvault.vault.protocol import WorkerRequest, WorkerResponse

read_message(sys.stdin.buffer, WorkerRequest)
response = WorkerResponse.model_validate_json(os.environ["OPV_FAKE_RESPONSE"])
blobs = tuple(bytes.fromhex(b) for b in json.loads(os.environ.get("OPV_FAKE_BLOBS", "[]")))
write_message(sys.stdout.buffer, response, blobs)
"""


@pytest.fixture
def fake_worker(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):  # type: ignore[no-untyped-def]
    """A worker that answers every request with OPV_FAKE_RESPONSE (and OPV_FAKE_BLOBS)."""
    script = tmp_path / "fake_worker.py"
    script.write_text(_FAKE_WORKER, encoding="utf-8")

    def answer(response: WorkerResponse, blobs: tuple[bytes, ...] = ()) -> VaultClient:
        monkeypatch.setenv("OPV_FAKE_RESPONSE", response.model_dump_json())
        monkeypatch.setenv("OPV_FAKE_BLOBS", json.dumps([b.hex() for b in blobs]))
        return VaultClient([sys.executable, str(script)])

    return answer


def _revision(revision_id: object = None) -> RevisionInfo:
    return RevisionInfo(
        vault_id=uuid4(),
        format_version=1,
        revision=1,
        revision_id=revision_id or uuid4(),  # type: ignore[arg-type]
        saved_at="2026-01-01T00:00:00+00:00",  # type: ignore[arg-type]
    )


def test_client_refuses_answers_that_do_not_match_the_request(fake_worker, vault_path: Path) -> None:  # type: ignore[no-untyped-def]
    snap = make_snapshot(n_docs=1)
    empty = fake_worker(WorkerResponse())
    for call in (
        lambda: empty.open_raw(vault_path),
        lambda: empty.save(vault_path, snap, None),
        lambda: empty.change_password(vault_path, uuid4()),
        lambda: empty.save_delta(vault_path, _delta_adding(_revision(), snap), (), uuid4()),
        lambda: empty.unlock(vault_path, uuid4()),
    ):
        with pytest.raises(VaultError) as exc:
            call()
        assert _code(exc) in {ErrorCode.PROTOCOL_ERROR, ErrorCode.UNCERTAIN}

    # A document whose bytes do not have the announced size.
    meta = snap.manifest.documents[0]
    short = fake_worker(WorkerResponse(revision=_revision(), documents=(meta,)), (b"curto", b""))
    with pytest.raises(VaultError) as exc:
        short.open_raw(vault_path)
    assert _code(exc) is ErrorCode.PROTOCOL_ERROR

    # Unlock that answers for another revision.
    other = fake_worker(WorkerResponse(revision=_revision()))
    with pytest.raises(VaultError) as exc:
        other.unlock(vault_path, uuid4())
    assert _code(exc) is ErrorCode.PROTOCOL_ERROR


def test_client_reports_worker_error_codes(fake_worker, vault_path: Path) -> None:  # type: ignore[no-untyped-def]
    locked = fake_worker(WorkerResponse(error=ErrorCode.LOCKED))
    with pytest.raises(VaultError) as exc:
        locked.change_password(vault_path, uuid4())
    assert _code(exc) is ErrorCode.LOCKED
    with pytest.raises(VaultError) as exc:
        locked.unlock(vault_path, uuid4())
    assert _code(exc) is ErrorCode.LOCKED


def test_garbage_answer_to_a_save_is_uncertain_and_a_hung_worker_is_killed(
    vault_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(client_module, "_EXIT_TIMEOUT_S", 0.5)
    # Answers garbage, then hangs instead of exiting: the client must not wait forever.
    code = "import sys, time; sys.stdout.buffer.write(b'XXXX'); sys.stdout.flush(); time.sleep(60)"
    hang = [sys.executable, "-c", code]
    snap = make_snapshot(n_docs=1)
    with pytest.raises(VaultError) as exc:
        VaultClient(hang).save(vault_path, snap, None)
    assert _code(exc) is ErrorCode.UNCERTAIN  # it may have stopped mid-replace


def test_worker_that_dies_before_reading_is_reported(vault_path: Path) -> None:
    big = Document.from_bytes("grande.pdf", os.urandom(4 * 1024 * 1024))  # more than a pipe buffer
    snap = Snapshot.build(uuid4(), (), (big,))
    with pytest.raises(VaultError) as exc:
        VaultClient([sys.executable, "-c", "import sys; sys.exit(0)"]).save(vault_path, snap, None)
    assert _code(exc) is ErrorCode.UNCERTAIN
    assert not vault_path.exists()


def test_compiled_build_relaunches_itself(monkeypatch: pytest.MonkeyPatch) -> None:
    import opesvault

    assert client_module.default_worker_command()[1:] == ["-m", "opesvault", "--vault-worker"]
    monkeypatch.setattr(opesvault, "__compiled__", object(), raising=False)
    monkeypatch.setattr(sys, "argv", ["C:\\OpesVault\\OpesVault.exe"])
    assert client_module.is_compiled()
    assert client_module.default_worker_command() == ["C:\\OpesVault\\OpesVault.exe", "--vault-worker"]


# ── store: refusals and verification ─────────────────


def test_missing_vault_is_not_found_everywhere(vault_path: Path) -> None:
    snap = make_snapshot()
    for call in (
        lambda: store.read_revision(vault_path, PASSWORD),
        lambda: store.load(vault_path, PASSWORD),
        lambda: store.load_raw(vault_path, PASSWORD),
        lambda: store.save(vault_path, PASSWORD, snap, uuid4()),
        lambda: store.save_delta(vault_path, PASSWORD, _delta_adding(_revision(), snap), (), uuid4()),
    ):
        with pytest.raises(VaultError) as exc:
            call()
        assert _code(exc) is ErrorCode.NOT_FOUND
    assert not vault_path.exists()


def test_encrypted_database_without_vault_tables_is_not_a_vault(vault_path: Path) -> None:
    _sql(vault_path, "CREATE TABLE outra (x)")
    with pytest.raises(VaultError) as exc:
        store.read_revision(vault_path, PASSWORD)
    assert _code(exc) is ErrorCode.NOT_A_VAULT
    _sql(
        vault_path,
        "CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
        "INSERT INTO meta VALUES ('x', 'y')",
    )
    with pytest.raises(VaultError) as exc:
        store.read_revision(vault_path, PASSWORD)
    assert _code(exc) is ErrorCode.NOT_A_VAULT


def test_document_bytes_changed_with_the_key_are_detected(vault_path: Path) -> None:
    store.save(vault_path, PASSWORD, make_snapshot(), None)
    _sql(vault_path, "UPDATE documents SET data = X'00' WHERE rowid = 1")
    for loader in (store.load, store.load_raw):
        with pytest.raises(VaultError) as exc:
            loader(vault_path, PASSWORD)
        assert _code(exc) is ErrorCode.VERIFY_FAILED


def test_candidate_verification_rejects_any_difference(vault_path: Path, tmp_path: Path) -> None:
    snap = make_snapshot()
    info = store.save(vault_path, PASSWORD, snap, None)
    other_records = Snapshot.build(snap.manifest.vault_id, (), snap.documents)
    other_documents = Snapshot.build(snap.manifest.vault_id, snap.manifest.records, snap.documents[:1])
    other_info = info.model_copy(update={"revision": 7})
    plain = tmp_path / "plain.db"
    sqlite3.connect(plain).execute("CREATE TABLE t (x)").connection.commit()
    for candidate, password, expected, revision in (
        (vault_path, PASSWORD, other_records, info),
        (vault_path, PASSWORD, other_documents, info),
        (vault_path, PASSWORD, snap, other_info),
        (vault_path, "outra", snap, info),
        (plain, PASSWORD, snap, info),
    ):
        with pytest.raises(VaultError) as exc:
            store._verify_candidate(candidate, password, expected, revision)
        assert _code(exc) is ErrorCode.VERIFY_FAILED
    store._verify_candidate(vault_path, PASSWORD, snap, info)  # the real one passes


def test_delta_verification_rejects_any_difference(vault_path: Path, tmp_path: Path) -> None:
    snap = make_snapshot()
    info = store.save(vault_path, PASSWORD, snap, None)
    record = snap.manifest.records[0]
    document = snap.manifest.documents[0]
    base = SnapshotDelta(vault_id=info.vault_id, record_count=1, document_count=2)
    store._verify_delta(vault_path, PASSWORD, base, info)  # what is there matches
    bad = [
        base.model_copy(update={"record_count": 2}),
        base.model_copy(update={"document_count": 3}),
        base.model_copy(update={"upserts": (record.model_copy(update={"payload": {"x": 1}}),)}),
        base.model_copy(update={"upserts": (Record(id=uuid4(), kind="tx", payload={}),)}),
        base.model_copy(update={"deletes": (record.id,)}),
        base.model_copy(update={"documents_added": (document.model_copy(update={"size": 1}),)}),
        base.model_copy(update={"documents_removed": (document.id,)}),
    ]
    for delta in bad:
        with pytest.raises(VaultError) as exc:
            store._verify_delta(vault_path, PASSWORD, delta, info)
        assert _code(exc) is ErrorCode.VERIFY_FAILED
    with pytest.raises(VaultError):
        store._verify_delta(vault_path, PASSWORD, base, info.model_copy(update={"revision": 9}))
    plain = tmp_path / "plain.db"
    plain.write_bytes(store.PLAIN_SQLITE_HEADER + b"\0" * 100)
    with pytest.raises(VaultError) as exc:
        store._verify_delta(plain, PASSWORD, base, info)
    assert _code(exc) is ErrorCode.VERIFY_FAILED


def test_vault_created_by_someone_else_during_create_is_kept(vault_path: Path) -> None:
    def intruder(stage: str) -> None:
        if stage == "candidate_verified":
            vault_path.write_bytes(b"de outra pessoa")

    with pytest.raises(VaultError) as exc:
        store.save(vault_path, PASSWORD, make_snapshot(), None, fault_hook=intruder)
    assert _code(exc) is ErrorCode.ALREADY_EXISTS
    assert vault_path.read_bytes() == b"de outra pessoa"
    _only_vault_left(vault_path)


@pytest.mark.parametrize("incremental", [False, True])
def test_failed_replace_keeps_the_previous_vault(
    vault_path: Path, monkeypatch: pytest.MonkeyPatch, incremental: bool
) -> None:
    snap = make_snapshot()
    info = store.save(vault_path, PASSWORD, snap, None)
    before = vault_path.read_bytes()

    def refuse(_candidate: Path, _target: Path) -> None:
        raise PermissionError("em uso")

    monkeypatch.setattr(store, "replace_durably", refuse)
    with pytest.raises(VaultError) as exc:
        if incremental:
            store.save_delta(vault_path, PASSWORD, _delta_adding(info, snap), (), info.revision_id)
        else:
            store.save(vault_path, PASSWORD, snap, info.revision_id)
    assert _code(exc) is ErrorCode.REPLACE_FAILED
    assert vault_path.read_bytes() == before
    _only_vault_left(vault_path)


@pytest.mark.parametrize("incremental", [False, True])
def test_sqlcipher_failure_while_writing_is_an_io_error(
    vault_path: Path, monkeypatch: pytest.MonkeyPatch, incremental: bool
) -> None:
    snap = make_snapshot()
    info = store.save(vault_path, PASSWORD, snap, None)

    def broken(*_args: object) -> None:
        raise sqlcipher.OperationalError("disk I/O error")

    monkeypatch.setattr(store, "_apply_delta" if incremental else "_write_candidate", broken)
    with pytest.raises(VaultError) as exc:
        if incremental:
            store.save_delta(vault_path, PASSWORD, _delta_adding(info, snap), (), info.revision_id)
        else:
            store.save(vault_path, PASSWORD, snap, info.revision_id)
    assert _code(exc) is ErrorCode.IO_ERROR
    _only_vault_left(vault_path)


def test_delta_blobs_must_match_their_metadata(vault_path: Path) -> None:
    snap = make_snapshot()
    info = store.save(vault_path, PASSWORD, snap, None)
    before = vault_path.read_bytes()
    extra = Document.from_bytes("novo.pdf", b"%PDF novo")
    delta = _delta_adding(info, snap, extra)
    for blobs in ((), (b"%PDF outro",), (extra.data, extra.data)):
        with pytest.raises(VaultError) as exc:
            store.save_delta(vault_path, PASSWORD, delta, blobs, info.revision_id)
        assert _code(exc) is ErrorCode.PROTOCOL_ERROR
    assert vault_path.read_bytes() == before


def test_delta_detects_the_vault_changing_during_the_save(vault_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    snap = make_snapshot()
    info = store.save(vault_path, PASSWORD, snap, None)
    delta = _delta_adding(info, snap)

    def swap(stage: str) -> None:
        if stage == "candidate_verified":
            vault_path.write_bytes(vault_path.read_bytes() + b"\0")

    with pytest.raises(VaultError) as exc:
        store.save_delta(vault_path, PASSWORD, delta, (), info.revision_id, fault_hook=swap)
    assert _code(exc) is ErrorCode.REVISION_MISMATCH
    _only_vault_left(vault_path)

    info = store.save(vault_path.with_name("b.opesvault"), PASSWORD, snap, None)
    other = vault_path.with_name("b.opesvault")
    real_copy = store.shutil.copyfile

    def copy_then_touch(src: Path, dst: Path) -> object:
        result = real_copy(src, dst)
        Path(src).write_bytes(Path(src).read_bytes() + b"\0")  # someone saved while we copied
        return result

    monkeypatch.setattr(store.shutil, "copyfile", copy_then_touch)
    with pytest.raises(VaultError) as exc:
        store.save_delta(other, PASSWORD, _delta_adding(info, snap), (), info.revision_id)
    assert _code(exc) is ErrorCode.REVISION_MISMATCH
    assert not any(store.CANDIDATE_INFIX in p.name for p in other.parent.iterdir())


# ── atomic replace ───────────────────────────────────


def test_replace_retries_sharing_violations_then_succeeds(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    candidate, target = tmp_path / "c", tmp_path / "t"
    candidate.write_bytes(b"novo")
    target.write_bytes(b"velho")
    real = atomic._replace_once
    failures: list[OSError] = [PermissionError("antivírus"), _sharing_violation()]
    sleeps: list[float] = []

    def flaky(src: Path, dst: Path) -> None:
        if failures:
            raise failures.pop(0)
        real(src, dst)

    monkeypatch.setattr(atomic, "_replace_once", flaky)
    monkeypatch.setattr(atomic.time, "sleep", sleeps.append)
    atomic.replace_durably(candidate, target)
    assert target.read_bytes() == b"novo" and not candidate.exists()
    assert sleeps == [atomic._REPLACE_BACKOFF_S, atomic._REPLACE_BACKOFF_S * 2]  # growing back-off


def _sharing_violation() -> OSError:
    error = OSError("em uso")
    error.winerror = 32  # type: ignore[attr-defined]
    return error


def test_replace_gives_up_after_the_last_attempt(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    candidate, target = tmp_path / "c", tmp_path / "t"
    candidate.write_bytes(b"novo")
    target.write_bytes(b"velho")
    attempts: list[int] = []

    def locked(_src: Path, _dst: Path) -> None:
        attempts.append(1)
        raise _sharing_violation()

    monkeypatch.setattr(atomic, "_replace_once", locked)
    monkeypatch.setattr(atomic.time, "sleep", lambda _s: None)
    with pytest.raises(OSError, match="em uso"):
        atomic.replace_durably(candidate, target)
    assert len(attempts) == atomic._REPLACE_ATTEMPTS and target.read_bytes() == b"velho"


def test_replace_does_not_retry_other_errors(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    candidate = tmp_path / "c"
    candidate.write_bytes(b"novo")
    attempts: list[int] = []

    def missing(_src: Path, _dst: Path) -> None:
        attempts.append(1)
        raise FileNotFoundError("sem pasta")

    monkeypatch.setattr(atomic, "_replace_once", missing)
    with pytest.raises(FileNotFoundError):
        atomic.replace_durably(candidate, tmp_path / "t")
    assert attempts == [1]


# ── backups ──────────────────────────────────────────


def test_backup_refusals(vault_path: Path, tmp_path: Path) -> None:
    dest = tmp_path / "backups"
    with pytest.raises(VaultError) as exc:
        backup.create_backup(vault_path, 1, dest)
    assert _code(exc) is ErrorCode.NOT_FOUND
    sqlite3.connect(vault_path).execute("CREATE TABLE t (x)").connection.commit()
    with pytest.raises(VaultError) as exc:
        backup.create_backup(vault_path, 1, dest)
    assert _code(exc) is ErrorCode.VERIFY_FAILED  # a plain database is never kept as a backup
    assert list(dest.iterdir()) == []
    with pytest.raises(VaultError) as exc:
        backup.prune_backups(dest, "familia", 0, set())
    assert _code(exc) is ErrorCode.PROTOCOL_ERROR
    assert backup.list_backups(tmp_path / "nao-existe") == []


def test_backup_of_a_vault_that_keeps_changing_fails_cleanly(
    vault_path: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    store.save(vault_path, PASSWORD, make_snapshot(), None)
    dest = tmp_path / "backups"
    real_copy = backup.shutil.copyfile

    def copy_while_saving(src: Path, dst: Path) -> object:
        result = real_copy(src, dst)
        Path(src).write_bytes(Path(src).read_bytes() + b"\0")
        return result

    monkeypatch.setattr(backup.shutil, "copyfile", copy_while_saving)
    with pytest.raises(VaultError) as exc:
        backup.create_backup(vault_path, 1, dest)
    assert _code(exc) is ErrorCode.IO_ERROR
    assert list(dest.iterdir()) == []  # no partial copy is left


def test_backup_retries_a_short_copy(vault_path: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    store.save(vault_path, PASSWORD, make_snapshot(), None)
    dest = tmp_path / "backups"
    real_copy = backup.shutil.copyfile
    calls: list[int] = []

    def short_first(src: Path, dst: Path) -> object:
        calls.append(1)
        if len(calls) == 1:
            Path(dst).write_bytes(Path(src).read_bytes()[:-10])
            return dst
        return real_copy(src, dst)

    monkeypatch.setattr(backup.shutil, "copyfile", short_first)
    made = backup.create_backup(vault_path, 1, dest)
    assert len(calls) == 2 and made.read_bytes() == vault_path.read_bytes()
    assert [p.name for p in dest.iterdir()] == [made.name]
    listed = backup.list_backups(dest)
    assert [b.path for b in listed] == [made] and listed[0].revision == 1


# ── lock ─────────────────────────────────────────────


def test_second_editor_is_refused_until_the_lock_is_released(vault_path: Path) -> None:
    first, second = VaultLock(vault_path), VaultLock(vault_path)
    second.release()  # never acquired: harmless
    with first:
        assert first.held and first.path == lock_path_for(vault_path)
        with pytest.raises(VaultError) as exc:
            second.acquire()
        assert _code(exc) is ErrorCode.LOCKED and not second.held
    assert not first.held
    with second:
        assert second.held
    assert lock_path_for(vault_path).read_bytes() == b""  # holds no content


# ── framing limits ───────────────────────────────────


def _frame(header: bytes, *blob_sizes: int, count: int | None = None) -> io.BytesIO:
    data = framing.MAGIC + struct.pack("<I", len(header)) + header
    data += struct.pack("<I", len(blob_sizes) if count is None else count)
    for size in blob_sizes:
        data += struct.pack("<Q", size)
    return io.BytesIO(data)


def test_framing_rejects_oversized_or_forged_messages(monkeypatch: pytest.MonkeyPatch) -> None:
    header = WorkerResponse().model_dump_json().encode()
    with pytest.raises(VaultError):
        framing.read_message(_frame(header, count=framing.MAX_BLOB_COUNT + 1), WorkerResponse)
    with pytest.raises(VaultError):
        framing.read_message(_frame(header, framing.MAX_BLOB_BYTES + 1), WorkerResponse)
    with pytest.raises(VaultError):
        framing.read_message(_frame(b'{"error": "INVENTADO"}'), WorkerResponse)
    with pytest.raises(VaultError):
        framing.read_message(_frame(header, 10), WorkerResponse)  # announced blob never arrives

    monkeypatch.setattr(framing, "MAX_BLOB_BYTES", 4)
    with pytest.raises(VaultError):
        framing.write_message(io.BytesIO(), WorkerResponse(), (b"12345",))
    monkeypatch.setattr(framing, "MAX_HEADER_BYTES", 4)
    with pytest.raises(VaultError):
        framing.write_message(io.BytesIO(), WorkerResponse())
    with pytest.raises(VaultError):
        framing.read_message(_frame(header), WorkerResponse)


def test_store_refuses_an_empty_new_password(vault_path: Path) -> None:
    info = store.save(vault_path, PASSWORD, make_snapshot(), None)
    before = vault_path.read_bytes()
    with pytest.raises(VaultError) as exc:
        store.save(vault_path, PASSWORD, make_snapshot(), info.revision_id, new_password="")
    assert _code(exc) is ErrorCode.CANCELLED and vault_path.read_bytes() == before
    _only_vault_left(vault_path)
