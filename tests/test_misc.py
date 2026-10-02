import io
import sys
import tempfile
from pathlib import Path

import pytest

from opesvault.devtools.synthetic_pdf import make_pdf
from opesvault.session import Session
from opesvault.vault import sqlcipher_store as store
from opesvault.vault.errors import ErrorCode, VaultError
from opesvault.vault.framing import MAX_HEADER_BYTES, read_message, write_message
from opesvault.vault.lock import VaultLock
from opesvault.vault.model import RevisionInfo, utc_now
from opesvault.vault.protocol import WorkerResponse

from .conftest import PASSWORD

# ── framing ──────────────────────────────────────────


def test_framing_roundtrip_with_blobs() -> None:
    buf = io.BytesIO()
    write_message(buf, WorkerResponse(error=ErrorCode.CANCELLED), (b"", b"\x00" * 10, b"abc"))
    buf.seek(0)
    header, blobs = read_message(buf, WorkerResponse)
    assert header.error is ErrorCode.CANCELLED
    assert blobs == (b"", b"\x00" * 10, b"abc")


@pytest.mark.parametrize(
    "payload",
    [b"", b"XXXX", b"OPV1" + (MAX_HEADER_BYTES + 1).to_bytes(4, "little"), b"OPV1\x05\x00\x00\x00{bad}"],
)
def test_framing_rejects_malformed(payload: bytes) -> None:
    with pytest.raises(VaultError) as exc:
        read_message(io.BytesIO(payload), WorkerResponse)
    assert exc.value.code is ErrorCode.PROTOCOL_ERROR


def test_framing_rejects_truncated_blob() -> None:
    buf = io.BytesIO()
    write_message(buf, WorkerResponse(), (b"0123456789",))
    with pytest.raises(VaultError):
        read_message(io.BytesIO(buf.getvalue()[:-3]), WorkerResponse)


def test_framing_rejects_unknown_fields() -> None:
    raw = b'{"error":null,"password":"x"}'
    msg = b"OPV1" + len(raw).to_bytes(4, "little") + raw + (0).to_bytes(4, "little")
    with pytest.raises(VaultError):
        read_message(io.BytesIO(msg), WorkerResponse)


# ── lock ─────────────────────────────────────────────


def test_second_editor_is_locked_out(vault_path: Path) -> None:
    """TA-08 (same machine)."""
    first = VaultLock(vault_path)
    first.acquire()
    with pytest.raises(VaultError) as exc:
        VaultLock(vault_path).acquire()
    assert exc.value.code is ErrorCode.LOCKED
    first.release()
    with VaultLock(vault_path) as again:
        assert again.held


def test_lock_survives_vault_replacement(vault_path: Path) -> None:
    snap_session = Session.new(vault_path)
    frozen = snap_session.freeze()
    with VaultLock(vault_path):
        info = store.save(vault_path, PASSWORD, frozen.snapshot, None)
        store.save(vault_path, PASSWORD, frozen.snapshot, info.revision_id)
        with pytest.raises(VaultError):
            VaultLock(vault_path).acquire()


# ── session ──────────────────────────────────────────


def _revision(session: Session, n: int) -> RevisionInfo:
    from uuid import uuid4

    return RevisionInfo(
        vault_id=session.vault_id, format_version=1, revision=n, revision_id=uuid4(), saved_at=utc_now()
    )


def test_new_session_is_dirty_until_saved(vault_path: Path) -> None:
    session = Session.new(vault_path)
    assert session.dirty
    frozen = session.freeze()
    session.mark_saved(frozen, _revision(session, 1))
    assert not session.dirty


def test_edits_during_save_stay_unsaved(vault_path: Path) -> None:
    """docs/03 §5: never mark as saved an edit that was not in the snapshot."""
    session = Session.new(vault_path)
    frozen = session.freeze()
    session.add_record("tx", {"amount": "1.00"})
    session.mark_saved(frozen, _revision(session, 1))
    assert session.dirty
    assert len(frozen.snapshot.manifest.records) == 0


def test_freeze_carries_base_revision(vault_path: Path) -> None:
    session = Session.new(vault_path)
    assert session.freeze().base_revision_id is None
    rev = _revision(session, 1)
    session.mark_saved(session.freeze(), rev)
    assert session.freeze().base_revision_id == rev.revision_id


# ── PDF ──────────────────────────────────────────────


def test_pdf_render_and_extract_in_memory_without_temp_files() -> None:
    import pdfplumber

    from opesvault.pdf_render import page_count, render_page

    root = Path(tempfile.gettempdir())
    before = set(root.iterdir())
    pdf = make_pdf(["Linha sintetica 1", "R$ 1.234,56"])
    assert page_count(pdf) == 1
    image = render_page(pdf)
    assert not image.isNull() and image.width() > 0
    with pdfplumber.open(io.BytesIO(pdf)) as doc:
        assert "R$ 1.234,56" in (doc.pages[0].extract_text() or "")
    assert set(root.iterdir()) - before == set()


@pytest.mark.windows
def test_selftest_passes_on_windows() -> None:
    from opesvault.selftest import run_selftest

    results = run_selftest()
    assert results["all_ok"], results
    assert sys.platform == "win32"
