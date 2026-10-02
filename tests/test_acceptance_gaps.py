"""Acceptance scenarios that had only partial coverage (docs/15 traceability)."""

from datetime import date
from pathlib import Path

import psutil
import pytest
from PySide6.QtWidgets import QApplication, QMessageBox, QTableView, QTableWidget

from opesvault.domain.model import AccountSubtype, AccountType, LedgerAccount
from opesvault.exports import interchange_json, ledger_csv
from opesvault.importing import pipeline
from opesvault.importing.pipeline import ImportRequest
from opesvault.session import Session
from opesvault.ui.main_window import MainWindow
from opesvault.vault import sqlcipher_store as store
from opesvault.vault.client import VaultClient
from opesvault.vault.errors import ErrorCode, VaultError
from opesvault.vault.protocol import SaveDeltaRequest
from opesvault.vault.worker import handle

from . import synthetic_docs as docs
from .conftest import PASSWORD, dev_worker_command
from .domain_fixtures import family


def saved_session(path: Path, client: VaultClient) -> Session:
    session = Session.new(path, "Família")
    f = family()
    session.ledger = f.ledger
    f.ledger.record_opening_balance(f.bank, "1000.00", date(2026, 1, 1))
    frozen = session.freeze()
    session.mark_saved(frozen, client.save_frozen(frozen))
    return session


def test_ta02_wrong_password_keeps_file_and_ram(vault_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("OPV_DEV_PASSWORD", PASSWORD)
    client = VaultClient(dev_worker_command())
    session = saved_session(vault_path, client)
    bank = next(a.id for a in session.ledger.accounts.values() if a.name == "Banco A")
    groceries = next(a.id for a in session.ledger.categories(AccountType.EXPENSE))
    op = session.ledger.record_expense(bank, groceries, "50.00", date(2026, 1, 3), "Feira")
    before = vault_path.read_bytes()

    monkeypatch.setenv("OPV_DEV_PASSWORD", "senha errada")
    with pytest.raises(VaultError) as exc:
        client.save_frozen(session.freeze())
    assert exc.value.code is ErrorCode.WRONG_PASSWORD
    assert vault_path.read_bytes() == before
    assert session.dirty and op.id in session.ledger.operations  # nothing lost in RAM

    monkeypatch.setenv("OPV_DEV_PASSWORD", PASSWORD)
    frozen = session.freeze()
    session.mark_saved(frozen, client.save_frozen(frozen))
    _, snapshot = client.open(vault_path)
    assert any(r.id == op.id for r in snapshot.manifest.records)


def test_ta03_cancel_on_existing_vault_writes_nothing(vault_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("OPV_DEV_PASSWORD", PASSWORD)
    session = saved_session(vault_path, VaultClient(dev_worker_command()))
    session.ledger.add_member("Carla")
    frozen = session.freeze()
    assert frozen.delta is not None and frozen.base_revision_id is not None
    before = vault_path.read_bytes()

    class Cancel:
        def ask(self, purpose: object, previous_error: object) -> None:
            return None

    request = SaveDeltaRequest(path=vault_path, base_revision_id=frozen.base_revision_id, delta=frozen.delta)
    response, _ = handle(request, frozen.delta_blobs, Cancel())
    assert response.error is ErrorCode.CANCELLED
    assert vault_path.read_bytes() == before
    assert sorted(p.name for p in vault_path.parent.iterdir()) == [vault_path.name]  # no candidate left


@pytest.mark.usefixtures("dev_worker_env")
def test_ta04_worker_process_is_gone_after_each_operation(vault_path: Path) -> None:
    client = VaultClient(dev_worker_command())
    me = psutil.Process()
    session = saved_session(vault_path, client)
    client.open(vault_path)
    session.ledger.add_member("Carla")
    frozen = session.freeze()
    session.mark_saved(frozen, client.save_frozen(frozen))
    assert [c for c in me.children(recursive=True) if c.is_running() and c.status() != psutil.STATUS_ZOMBIE] == []
    # The client keeps only the command line; no password or key attribute exists to cache.
    assert set(vars(client)) == {"_command"}


@pytest.fixture
def app() -> QApplication:
    instance = QApplication.instance()
    return instance if isinstance(instance, QApplication) else QApplication([])


def _visible_texts(window: MainWindow) -> str:
    texts: list[str] = []
    for page in window.pages:
        window.show_page(window.pages.index(page))
        QApplication.processEvents()
        for table in page.findChildren(QTableWidget):
            items = [table.item(r, c) for r in range(table.rowCount()) for c in range(table.columnCount())]
            texts += [item.text() for item in items if item is not None]
        for view in page.findChildren(QTableView):
            model = view.model()
            if model is None or isinstance(view, QTableWidget):
                continue
            texts += [
                str(model.data(model.index(r, c))) for r in range(model.rowCount()) for c in range(model.columnCount())
            ]
    return "\n".join(texts)


def test_ta31_switching_family_shows_nothing_from_the_previous(app: QApplication, tmp_path: Path) -> None:
    window = MainWindow()
    first = Session.new(tmp_path / "a.opesvault", "Família A")
    f = family()
    first.ledger = f.ledger
    f.ledger.record_expense(f.bank, f.groceries, "77.77", date(2026, 1, 3), "MARCADOR_FAMILIA_A")
    pipeline.import_document(first, ImportRequest("nu.pdf", docs.nubank_card_pdf()))
    window.session = first
    window._refresh()
    assert "MARCADOR_FAMILIA_A" in _visible_texts(window)

    second = Session.new(tmp_path / "b.opesvault", "Família B")
    second.ledger.add_member("Zé")
    window._drop_session()
    window.session = second
    window._refresh()
    texts = _visible_texts(window)
    assert "MARCADOR_FAMILIA_A" not in texts and "77,77" not in texts
    assert "nu.pdf" not in texts and "Família A" not in window.windowTitle()


def test_ta33_migrated_vault_is_backed_up_before_any_write(
    app: QApplication, vault_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("OPV_DEV_PASSWORD", PASSWORD)
    client = VaultClient(dev_worker_command())
    saved_session(vault_path, client)
    original = vault_path.read_bytes()
    session = Session.from_opened(vault_path, client.open_raw(vault_path))
    session.ledger.migrated_from = 0  # as if an older schema had been converted on open
    window = MainWindow()
    window.session = session
    monkeypatch.setattr(QMessageBox, "information", lambda *a, **k: None)
    window._after_open(vault_path)
    backups = list((vault_path.parent / "backups-migracao").iterdir())
    assert len(backups) == 1 and backups[0].read_bytes() == original
    assert session.freeze().snapshot is not None  # the migrated vault is written in full


def test_ta34_export_is_explicit_and_leaves_the_vault_alone(vault_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("OPV_DEV_PASSWORD", PASSWORD)
    session = saved_session(vault_path, VaultClient(dev_worker_command()))
    before = vault_path.read_bytes()
    csv_bytes, json_bytes = ledger_csv(session.ledger), interchange_json(session.ledger)
    assert csv_bytes and json_bytes
    assert vault_path.read_bytes() == before and not session.dirty
    assert store.PLAIN_SQLITE_HEADER not in before


def test_ta35_approved_but_unsaved_work_is_not_masked(
    app: QApplication, vault_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("OPV_DEV_PASSWORD", PASSWORD)
    client = VaultClient(dev_worker_command())
    session = saved_session(vault_path, client)
    card_account = next(a.id for a in session.ledger.accounts.values() if a.subtype is AccountSubtype.CREDIT_CARD)
    batch = pipeline.import_document(session, ImportRequest("nu.pdf", docs.nubank_card_pdf()))
    pipeline.approve(session.ledger, batch.id)
    approved = {
        o.id for o in session.ledger.operations.values() if any(p.account_id == card_account for p in o.postings)
    }
    assert approved and session.dirty

    window = MainWindow()
    window.session = session
    asked: list[str] = []

    def decide(_parent: object, title: str, *_args: object) -> str | None:
        asked.append(title)
        return "cancel"

    monkeypatch.setattr("opesvault.ui.main_window.decide", decide)
    assert not window._confirm_discard()  # closing is not silent
    assert asked

    # "Restart": what is on disk is the last saved revision, without the approval.
    reopened = Session.from_opened(vault_path, client.open_raw(vault_path))
    assert reopened.revision == session.revision
    assert not approved & set(reopened.ledger.operations)
    assert not reopened.documents


def test_ta31_domain_sessions_share_no_state(tmp_path: Path) -> None:
    a, b = Session.new(tmp_path / "a.opesvault", "A"), Session.new(tmp_path / "b.opesvault", "B")
    bank = a.ledger.add_account(LedgerAccount(name="X", type=AccountType.ASSET, subtype=AccountSubtype.CHECKING)).id
    a.ledger.record_opening_balance(bank, "10.00", date(2026, 1, 1))
    a.add_document("n.pdf", docs.nubank_card_pdf())
    assert bank not in b.ledger.accounts and not b.ledger.operations and not b.documents


def test_ta29_ai_enabled_but_failing_does_not_block_review_or_save(
    vault_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import socket

    from opesvault.ai.ollama import AiUnavailable, OllamaClient
    from opesvault.domain.settings import update_settings
    from opesvault.importing.ai_suggestions import suggest_with_ai

    monkeypatch.setenv("OPV_DEV_PASSWORD", PASSWORD)
    client = VaultClient(dev_worker_command())
    session = saved_session(vault_path, client)
    update_settings(session.ledger, ai_enabled=True, ai_model="llama3")
    with socket.socket() as probe:  # a loopback port nobody listens on
        probe.bind(("127.0.0.1", 0))
        dead_port = probe.getsockname()[1]
    batch = pipeline.import_document(session, ImportRequest("nu.pdf", docs.nubank_card_pdf()))
    with pytest.raises(AiUnavailable):
        suggest_with_ai(session.ledger, batch.id, OllamaClient("llama3", f"http://127.0.0.1:{dead_port}"))
    result = pipeline.approve(session.ledger, batch.id)
    assert result.created > 0
    frozen = session.freeze()
    session.mark_saved(frozen, client.save_frozen(frozen))
    assert not session.dirty


def test_ta30_every_page_renders_with_external_network_blocked(
    app: QApplication, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import socket

    attempts: list[str] = []
    original = socket.socket.connect

    def guarded(self: socket.socket, address: object) -> None:
        host = address[0] if isinstance(address, tuple) else str(address)
        if host not in ("127.0.0.1", "::1", "localhost") and not str(host).startswith("/"):
            attempts.append(str(host))
            raise OSError("rede externa bloqueada no teste")
        return original(self, address)  # type: ignore[arg-type]

    monkeypatch.setattr(socket.socket, "connect", guarded)
    window = MainWindow()
    session = Session.new(tmp_path / "x.opesvault", "Família")
    f = family()
    session.ledger = f.ledger
    f.ledger.record_opening_balance(f.bank, "1000.00", date(2026, 1, 1))
    pipeline.import_document(session, ImportRequest("nu.pdf", docs.nubank_card_pdf()))
    window.session = session
    window._refresh()
    texts = _visible_texts(window)  # visits every page, charts included
    from opesvault.ui.help import help_for

    # Help is local text: no browser, no URL.
    assert all("http" not in help_for(p.title) for p in window.pages)
    assert texts and attempts == []
