"""Incremental save (docs/11 §5 decision): same result and guarantees as a full rewrite."""

from datetime import date
from pathlib import Path

import pytest

from opesvault.domain.model import AccountSubtype, AccountType, LedgerAccount
from opesvault.session import Session
from opesvault.vault import sqlcipher_store as store
from opesvault.vault.client import VaultClient
from opesvault.vault.errors import ErrorCode, VaultError

from .conftest import PASSWORD, dev_worker_command
from .test_store import MARKER


def _saved_session(path: Path) -> Session:
    session = Session.new(path, "Delta")
    bank = session.ledger.add_account(
        LedgerAccount(name="Banco", type=AccountType.ASSET, subtype=AccountSubtype.CHECKING)
    )
    session.ledger.record_opening_balance(bank.id, "100.00", date(2026, 1, 1))
    session.add_document("a.pdf", b"%PDF-1.4 primeiro")
    session.add_document("b.pdf", b"%PDF-1.4 segundo")
    frozen = session.freeze()
    assert frozen.snapshot is not None  # first save is always full
    session.mark_saved(frozen, store.save(path, PASSWORD, frozen.snapshot, None))
    _, snapshot = store.load(path, PASSWORD)
    assert session.revision is not None
    return Session.from_snapshot(path, session.revision, snapshot)


def _edit(session: Session) -> None:
    ledger = session.ledger
    bank = next(a.id for a in ledger.accounts.values() if a.name == "Banco")
    category = ledger.categories(AccountType.EXPENSE)[0].id
    op = ledger.record_expense(bank, category, "10.00", date(2026, 1, 2), f"{MARKER} padaria")
    ledger.update_operation(op.model_copy(update={"description": "padaria corrigida"}), "descrição")
    ledger.add_member("Novo integrante")
    session.add_document("c.pdf", b"%PDF-1.4 terceiro")
    session.remove_document(next(d.meta.id for d in session.documents if d.meta.original_name == "a.pdf"))


def test_delta_result_equals_full_state(vault_path: Path) -> None:
    session = _saved_session(vault_path)
    _edit(session)
    frozen = session.freeze()
    assert frozen.delta is not None and frozen.snapshot is None
    assert len(frozen.delta.upserts) < 15  # only what changed travels
    assert session.revision is not None
    info = store.save_delta(vault_path, PASSWORD, frozen.delta, frozen.delta_blobs, session.revision.revision_id)
    session.mark_saved(frozen, info)
    assert not session.dirty and session.ledger.dirty == {}
    _, loaded = store.load(vault_path, PASSWORD)
    expected = session.full_snapshot()
    assert sorted(r.model_dump_json() for r in loaded.manifest.records) == sorted(
        r.model_dump_json() for r in expected.manifest.records
    )
    assert sorted(loaded.blobs) == sorted(expected.blobs)
    assert MARKER.encode() not in vault_path.read_bytes()
    assert b"primeiro" not in vault_path.read_bytes()  # removed document's pages were vacuumed


def test_wrong_counts_fail_verification(vault_path: Path) -> None:
    session = _saved_session(vault_path)
    _edit(session)
    frozen = session.freeze()
    assert frozen.delta is not None and session.revision is not None
    broken = frozen.delta.model_copy(update={"record_count": frozen.delta.record_count + 1})
    before = vault_path.read_bytes()
    with pytest.raises(VaultError) as exc:
        store.save_delta(vault_path, PASSWORD, broken, frozen.delta_blobs, session.revision.revision_id)
    assert exc.value.code is ErrorCode.VERIFY_FAILED
    assert vault_path.read_bytes() == before
    assert sorted(p.name for p in vault_path.parent.iterdir()) == [vault_path.name]


def test_forged_document_bytes_are_refused(vault_path: Path) -> None:
    session = _saved_session(vault_path)
    _edit(session)
    frozen = session.freeze()
    assert frozen.delta is not None and session.revision is not None
    with pytest.raises(VaultError):
        store.save_delta(vault_path, PASSWORD, frozen.delta, (b"outro",), session.revision.revision_id)


def test_stale_base_is_refused(vault_path: Path) -> None:
    session = _saved_session(vault_path)
    assert session.revision is not None
    stale = session.revision.revision_id
    session.ledger.add_member("X")
    frozen = session.freeze()
    assert frozen.delta is not None
    store.save_delta(vault_path, PASSWORD, frozen.delta, frozen.delta_blobs, stale)
    with pytest.raises(VaultError) as exc:
        store.save_delta(vault_path, PASSWORD, frozen.delta, frozen.delta_blobs, stale)
    assert exc.value.code is ErrorCode.REVISION_MISMATCH


def test_edits_during_incremental_save_stay_pending(vault_path: Path) -> None:
    session = _saved_session(vault_path)
    session.ledger.add_member("Antes")
    frozen = session.freeze()
    session.ledger.add_member("Durante")
    assert frozen.delta is not None and session.revision is not None
    session.mark_saved(frozen, store.save_delta(vault_path, PASSWORD, frozen.delta, (), session.revision.revision_id))
    assert session.dirty
    pending = {kind for kind, _ in session.ledger.dirty}
    assert "member" in pending
    second = session.freeze()
    assert second.delta is not None
    assert [r.payload["name"] for r in second.delta.upserts if r.kind == "member"] == ["Durante"]


@pytest.mark.parametrize(
    ("stage", "expected_revision"), [("candidate_written", 1), ("candidate_verified", 1), ("replaced", 2)]
)
def test_killed_incremental_save_keeps_a_valid_vault(
    vault_path: Path, monkeypatch: pytest.MonkeyPatch, stage: str, expected_revision: int
) -> None:
    session = _saved_session(vault_path)
    _edit(session)
    frozen = session.freeze()
    monkeypatch.setenv("OPV_DEV_PASSWORD", PASSWORD)
    monkeypatch.setenv("OPV_DEV_FAULT_STAGE", stage)
    with pytest.raises(VaultError) as exc:
        VaultClient(dev_worker_command()).save_frozen(frozen)
    assert exc.value.code is ErrorCode.UNCERTAIN
    info, _ = store.load(vault_path, PASSWORD)
    assert info.revision == expected_revision


def test_migrated_or_forced_sessions_save_in_full(vault_path: Path) -> None:
    session = _saved_session(vault_path)
    session.force_full_save = True
    assert session.freeze().snapshot is not None


def test_fast_open_equals_typed_open_and_history_is_lazy(vault_path: Path) -> None:
    session = _saved_session(vault_path)
    _edit(session)
    frozen = session.freeze()
    assert frozen.delta is not None and session.revision is not None
    session.mark_saved(
        frozen, store.save_delta(vault_path, PASSWORD, frozen.delta, frozen.delta_blobs, session.revision.revision_id)
    )
    opened = store.load_raw(vault_path, PASSWORD)
    fast = Session.from_opened(vault_path, opened)
    _, snapshot = store.load(vault_path, PASSWORD)
    typed = Session.from_snapshot(vault_path, opened.revision, snapshot)
    assert fast.ledger.operations == typed.ledger.operations
    assert len(fast.ledger.history) == len(typed.ledger.history)
    assert list.__len__(fast.ledger.history) == 0  # nothing parsed yet
    fast.ledger.add_member("Depois de abrir")
    frozen2 = fast.freeze()
    assert frozen2.delta is not None
    assert list.__len__(fast.ledger.history) == 1  # saving new history did not parse the old one
    assert sorted(h.id for h in fast.ledger.history)[:1]  # reading parses on demand
    assert len(fast.ledger.history) == len(typed.ledger.history) + 1
