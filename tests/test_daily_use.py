"""Phase 9: first-use wizard, visual lock, contextual help and keyboard review."""

from decimal import Decimal
from pathlib import Path
from uuid import UUID

import pytest
from PySide6.QtCore import QEvent, Qt
from PySide6.QtGui import QAction, QKeyEvent
from PySide6.QtWidgets import QApplication, QComboBox, QLineEdit

from opesvault.domain import queries
from opesvault.domain.onboarding import apply_setup
from opesvault.session import Session
from opesvault.ui.common import select_combo
from opesvault.ui.help import PAGES, help_for
from opesvault.ui.idle_lock import IdleWatcher
from opesvault.ui.main_window import MainWindow
from opesvault.ui.setup_wizard import SetupWizard
from opesvault.vault.errors import ErrorCode, VaultError
from opesvault.vault.model import RevisionInfo


@pytest.fixture(scope="module")
def app() -> QApplication:
    instance = QApplication.instance()
    return instance if isinstance(instance, QApplication) else QApplication([])


@pytest.fixture
def window(app: QApplication, tmp_path: Path) -> MainWindow:
    win = MainWindow()
    win.session = Session.new(tmp_path / "x.opesvault", "Teste")
    win._refresh()
    return win


def test_wizard_builds_and_applies_a_plan(window: MainWindow) -> None:
    assert window.session is not None
    ledger = window.session.ledger
    wizard = SetupWizard(window, ledger)
    wizard.members_page.names.setPlainText("Ana\nBruno\n\n")
    row = wizard.accounts_page.add_row()
    cells = [wizard.accounts_page.table.cellWidget(row, c) for c in range(6)]
    assert isinstance(cells[0], QLineEdit) and isinstance(cells[2], QLineEdit) and isinstance(cells[4], QLineEdit)
    cells[0].setText("Banco A")
    cells[2].setText("Ana, Bruno")
    cells[4].setText("2.500,00")
    empty = wizard.accounts_page.add_row()  # rows without a name are ignored
    assert empty == 1
    card_row = wizard.cards_page.add_row()
    wizard.cards_page.initializePage()  # refreshes members and payers from the previous pages
    card = [wizard.cards_page.table.cellWidget(card_row, c) for c in range(6)]
    assert isinstance(card[0], QLineEdit) and isinstance(card[1], QComboBox)
    assert isinstance(card[2], QLineEdit) and isinstance(card[5], QComboBox)
    card[0].setText("Cartão Ana")
    card[1].setCurrentText("Ana")
    card[2].setText("4321")
    select_combo(card[5], "Banco A")

    plan = wizard.plan()
    assert plan.members == ("Ana", "Bruno")
    assert [a.name for a in plan.accounts] == ["Banco A"]
    assert plan.accounts[0].holders == ("Ana", "Bruno")
    wizard.finish_page.initializePage()
    assert "2 integrante(s), 1 conta(s) e 1 cartão(ões)" in wizard.finish_page.summary.text()
    assert wizard.finish_page.validatePage()

    apply_setup(ledger, plan)
    bank = next(a.id for a in ledger.accounts.values() if a.name == "Banco A")
    assert queries.balance(ledger, bank) == Decimal("2500.00")
    assert next(iter(ledger.cards.values())).settlement_account_id == bank


def test_unsaved_vault_unlocks_without_password(window: MainWindow) -> None:
    window.lock_screen()
    assert window.locked and window.shell.currentWidget() is window.lock_panel
    assert window.windowTitle() == "OpesVault — bloqueado"
    save = next(a for a in window.findChildren(QAction) if a.text() == "&Salvar")
    assert not save.isEnabled()  # Ctrl+S and the other shortcuts do nothing while locked
    window._refresh()
    assert window.windowTitle() == "OpesVault — bloqueado"  # the family name stays hidden
    window.unlock_screen()
    assert not window.locked and window.shell.currentWidget() is window.content
    assert save.isEnabled()


class FakeClient:
    def __init__(self, error: ErrorCode | None) -> None:
        self.error = error
        self.calls: list[UUID] = []

    def unlock(self, path: Path, base_revision_id: UUID) -> None:
        self.calls.append(base_revision_id)
        if self.error is not None:
            raise VaultError(self.error)


def _wait_jobs(window: MainWindow) -> None:
    from PySide6.QtCore import QThreadPool

    QThreadPool.globalInstance().waitForDone(5000)
    for _ in range(20):
        QApplication.processEvents()


def test_saved_vault_unlock_goes_through_the_worker(window: MainWindow, monkeypatch: pytest.MonkeyPatch) -> None:
    from datetime import UTC, datetime
    from uuid import uuid4

    assert window.session is not None
    revision = RevisionInfo(
        vault_id=window.session.vault_id, format_version=1, revision=1, revision_id=uuid4(), saved_at=datetime.now(UTC)
    )
    window.session.revision = revision
    monkeypatch.setattr("opesvault.ui.main_window.QMessageBox.warning", lambda *a, **k: None)

    window.lock_screen()
    window.client = FakeClient(ErrorCode.WRONG_PASSWORD)  # type: ignore[assignment]
    window.unlock_screen()
    _wait_jobs(window)
    assert window.locked

    window.client = FakeClient(None)  # type: ignore[assignment]
    window.unlock_screen()
    _wait_jobs(window)
    assert not window.locked
    assert window.client.calls == [revision.revision_id]  # type: ignore[attr-defined]


def test_idle_watcher_fires_once_per_idle_period(app: QApplication) -> None:
    from PySide6.QtCore import QObject

    now = [0.0]
    owner = QObject()
    watcher = IdleWatcher(owner, 10, clock=lambda: now[0])
    fired: list[bool] = []
    watcher.idle.connect(lambda: fired.append(True))
    now[0] = 599
    watcher.check()
    assert fired == []
    now[0] = 600
    watcher.check()
    watcher.check()
    assert fired == [True]
    key = QKeyEvent(QEvent.Type.KeyPress, Qt.Key.Key_A, Qt.KeyboardModifier.NoModifier)
    watcher.eventFilter(watcher, key)
    now[0] = 1199
    watcher.check()
    assert fired == [True]
    now[0] = 1200
    watcher.check()
    assert fired == [True, True]
    watcher.minutes = 0
    now[0] = 99999
    watcher.check()
    assert len(fired) == 2


def test_idle_lock_only_with_a_session(window: MainWindow) -> None:
    window._on_idle()
    assert window.locked
    window.unlock_screen()
    window.session = None
    window._on_idle()
    assert not window.locked


def test_every_page_has_help(window: MainWindow) -> None:
    for page in window.pages:
        assert page.title in PAGES, page.title
        assert page.title in help_for(page.title)
    assert "Ctrl+S" in help_for("")


def test_review_keyboard_flow(window: MainWindow, monkeypatch: pytest.MonkeyPatch) -> None:
    from opesvault.importing import pipeline
    from opesvault.importing.pipeline import ImportRequest
    from opesvault.ui.pages import import_page
    from opesvault.ui.pages.import_page import ImportPage

    from . import synthetic_docs as docs
    from .domain_fixtures import family

    assert window.session is not None
    window.session.ledger = family().ledger
    window._refresh()
    batch = pipeline.import_document(window.session, ImportRequest("nu.pdf", docs.nubank_card_pdf()))
    page = next(p for p in window.pages if isinstance(p, ImportPage))
    window.nav.setCurrentRow(window.pages.index(page))
    page.batch_id = batch.id
    page.refresh()
    assert page.items.rowCount() >= 3
    monkeypatch.setattr(import_page, "ask_reason", lambda *a, **k: "conferido")
    monkeypatch.setattr(import_page.QMessageBox, "information", lambda *a, **k: None)
    page.items.selectRow(0)
    page.reject()
    assert page.items.currentRow() == 1  # moved on to the next item
    page.keep_separate()
    assert page.items.currentRow() in (1, 2)
    statuses = {i.status.value for i in pipeline.items_of(window.session.ledger, batch.id)}
    assert "rejected" in statuses


def test_unknown_opening_balance_is_not_zero() -> None:
    from opesvault.domain.ledger import Ledger
    from opesvault.domain.model import AccountSubtype
    from opesvault.domain.onboarding import AccountPlan, SetupPlan

    ledger = Ledger.new("F")
    result = apply_setup(ledger, SetupPlan(accounts=(AccountPlan("Caixa", AccountSubtype.CASH),)))
    assert result.opening_balances == 0
    assert not ledger.operations  # nothing invented for a balance that was not informed
