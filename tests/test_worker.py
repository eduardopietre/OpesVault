import io
import os
from pathlib import Path

import pytest

from opesvault.vault import sqlcipher_store as store
from opesvault.vault.client import VaultClient
from opesvault.vault.errors import ErrorCode, VaultError
from opesvault.vault.framing import read_message, write_message
from opesvault.vault.model import Document, Snapshot
from opesvault.vault.protocol import OpenRequest, SaveRequest, WorkerRequest, WorkerResponse
from opesvault.vault.worker import Purpose, handle, serve

from .conftest import PASSWORD, dev_worker_command
from .test_store import make_snapshot


class ScriptedProvider:
    def __init__(self, answers: list[str | None]) -> None:
        self.answers = list(answers)
        self.calls: list[tuple[Purpose, ErrorCode | None]] = []

    def ask(self, purpose: Purpose, previous_error: ErrorCode | None) -> str | None:
        self.calls.append((purpose, previous_error))
        return self.answers.pop(0)


def test_cancel_writes_nothing(vault_path: Path) -> None:
    snap = make_snapshot()
    request = SaveRequest(path=vault_path, base_revision_id=None, manifest=snap.manifest)
    response, _ = handle(request, snap.blobs, ScriptedProvider([None]))
    assert response.error is ErrorCode.CANCELLED
    assert not vault_path.exists()


def test_wrong_password_is_retried_then_succeeds(vault_path: Path) -> None:
    snap = make_snapshot()
    store.save(vault_path, PASSWORD, snap, None)
    provider = ScriptedProvider(["errada", PASSWORD])
    response, blobs = handle(OpenRequest(path=vault_path), (), provider)
    assert response.error is None and response.manifest == snap.manifest
    assert blobs == snap.blobs
    assert provider.calls == [("open", None), ("open", ErrorCode.WRONG_PASSWORD)]


def test_attempts_are_limited(vault_path: Path) -> None:
    store.save(vault_path, PASSWORD, make_snapshot(), None)
    response, _ = handle(OpenRequest(path=vault_path), (), ScriptedProvider(["a", "b", "c"]))
    assert response.error is ErrorCode.WRONG_PASSWORD


def test_purpose_distinguishes_create_and_save(vault_path: Path) -> None:
    snap = make_snapshot()
    provider = ScriptedProvider([PASSWORD, PASSWORD])
    created, _ = handle(
        SaveRequest(path=vault_path, base_revision_id=None, manifest=snap.manifest), snap.blobs, provider
    )
    assert created.revision is not None
    handle(
        SaveRequest(path=vault_path, base_revision_id=created.revision.revision_id, manifest=snap.manifest),
        snap.blobs,
        provider,
    )
    assert [c[0] for c in provider.calls] == ["create", "save"]


def test_blobs_not_matching_manifest_are_rejected(vault_path: Path) -> None:
    snap = make_snapshot()
    request = SaveRequest(path=vault_path, base_revision_id=None, manifest=snap.manifest)
    response, _ = handle(request, (b"forged",) * len(snap.blobs), ScriptedProvider([PASSWORD]))
    assert response.error is ErrorCode.PROTOCOL_ERROR
    assert not vault_path.exists()


def test_serve_answers_garbage_with_protocol_error() -> None:
    out = io.BytesIO()
    serve(io.BytesIO(b"not a message"), out, ScriptedProvider([]))
    response, _ = read_message(io.BytesIO(out.getvalue()), WorkerResponse)
    assert response.error is ErrorCode.PROTOCOL_ERROR


def test_serve_roundtrip_in_memory(vault_path: Path) -> None:
    snap = make_snapshot()
    request = io.BytesIO()
    write_message(
        request,
        WorkerRequest(request=SaveRequest(path=vault_path, base_revision_id=None, manifest=snap.manifest)),
        snap.blobs,
    )
    request.seek(0)
    out = io.BytesIO()
    assert serve(request, out, ScriptedProvider([PASSWORD])) == 0
    response, _ = read_message(io.BytesIO(out.getvalue()), WorkerResponse)
    assert response.revision is not None and response.revision.revision == 1


@pytest.mark.usefixtures("dev_worker_env")
def test_client_through_real_subprocess(vault_path: Path) -> None:
    """Exercises spawn, pipes, framing and exit with several MiB of documents."""
    big = Document.from_bytes("grande.pdf", os.urandom(8 * 1024 * 1024))
    snap = Snapshot.build(make_snapshot().manifest.vault_id, (), (big,))
    client = VaultClient(dev_worker_command())

    created = client.save(vault_path, snap, None)
    saved = client.save(vault_path, snap, created.revision_id)
    info, loaded = client.open(vault_path)

    assert info == saved and info.revision == 2
    assert loaded.blobs == snap.blobs


def test_client_reports_wrong_password(vault_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    store.save(vault_path, PASSWORD, make_snapshot(), None)
    monkeypatch.setenv("OPV_DEV_PASSWORD", "outra")
    with pytest.raises(VaultError) as exc:
        VaultClient(dev_worker_command()).open(vault_path)
    assert exc.value.code is ErrorCode.WRONG_PASSWORD


def test_dead_worker_on_open_is_internal_error(vault_path: Path) -> None:
    import sys

    client = VaultClient([sys.executable, "-c", "import sys; sys.exit(3)"])
    with pytest.raises(VaultError) as exc:
        client.open(vault_path)
    assert exc.value.code is ErrorCode.INTERNAL
