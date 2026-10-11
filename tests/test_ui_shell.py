"""The window shell, its vault commands and the review pages, driven through their API.

Modal dialogs are never shown: file pickers, input boxes, message boxes, `decide`/`confirm`
and each dialog's `exec` are replaced per test. Vault operations go through the real
worker protocol with the development worker (password from the environment); computer
preferences go to a temporary file (the autouse `settings_file` fixture).

The Cofre menu basics live in test_vault_commands.py and the ledger's row commands in
test_ledger_commands.py; this file covers what those leave out.
"""

import time
from collections.abc import Callable, Iterator
from datetime import date, timedelta
from decimal import Decimal
from pathlib import Path
from typing import Any
from uuid import UUID, uuid4

import pytest
from PySide6.QtCore import QMimeData, QPoint, QPointF, QSize, Qt, QThreadPool, QUrl
from PySide6.QtGui import QCloseEvent, QDragEnterEvent, QDropEvent, QResizeEvent
from PySide6.QtWidgets import QApplication, QComboBox, QFileDialog, QInputDialog, QMenu, QMessageBox

from opesvault.domain import budget, queries
from opesvault.domain.alerts import Target, alerts
from opesvault.domain.cards import bills, plans
from opesvault.domain.ledger import DomainError, Ledger
from opesvault.domain.model import AccountSubtype, AccountType, OriginKind, YearMonth
from opesvault.domain.search import StatusFilter
from opesvault.domain.settings import get_settings, update_settings
from opesvault.exports import ledger_csv
from opesvault.importing import pipeline
from opesvault.importing.model import BatchStatus, ExtractedItem, ItemKind, ItemStatus
from opesvault.importing.pipeline import ImportRequest
from opesvault.importing.source import SourceError, SourceProblem
from opesvault.session import Session
from opesvault.ui import preferences, theme
from opesvault.ui.common import month_label, select_combo
from opesvault.ui.dialogs import BillPaymentDialog, CardDialog, CategoryDialog, OperationDialog, ask_reason
from opesvault.ui.main_window import MainWindow
from opesvault.ui.pages.base import Page
from opesvault.ui.pages.imports import ImportPage
from opesvault.ui.pages.imports.labels import item_notes
from opesvault.ui.pages.imports.queue import ImportJob
from opesvault.ui.pages.imports.review import ItemDialog
from opesvault.ui.pages.ledger import LedgerPage
from opesvault.ui.pages.overview_page import OverviewPage
from opesvault.ui.pages.settings_page import SettingsPage
from opesvault.ui.shell.errors import ERROR_MESSAGES
from opesvault.ui.shell.jobs import VaultJob
from opesvault.ui.shell.sidebar import BADGE_ROLE, _badge_text
from opesvault.vault.backup import create_backup, list_backups
from opesvault.vault.client import VaultClient
from opesvault.vault.errors import ErrorCode, VaultError
from opesvault.vault.lock import VaultLock, lock_path_for
from opesvault.vault.sqlcipher_store import CANDIDATE_INFIX

from . import synthetic_docs as docs
from .conftest import dev_worker_command
from .domain_fixtures import Family, category, family
from .test_ai import _statement
from .test_pdf_password import PASSWORD as PDF_PASSWORD
from .test_pdf_password import encrypted

Box = tuple[str, str, str]


# ── fixtures and helpers ─────────────────────────────────


@pytest.fixture(scope="module")
def app() -> QApplication:
    instance = QApplication.instance()
    app = instance if isinstance(instance, QApplication) else QApplication([])
    theme.apply_theme(app, dark=False)
    return app


@pytest.fixture
def boxes(monkeypatch: pytest.MonkeyPatch) -> list[Box]:
    """Message boxes are recorded as (kind, title, text) instead of shown."""
    shown: list[Box] = []

    def recorder(kind: str) -> Callable[..., object]:
        def show(_parent: object, title: str, message: str, *_args: object, **_kwargs: object) -> object:
            shown.append((kind, title, message))
            return QMessageBox.StandardButton.Ok

        return show

    for kind in ("information", "warning", "critical", "about"):
        monkeypatch.setattr(QMessageBox, kind, recorder(kind))
    monkeypatch.setattr(QMessageBox, "exec", lambda box: shown.append(("exec", box.windowTitle(), box.text())) or 0)
    return shown


class Answers:
    """Stands in for `decide`/`confirm`: answers from a queue and records each question."""

    def __init__(self, default: object) -> None:
        self.queue: list[object] = []
        self.asked: list[str] = []
        self.default = default

    def __call__(self, _parent: object, title: str, *_args: object) -> object:
        self.asked.append(title)
        return self.queue.pop(0) if self.queue else self.default


@pytest.fixture
def decisions(monkeypatch: pytest.MonkeyPatch) -> Answers:
    answers = Answers("cancel")
    monkeypatch.setattr("opesvault.ui.shell.vault.decide", answers)
    return answers


@pytest.fixture
def confirms(monkeypatch: pytest.MonkeyPatch) -> Answers:
    answers = Answers(False)
    monkeypatch.setattr("opesvault.ui.shell.vault.confirm", answers)
    return answers


@pytest.fixture
def window(
    app: QApplication,
    boxes: list[Box],
    decisions: Answers,
    confirms: Answers,
    dev_worker_env: None,
) -> Iterator[MainWindow]:
    win = MainWindow()
    win.client = VaultClient(dev_worker_command())
    yield win
    wait(win)
    win._drop_session()  # releases the vault lock before the temporary folder goes away


def wait(window: MainWindow) -> None:
    """Lets background jobs finish and their queued results (and follow-ups) run."""
    for _ in range(4):
        QThreadPool.globalInstance().waitForDone(15000)
        for _ in range(20):
            QApplication.processEvents()


def saved_vault(path: Path, family_name: str = "Projeto Lima") -> Session:
    client = VaultClient(dev_worker_command())
    session = Session.new(path, family_name)
    frozen = session.freeze()
    session.mark_saved(frozen, client.save_frozen(frozen))
    return session


def open_saved(window: MainWindow, path: Path) -> Session:
    saved_vault(path)
    window.open_path(path)
    wait(window)
    assert window.session is not None
    return window.session


def with_family(window: MainWindow, tmp_path: Path) -> Family:
    f = family()
    session = Session.new(tmp_path / "x.opesvault", "Teste")
    session.ledger = f.ledger
    window.session = session
    window._refresh()
    return f


def page_of[T: Page](window: MainWindow, kind: type[T]) -> T:
    return next(p for p in window.pages if isinstance(p, kind))


def message(window: MainWindow) -> str:
    return window.statusBar().currentMessage()


def undo_steps(window: MainWindow) -> int:
    assert window.session is not None
    return len(window.session.undo_stack().undo_steps)


# ── small parts of the shell ─────────────────────────────


def test_sidebar_badge_text_caps_at_999() -> None:
    assert [_badge_text(n) for n in (1, 999, 1000, 25000)] == ["1", "999", "999+", "999+"]


def test_job_reports_vault_errors_and_hides_unexpected_ones(app: QApplication, monkeypatch: pytest.MonkeyPatch) -> None:
    recorded: list[str] = []
    monkeypatch.setattr("opesvault.diagnostics.record", lambda code, _exc: recorded.append(code))

    def run(fn: Callable[[], object]) -> tuple[list[object], list[object]]:
        done: list[object] = []
        failed: list[object] = []
        job = VaultJob(fn)
        job.signals.done.connect(done.append)
        job.signals.failed.connect(failed.append)
        job.run()  # same thread: the signals arrive at once
        return done, failed

    def wrong_password() -> None:
        raise VaultError(ErrorCode.WRONG_PASSWORD)

    def unexpected() -> None:
        raise RuntimeError("Conta 1234 da Ana")  # never shown nor recorded as text

    assert run(lambda: 42) == ([42], [])
    assert run(wrong_password) == ([], [ErrorCode.WRONG_PASSWORD])
    assert run(unexpected) == ([], [ErrorCode.INTERNAL])
    assert recorded == ["JOB_FAILED"]


# ── vault lifecycle ──────────────────────────────────────


def test_new_vault_creates_saves_and_holds_the_lock(
    window: MainWindow, boxes: list[Box], tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from opesvault.ui.setup_wizard import SetupWizard

    offered: list[object] = []
    monkeypatch.setattr(QFileDialog, "getSaveFileName", lambda *_a, **_k: (str(tmp_path / "lima"), ""))
    monkeypatch.setattr(QInputDialog, "getText", lambda *_a, **_k: ("  Projeto Lima  ", True))
    monkeypatch.setattr(SetupWizard, "exec", lambda wizard: offered.append(wizard) or 0)
    window.new_vault()
    assert offered, "the first-use wizard is offered"
    assert window.busy and window.status.text() == "Aguardando o cofre…"
    wait(window)

    path = tmp_path / "lima.opesvault"
    session = window.session
    assert session is not None and session.path == path and path.is_file()
    assert session.revision is not None and session.revision.revision == 1 and not session.dirty
    assert not window.busy and window.status.text() == "Salvo · revisão 1"
    assert window.windowTitle() == "Projeto Lima — OpesVault"
    assert window.lock is not None and window.lock.held
    with pytest.raises(VaultError) as exc:
        VaultLock(path).acquire()  # a second window cannot edit the same vault
    assert exc.value.code is ErrorCode.LOCKED
    assert boxes == []


def test_new_vault_stops_without_a_file_a_name_or_on_an_existing_file(
    window: MainWindow, boxes: list[Box], tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    named: list[object] = []
    monkeypatch.setattr(QFileDialog, "getSaveFileName", lambda *_a, **_k: ("", ""))
    monkeypatch.setattr(QInputDialog, "getText", lambda *_a, **_k: named.append(1) or ("Lima", True))
    window.new_vault()
    assert named == [] and window.session is None

    existing = tmp_path / "ja.opesvault"
    existing.write_bytes(b"x")
    monkeypatch.setattr(QFileDialog, "getSaveFileName", lambda *_a, **_k: (str(tmp_path / "ja"), ""))
    monkeypatch.setattr(QInputDialog, "getText", lambda *_a, **_k: ("   ", True))
    window.new_vault()
    assert window.session is None and boxes == []  # a blank name is just not a vault yet

    monkeypatch.setattr(QInputDialog, "getText", lambda *_a, **_k: ("Lima", True))
    window.new_vault()
    assert boxes == [("warning", "OpesVault", ERROR_MESSAGES[ErrorCode.ALREADY_EXISTS])]
    assert window.session is None and existing.read_bytes() == b"x" and not window._jobs


def test_open_then_close_hands_the_vault_to_another_window(
    window: MainWindow, boxes: list[Box], tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    path = tmp_path / "lima.opesvault"
    saved_vault(path)
    preferences.set_recents_enabled(True)
    monkeypatch.setattr(QFileDialog, "getOpenFileName", lambda *_a, **_k: (str(path), ""))
    window.open_vault()
    wait(window)
    assert window.session is not None and window.session.ledger.meta.family_name == "Projeto Lima"
    assert window.shell.currentWidget() is window.content
    assert window.status.text() == "Salvo · revisão 1"
    assert preferences.recent_paths() == [str(path)]  # remembered: consent was given

    other = MainWindow()
    other.client = window.client
    other.open_path(path)
    assert boxes == [("warning", "OpesVault", ERROR_MESSAGES[ErrorCode.LOCKED])]
    assert other.session is None and not other._jobs

    window.close_vault()
    assert window.session is None and window.lock is None
    assert window.shell.currentWidget() is window.welcome
    assert window.welcome.recent_list.count() == 1 and window.windowTitle() == "OpesVault"
    other.open_path(path)
    wait(other)
    assert other.session is not None
    other._drop_session()


def test_wrong_password_on_open_leaves_nothing_open(
    window: MainWindow, boxes: list[Box], tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    path = tmp_path / "lima.opesvault"
    saved_vault(path)
    monkeypatch.setenv("OPV_DEV_PASSWORD", "senha errada")
    window.open_path(path)
    wait(window)
    assert window.session is None and window.lock is None
    assert boxes == [("warning", "OpesVault", ERROR_MESSAGES[ErrorCode.WRONG_PASSWORD])]
    with VaultLock(path):  # the lock was given back
        pass


def test_cancelled_operations_say_nothing(window: MainWindow, boxes: list[Box]) -> None:
    window._show_error(ErrorCode.CANCELLED)
    window._show_error(ErrorCode.IO_ERROR)
    assert boxes == [("warning", "OpesVault", ERROR_MESSAGES[ErrorCode.IO_ERROR])]
    # Every code a worker can return has words for the user; a mismatch is fixed inside the password dialog.
    assert set(ErrorCode) - set(ERROR_MESSAGES) == {ErrorCode.PASSWORD_MISMATCH}


def test_choosing_save_finishes_the_close_once_the_vault_is_written(
    window: MainWindow, decisions: Answers, tmp_path: Path
) -> None:
    path = tmp_path / "lima.opesvault"
    session = open_saved(window, path)
    session.ledger.add_member("Carla")
    window.on_changed()
    assert window.status.text() == "Alterações não salvas"
    decisions.queue = ["save"]
    window.close_vault()
    assert decisions.asked == ["Salvar alterações antes de fechar o cofre?"]
    assert window.session is session  # saving runs first
    wait(window)
    assert window.session is None and window.lock is None  # ... then the close resumes
    reopened = Session.from_opened(path, window.client.open_raw(path))
    assert reopened.revision is not None and reopened.revision.revision == 2
    assert "Carla" in [m.name for m in reopened.ledger.members.values()]


def test_discard_or_cancel_decide_what_happens_to_unsaved_work(
    window: MainWindow, decisions: Answers, tmp_path: Path
) -> None:
    with_family(window, tmp_path)  # never saved: dirty
    decisions.queue = ["cancel"]
    window.close_vault()
    assert window.session is not None
    decisions.queue = [None]  # Esc on the question is a cancel too
    window.close_vault()
    assert window.session is not None
    decisions.queue = ["discard"]
    window.close_vault()
    assert window.session is None and len(decisions.asked) == 3


def test_closing_the_window_respects_busy_work_and_unsaved_changes(
    window: MainWindow, decisions: Answers, tmp_path: Path
) -> None:
    with_family(window, tmp_path)
    window._page_busy(True)
    assert window.busy and not window.content.isEnabled()
    assert window.status.text() == "Processando documento…"
    window.save_vault()
    assert not window._jobs  # no save while a page mutates the session
    event = QCloseEvent()
    window.closeEvent(event)
    assert not event.isAccepted() and decisions.asked == []

    window._page_busy(False)
    assert window.content.isEnabled() and window.status.text() == "Alterações não salvas"
    decisions.queue = ["cancel"]
    event = QCloseEvent()
    window.closeEvent(event)
    assert not event.isAccepted() and window.session is not None

    decisions.queue = ["discard"]
    event = QCloseEvent()
    window.closeEvent(event)
    assert event.isAccepted() and window.session is None
    settings = preferences.app_settings()
    assert settings.value("janela/geometria") is not None
    assert settings.value("janela/lateral_visivel", type=bool) is True


def test_leftovers_of_an_interrupted_save_are_removed_only_when_confirmed(
    window: MainWindow, confirms: Answers, tmp_path: Path
) -> None:
    path = tmp_path / "lima.opesvault"
    leftover = path.with_name(path.name + CANDIDATE_INFIX + "abc")
    saved_vault(path)
    leftover.write_bytes(b"cifrado")
    window.open_path(path)
    wait(window)
    assert confirms.asked == ["Remover arquivos de um salvamento interrompido?"] and leftover.exists()
    window.close_vault()
    confirms.queue = [True]
    window.open_path(path)
    wait(window)
    assert not leftover.exists() and path.exists()


# ── backups, restore and export ──────────────────────────


def test_backup_now_warns_about_unsaved_work_and_reports_a_failure(
    window: MainWindow, boxes: list[Box], tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    session = open_saved(window, tmp_path / "lima.opesvault")
    session.ledger.add_member("Carla")
    window.on_changed()
    monkeypatch.setattr(QFileDialog, "getExistingDirectory", lambda *_a, **_k: "")
    window.backup_now()  # unsaved work is announced; cancelling the folder does nothing
    assert boxes == [
        ("information", "Backup", "O backup copia a última revisão salva. Salve antes para incluir as alterações.")
    ]

    blocker = tmp_path / "um-arquivo"
    blocker.write_bytes(b"")
    update_settings(session.ledger, backup_dir=str(blocker))
    boxes.clear()
    window.backup_now()
    assert boxes[-1] == ("warning", "Backup", "Não foi possível criar o backup.")


def test_automatic_backup_follows_each_save_and_reports_its_failure(window: MainWindow, tmp_path: Path) -> None:
    session = open_saved(window, tmp_path / "lima.opesvault")
    settings_page = page_of(window, SettingsPage)
    window.show_page(window.pages.index(settings_page))
    settings_page.auto_backup.setChecked(True)
    settings_page.backup_dir.setText(str(tmp_path / "auto"))
    settings_page.backup_dir.textEdited.emit(settings_page.backup_dir.text())  # what typing emits
    window.save_vault()  # the setting being typed enters the session first
    wait(window)
    assert get_settings(session.ledger).auto_backup and not session.dirty
    [backup] = list_backups(tmp_path / "auto", "lima")
    assert backup.revision == 2

    blocker = tmp_path / "um-arquivo"
    blocker.write_bytes(b"")
    settings_page.backup_dir.setText(str(blocker))
    settings_page.backup_dir.textEdited.emit(settings_page.backup_dir.text())
    window.save_vault()
    wait(window)
    assert session.revision is not None and session.revision.revision == 3
    assert message(window) == "Salvo, mas o backup automático falhou. Verifique a pasta de backups."


def test_restore_suggests_a_name_and_never_overwrites(
    window: MainWindow, boxes: list[Box], tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    path = tmp_path / "lima.opesvault"
    saved_vault(path)
    backup = create_backup(path, 1, tmp_path / "copias")
    suggested: list[str] = []

    def save_name(_parent: object, _title: str, proposal: str, _filter: str) -> tuple[str, str]:
        suggested.append(proposal)
        return str(tmp_path / "restaurado"), ""

    monkeypatch.setattr(QFileDialog, "getOpenFileName", lambda *_a, **_k: (str(backup), ""))
    monkeypatch.setattr(QFileDialog, "getSaveFileName", save_name)
    window.restore_backup()
    wait(window)
    target = tmp_path / "restaurado.opesvault"
    assert suggested == [str(tmp_path / "copias" / "lima-restaurado.opesvault")]
    assert window.session is not None and window.session.path == target
    assert target.read_bytes() == backup.read_bytes()
    assert window.lock is not None and window.lock.path == lock_path_for(target)
    assert boxes[0][0] == "information" and boxes[0][2].startswith("Backup válido: revisão 1")

    window.close_vault()
    boxes.clear()
    window.restore_backup()
    wait(window)
    assert boxes[-1] == ("warning", "OpesVault", ERROR_MESSAGES[ErrorCode.ALREADY_EXISTS])
    assert window.session is None


def test_export_is_confirmed_and_written_where_chosen(
    window: MainWindow, boxes: list[Box], confirms: Answers, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import json

    f = with_family(window, tmp_path)
    f.ledger.record_expense(f.bank, f.groceries, "42.00", date(2026, 3, 1), "Feira")
    proposals: list[str] = []
    target = [tmp_path / "livro.csv"]

    def choose(_parent: object, _title: str, proposal: str, _filter: str) -> tuple[str, str]:
        proposals.append(proposal)
        return str(target[0]), ""

    monkeypatch.setattr(QFileDialog, "getSaveFileName", choose)
    window.export("csv")
    assert confirms.asked == ["Exportar sem criptografia?"] and proposals == []
    confirms.queue = [True]
    window.export("csv")
    assert proposals == ["opesvault-exportacao.csv"]
    assert (tmp_path / "livro.csv").read_bytes() == ledger_csv(f.ledger)

    confirms.queue = [True]
    target[0] = tmp_path / "dados.json"
    window.export("json")
    assert proposals[-1] == "opesvault-exportacao.json"
    assert "Feira" in json.dumps(json.loads((tmp_path / "dados.json").read_bytes()), ensure_ascii=False)

    confirms.queue = [True]
    target[0] = tmp_path  # a folder: the write fails
    window.export("csv")
    assert boxes == [("warning", "OpesVault", ERROR_MESSAGES[ErrorCode.IO_ERROR])]


# ── shell state, undo, alerts and preferences ────────────


def test_undo_and_redo_move_through_unsaved_edits(window: MainWindow, tmp_path: Path) -> None:
    f = with_family(window, tmp_path)
    carla = f.ledger.add_member("Carla")
    window.on_changed()
    assert window.undo_action.isEnabled() and window.undo_action.text().startswith("Desfazer ")
    window.undo()
    assert carla.id not in f.ledger.members and message(window).startswith("Desfeito:")
    assert window.redo_action.isEnabled() and window.redo_action.text().startswith("Refazer ")
    window.redo()
    assert carla.id in f.ledger.members and message(window).startswith("Refeito:")
    window.undo()
    window.undo()
    assert message(window) == "Nada a desfazer desde o último salvamento."
    window.lock_screen()
    window.redo()  # locked: the content (and its history) is out of reach
    assert carla.id not in f.ledger.members
    window.unlock_screen()  # never saved: no password needed
    window.redo()
    assert carla.id in f.ledger.members


def test_the_month_going_over_budget_is_announced_once(window: MainWindow, tmp_path: Path) -> None:
    f = with_family(window, tmp_path)
    month = YearMonth.of(date.today())
    budget.set_budget(f.ledger, f.groceries, month, "100.00")
    f.ledger.record_expense(f.bank, f.groceries, "150.00", date.today(), "Feira")
    window.on_changed()  # the first look at a vault is the baseline: no news
    assert "Orçamento" not in message(window)
    transport = category(f.ledger, "Transporte")
    budget.set_budget(f.ledger, transport, month, "50.00")
    f.ledger.record_expense(f.bank, transport, "80.00", date.today(), "Ônibus")
    window.on_changed()
    assert message(window) == f"Orçamento estourado: Transporte em {month_label(month)}."
    window.notify("")
    f.ledger.record_expense(f.bank, transport, "5.00", date.today(), "Ônibus")
    window.on_changed()
    assert message(window) == ""  # still over, not news

    leisure, health = category(f.ledger, "Lazer"), category(f.ledger, "Saúde")
    for cat in (leisure, health):
        budget.set_budget(f.ledger, cat, month, "10.00")
        f.ledger.record_expense(f.bank, cat, "20.00", date.today(), "Passeio")
    window.on_changed()  # two at once: the first is named, the other counted
    assert message(window).startswith("Orçamento estourado: ") and message(window).endswith(" e mais 1.")


def test_alerts_on_open_lead_to_the_overview(window: MainWindow, tmp_path: Path) -> None:
    f = with_family(window, tmp_path)
    f.ledger.record_card_purchase(f.card, f.groceries, "300.00", date.today() - timedelta(days=40), "Mercado")
    window.show_page(2)
    window.show_alerts_on_open()
    assert window.stack.currentWidget() is page_of(window, OverviewPage)
    count = len(alerts(f.ledger))
    assert message(window).endswith(f" · {count} aviso(s) em Visão geral.") and "atrasado" in message(window)


def test_sidebar_counts_what_needs_attention(window: MainWindow, tmp_path: Path) -> None:
    f = with_family(window, tmp_path)
    assert window.session is not None
    pipeline.import_document(window.session, ImportRequest("x.csv", _statement("LOJA A", "LOJA B"), account_id=f.bank))
    window._refresh()
    item = window.sidebar.item(window.pages.index(page_of(window, ImportPage)))
    assert item.data(BADGE_ROLE) == 2
    assert item.data(Qt.ItemDataRole.AccessibleTextRole) == "Importar e revisar, 2 itens pedem atenção"
    window.nav.resize(220, 600)
    with_badge = window.nav.grab().toImage()
    item.setData(BADGE_ROLE, None)
    assert window.nav.grab().toImage() != with_badge  # the count is drawn on the row


def test_help_about_and_lock_settings(window: MainWindow, boxes: list[Box]) -> None:
    from opesvault import __version__
    from opesvault.ui.help import help_for

    window._show_page(window.pages.index(page_of(window, LedgerPage)))
    window.show_help()
    assert boxes[-1] == ("exec", "Ajuda", help_for("Livro financeiro"))
    window.lock_screen()
    window.show_help()  # locked: no hint of what is behind
    assert boxes[-1] == ("exec", "Ajuda", help_for(""))
    window._show_content()
    window.show_about()
    assert boxes[-1][0] == "about" and __version__ in boxes[-1][2]
    window.configure_lock()
    settings_page = page_of(window, SettingsPage)
    assert window.stack.currentWidget() is settings_page
    assert settings_page.tabs.currentIndex() == settings_page.privacy_tab


def test_search_shortcut_says_when_the_screen_has_none(window: MainWindow, tmp_path: Path) -> None:
    with_family(window, tmp_path)
    window._show_page(window.pages.index(page_of(window, SettingsPage)))
    window.focus_search()
    assert message(window) == "Esta tela não tem busca."
    window._show_page(window.pages.index(page_of(window, LedgerPage)))
    window.notify("")
    window.focus_search()
    assert message(window) == ""


def test_recent_vaults_need_consent_and_stay_short(
    window: MainWindow, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    window._fill_recents()
    [disabled] = window.recent_menu.actions()
    assert disabled.text() == "Desativado (Configurações)" and not disabled.isEnabled()
    window._remember(tmp_path / "a.opesvault")
    assert preferences.recent_paths() == []  # nothing is remembered without consent

    window.welcome.remember_recents.setChecked(True)
    assert preferences.recents_enabled()
    assert message(window) == "Os próximos cofres abertos aparecerão aqui. Para desligar, use Configurações."
    vaults = [tmp_path / f"v{n}.opesvault" for n in range(10)]
    for vault in vaults:
        window._remember(vault)
    window._remember(vaults[3])
    assert preferences.recent_paths() == [str(p) for p in (vaults[3], vaults[9], vaults[8], *vaults[7:3:-1], vaults[2])]

    opened: list[Path] = []
    monkeypatch.setattr(window, "open_path", opened.append)
    window._fill_recents()
    actions = window.recent_menu.actions()
    assert len(actions) == preferences.MAX_RECENTS
    actions[0].trigger()
    assert opened == [vaults[3]]

    window._refresh_welcome()  # none of them exists: listed, but not openable
    item = window.welcome.recent_list.item(0)
    assert item.text().endswith("(não encontrado)")
    window.welcome._choose(item)
    assert opened == [vaults[3]]


def test_save_reminder_waits_for_the_configured_minutes(
    window: MainWindow, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    f = with_family(window, tmp_path)
    update_settings(f.ledger, save_reminder_minutes=5)
    clock = [1000.0]
    monkeypatch.setattr(time, "monotonic", lambda: clock[0])
    window._remind()
    assert window._dirty_since == 1000.0
    clock[0] += 4 * 60
    window._remind()
    assert not message(window).startswith("Alterações não salvas há")
    clock[0] += 60
    window._remind()
    assert message(window).startswith("Alterações não salvas há 5 min.")
    window.session = None
    window._remind()
    assert window._dirty_since is None


def test_idle_lock_minutes_are_a_computer_preference(settings_file: Path) -> None:
    from opesvault.ui.idle_lock import SETTINGS_KEY, lock_minutes, set_lock_minutes

    set_lock_minutes(500)
    assert lock_minutes() == 240  # clamped
    assert "240" in settings_file.read_text()
    preferences.app_settings().setValue(SETTINGS_KEY, "abc")
    assert lock_minutes() == 10  # unreadable: the default


def test_settings_page_preferences_and_vault_commands(
    window: MainWindow, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from opesvault.ui.idle_lock import lock_minutes

    f = with_family(window, tmp_path)
    page = page_of(window, SettingsPage)
    window.show_page(window.pages.index(page))
    page.lock_minutes.setValue(25)  # a computer preference: written at once, and the watcher follows
    assert lock_minutes() == 25 and window.idle.minutes == 25

    page.recents.setChecked(True)
    preferences.app_settings().setValue(preferences.RECENTS_LIST, [str(tmp_path / "a.opesvault")])
    page.recents.setChecked(False)  # turning it off also forgets the list
    assert not preferences.recents_enabled() and preferences.recent_paths() == []

    monkeypatch.setattr(QFileDialog, "getExistingDirectory", lambda *_a, **_k: str(tmp_path / "copias"))
    page._choose_dir()
    assert get_settings(f.ledger).backup_dir == str(tmp_path / "copias")
    assert message(window) == "Configuração alterada no cofre. Salve (Ctrl+S) para gravar."

    called: list[str] = []
    monkeypatch.setattr(window, "backup_now", lambda: called.append("backup"))
    page._window_command("backup_now")
    page._window_command("does_not_exist")  # nothing to run, nothing breaks
    assert called == ["backup"]


# ── dialogs ──────────────────────────────────────────────


def test_card_dialog_validates_creates_and_edits(app: QApplication) -> None:
    f = family()
    dialog = CardDialog(None, f.ledger)
    dialog._try_accept()
    assert dialog.error.text() == "Informe o nome do cartão." and not dialog.error.isHidden()
    dialog.name.setText("Cartão Bruno")
    dialog.last4.setText("12")
    dialog._try_accept()
    assert dialog.error.text() == "Informe os 4 últimos dígitos."
    dialog.last4.setText("4321")
    dialog.institution.setText("Banco B")
    select_combo(dialog.holder, f.bruno)
    select_combo(dialog.settlement, f.joint)
    dialog.closing.setValue(5)
    dialog.due.setValue(12)
    dialog.validate()
    card = dialog.apply()
    liability = f.ledger.accounts[card.liability_account_id]
    assert (liability.type, liability.subtype) == (AccountType.LIABILITY, AccountSubtype.CREDIT_CARD)
    assert liability.masked_number == "final 4321" and liability.holders == (f.bruno,)
    assert liability.institution == "Banco B"
    assert (card.holder_id, card.closing_day, card.due_day, card.settlement_account_id) == (f.bruno, 5, 12, f.joint)

    accounts = len(f.ledger.accounts)
    edit = CardDialog(None, f.ledger, card)
    assert edit.name.text() == "Cartão Bruno" and edit.due.value() == 12
    edit.due.setValue(20)
    updated = edit.apply()
    assert updated.id == card.id and updated.due_day == 20 and len(f.ledger.accounts) == accounts

    lonely = CardDialog(None, Ledger.new("Sem ninguém"))
    lonely.name.setText("Cartão")
    lonely.last4.setText("1111")
    with pytest.raises(DomainError, match="Cadastre um integrante"):
        lonely.validate()


def test_account_dialog_editing_keeps_what_the_account_is(app: QApplication) -> None:
    from opesvault.ui.dialogs import AccountDialog

    f = family()
    card_account = f.ledger.accounts[f.card_account]
    dialog = AccountDialog(None, f.ledger, card_account)
    assert dialog.subtype.currentText() == "Cartão de crédito" and not dialog.subtype.isEnabled()
    dialog.name.setText("Cartão X (Ana)")
    updated = f.ledger.update_account(dialog.build(), "Edição do cadastro")
    assert updated.type is AccountType.LIABILITY and updated.subtype is AccountSubtype.CREDIT_CARD
    assert updated.name == "Cartão X (Ana)"

    new = AccountDialog(None, f.ledger)
    new.name.setText("Reserva")
    select_combo(new.subtype, AccountSubtype.SAVINGS)
    built = new.build()
    assert built.type is AccountType.ASSET and built.subtype is AccountSubtype.SAVINGS


def test_category_dialog_lists_parents_of_the_chosen_kind(app: QApplication) -> None:
    f = family()
    dialog = CategoryDialog(None, f.ledger)
    parents = [dialog.parent_cat.itemData(i) for i in range(dialog.parent_cat.count())]
    assert parents[0] is None and f.groceries in parents  # expense categories to nest under
    select_combo(dialog.kind, AccountType.INCOME)
    parents = [dialog.parent_cat.itemData(i) for i in range(dialog.parent_cat.count())]
    assert f.salary in parents and f.groceries not in parents
    with pytest.raises(DomainError, match="Informe o nome"):
        dialog.validate()
    dialog.name.setText("Bônus")
    select_combo(dialog.parent_cat, f.salary)
    built = dialog.build()
    assert (built.type, built.subtype, built.parent_id) == (AccountType.INCOME, AccountSubtype.CATEGORY, f.salary)


def test_operation_dialog_records_each_kind(app: QApplication) -> None:
    f = family()
    ledger = f.ledger

    def fill(kind: str, source: UUID, target: UUID, amount: str) -> OperationDialog:
        dialog = OperationDialog(None, ledger, kind)
        select_combo(dialog.source, source)
        select_combo(dialog.target, target)
        dialog.amount.setText(amount)
        dialog.validate()
        return dialog

    fill("income", f.salary, f.bank, "1.000,00").apply()
    fill("transfer", f.bank, f.savings, "300,00").apply()
    assert queries.balance(ledger, f.bank) == Decimal("700.00")
    assert queries.balance(ledger, f.savings) == Decimal("300.00")

    single = fill("card_purchase", f.card, f.groceries, "90,00")
    single.description.setText("Mercado")
    single.apply()
    spread = fill("card_purchase", f.card, f.groceries, "300,00")
    spread.installments.setValue(3)
    select_combo(spread.policy, "spread")
    spread.apply()
    assert len(plans(ledger)) == 1
    assert queries.balance(ledger, f.card_account) == Decimal("390.00")  # owed on the card
    fill("card_payment", f.card, f.bank, "90,00").apply()
    assert queries.balance(ledger, f.card_account) == Decimal("300.00")
    assert any(op.description == "Mercado" for op in ledger.operations.values())
    assert any(op.description == "Receita" for op in ledger.operations.values())  # the kind names a blank one

    zero = OperationDialog(None, ledger, "expense")
    zero.amount.setText("0,00")
    with pytest.raises(DomainError, match="valor positivo"):
        zero.validate()
    empty = OperationDialog(None, Ledger.new("Vazio"), "card_payment")
    empty.amount.setText("10,00")
    with pytest.raises(DomainError, match="Cadastre as contas"):
        empty.validate()


def test_bill_payment_dialog_checks_and_pays(app: QApplication) -> None:
    f = family()
    f.ledger.record_card_purchase(f.card, f.groceries, "300.00", date.today() - timedelta(days=40), "Mercado")
    alert = next(a for a in alerts(f.ledger) if a.target is Target.ACCOUNTS)
    card_id, month = alert.ref  # type: ignore[misc]
    [bill] = bills(f.ledger, card_id, [month])
    dialog = BillPaymentDialog(None, f.ledger, f.ledger.cards[card_id], bill)
    dialog.amount.setText("0")
    with pytest.raises(DomainError, match="valor positivo"):
        dialog.validate()
    dialog.account.setCurrentIndex(-1)
    with pytest.raises(DomainError, match="Cadastre a conta"):
        dialog.validate()
    select_combo(dialog.account, f.bank)
    dialog.amount.setText("300,00")
    dialog.validate()
    dialog.apply()
    [paid] = bills(f.ledger, card_id, [month])
    assert paid.remaining == 0 and queries.balance(f.ledger, f.bank) == Decimal("-300.00")


def test_ask_reason_requires_words(app: QApplication, boxes: list[Box], monkeypatch: pytest.MonkeyPatch) -> None:
    answers = iter([("", False), ("   ", True), ("  lançado em dobro ", True)])
    monkeypatch.setattr(QInputDialog, "getText", lambda *_a, **_k: next(answers))
    parent = Page(lambda: None)
    assert ask_reason(parent, "Cancelar") is None
    assert boxes == []
    assert ask_reason(parent, "Cancelar") is None
    assert boxes == [("warning", "Cancelar", "O motivo é obrigatório.")]
    assert ask_reason(parent, "Cancelar") == "lançado em dobro"


def test_run_guarded_turns_arithmetic_errors_into_a_message(app: QApplication, boxes: list[Box]) -> None:
    from decimal import InvalidOperation

    from opesvault.ui.common import run_guarded

    parent = Page(lambda: None)

    def invalid() -> None:
        Decimal("abc")  # raises decimal.InvalidOperation

    def domain() -> None:
        raise DomainError("Mês já fechado.")

    with pytest.raises(InvalidOperation):
        invalid()
    assert run_guarded(parent, invalid) is None
    assert run_guarded(parent, lambda: 1 / Decimal(0)) is None  # DivisionByZero is arithmetic too
    assert run_guarded(parent, domain) is None
    assert run_guarded(parent, lambda: "ok") == "ok"
    assert boxes == [
        ("warning", "OpesVault", "Dados inválidos. Revise os campos."),
        ("warning", "OpesVault", "Dados inválidos. Revise os campos."),
        ("warning", "OpesVault", "Mês já fechado."),
    ]


def test_combo_enum_gives_back_the_enum_qt_flattened(app: QApplication) -> None:
    from opesvault.ui.common import combo_enum, combo_value, fill_combo

    combo = QComboBox()
    fill_combo(combo, [("Só ativos", StatusFilter.ACTIVE)], empty="Todos")
    assert combo_enum(combo, StatusFilter) is None  # the empty choice
    assert combo_enum(combo, StatusFilter, StatusFilter.ALL) is StatusFilter.ALL
    combo.setCurrentIndex(1)
    assert type(combo_value(combo)) is str  # what Qt hands back
    assert combo_enum(combo, StatusFilter) is StatusFilter.ACTIVE


# ── import and review ────────────────────────────────────


def _item(**fields: Any) -> ExtractedItem:
    base: dict[str, Any] = {
        "batch_id": uuid4(),
        "kind": ItemKind.PURCHASE,
        "occurred_on": None,
        "description": "X",
        "amount": None,
    }
    return ExtractedItem(**{**base, **fields})


def test_item_notes_say_what_the_fields_do_not() -> None:
    assert item_notes(_item()) == ""
    item = _item(
        warnings=("data estimada",),
        installment=(2, 10),
        foreign_amount=Decimal("10.50"),
        foreign_currency="USD",
        card_last4="1234",
        suggestion_source="user_rule:abc",
        status=ItemStatus.DUPLICATE,
    )
    assert item_notes(item).split("; ") == [
        "data estimada",
        "parcela 2/10",
        "USD 10.50",
        "cartão final 1234",
        "sugestão (sua regra)",
        "já existe no livro: aprovar só vincula a evidência",
    ]


def test_import_job_reports_every_failure_as_a_result(app: QApplication, monkeypatch: pytest.MonkeyPatch) -> None:
    recorded: list[str] = []
    monkeypatch.setattr("opesvault.diagnostics.record", lambda code, _exc: recorded.append(code))
    results: list[object] = []

    def run(fn: Callable[[], object]) -> object:
        job = ImportJob(fn)
        job.signals.done.connect(results.append)
        job.run()
        return results[-1]

    def protected() -> None:
        raise SourceError(SourceProblem.PASSWORD_REQUIRED)

    def broken() -> None:
        raise RuntimeError("linha 3 do extrato")

    assert isinstance(run(protected), SourceError) and recorded == []
    assert isinstance(run(broken), RuntimeError) and recorded == ["IMPORT_FAILED"]
    assert run(lambda: "lote") == "lote"


def _review(window: MainWindow, f: Family, *descriptions: str, account: UUID | None = None) -> tuple[ImportPage, UUID]:
    assert window.session is not None
    batch = pipeline.import_document(
        window.session, ImportRequest("extrato.csv", _statement(*descriptions), account_id=account or f.bank)
    )
    window.session.undo_stack().seal()
    page = page_of(window, ImportPage)
    window.navigate("import")
    page.batch_id = batch.id
    page.refresh()
    return page, batch.id


def test_item_dialog_needs_a_reason_and_a_readable_amount(app: QApplication) -> None:
    parent = Page(lambda: None)
    dialog = ItemDialog(parent, _item(description="PADARIA", amount=Decimal("12.00")))
    assert dialog.amount.text() == "12,00"
    with pytest.raises(DomainError, match="motivo"):
        dialog.validate()
    dialog.reason.setText("nota fiscal")
    dialog.amount.setText("doze")
    with pytest.raises(DomainError, match="Valor inválido"):
        dialog.validate()


def test_choosing_the_document_account_is_one_undo_step(window: MainWindow, tmp_path: Path) -> None:
    f = with_family(window, tmp_path)
    page, batch_id = _review(window, f, "LOJA A")
    steps = undo_steps(window)
    select_combo(page.target, ("account", f.joint))
    page._change_target()
    assert window.session is not None
    assert pipeline.batches(window.session.ledger)[batch_id].account_id == f.joint
    assert undo_steps(window) == steps + 1


def test_picking_a_category_in_the_row_offers_a_rule(window: MainWindow, tmp_path: Path) -> None:
    f = with_family(window, tmp_path)
    page, batch_id = _review(window, f, "PADARIA DOCE LAR")
    page.create_rule()  # nothing selected yet
    assert message(window) == "Selecione um item para criar a regra a partir dele."

    combo = page.items.cellWidget(0, 5)
    assert isinstance(combo, QComboBox)
    select_combo(combo, f.joint)  # an account, not a category: nothing to learn
    assert page.rule_offer.isHidden()
    combo = page.items.cellWidget(0, 5)  # rebuilt by the refresh
    assert isinstance(combo, QComboBox)
    select_combo(combo, f.groceries)
    [item] = pipeline.items_of(f.ledger, batch_id)
    assert item.target_account_id == f.groceries
    assert not page.rule_offer.isHidden() and "Alimentação" in page.rule_offer_text.text()
    page._dismiss_rule_offer()
    assert page.rule_offer.isHidden()


def test_approving_a_divergent_bill_needs_a_documented_reason(
    window: MainWindow, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    f = with_family(window, tmp_path)
    assert window.session is not None
    batch = pipeline.import_document(
        window.session, ImportRequest("fatura.pdf", docs.nubank_card_pdf(total="9.999,00"))
    )
    pipeline.set_batch_target(f.ledger, batch.id, None, f.card)
    page = page_of(window, ImportPage)
    window.navigate("import")
    page.batch_id = batch.id
    page.refresh()
    cell = page.batches.item(0, 1)
    assert cell is not None and cell.text().endswith(" · total divergente")
    reasons: list[str | None] = [None, "conferido no app do banco"]
    asked: list[str] = []
    monkeypatch.setattr(
        "opesvault.ui.pages.imports.review.ask_reason", lambda _p, title: asked.append(title) or reasons.pop(0)
    )
    page.approve_all()
    assert all(i.status is not ItemStatus.APPROVED for i in pipeline.items_of(f.ledger, batch.id))
    page.approve_all()
    assert asked == ["Total divergente — aceitar como pendência documentada"] * 2
    approved = [i for i in pipeline.items_of(f.ledger, batch.id) if i.status is ItemStatus.APPROVED]
    assert approved and message(window).startswith(f"{len(approved)} operação(ões)")


def test_keyboard_review_acts_on_the_item_and_moves_to_the_next(
    window: MainWindow, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    f = with_family(window, tmp_path)
    page, batch_id = _review(window, f, "LOJA A", "LOJA B", "LOJA C")
    reasons: list[str | None] = ["só esta compra", None, "não é nossa"]
    monkeypatch.setattr("opesvault.ui.pages.imports.review.ask_reason", lambda _p, _t: reasons.pop(0))

    def item_at(row: int) -> UUID:
        cell = page.items.item(row, 0)
        assert cell is not None
        return cell.data(Qt.ItemDataRole.UserRole)

    def status(item_id: UUID) -> ItemStatus:
        return pipeline.items(f.ledger)[item_id].status

    page.items.selectRow(0)
    first = item_at(0)
    page.approve_selected()  # a partial approval asks why
    assert status(first) is ItemStatus.APPROVED and page.items.currentRow() == 1
    second = item_at(1)
    page.reject()  # no reason given: nothing happens
    assert status(second) is ItemStatus.READY
    page.reject()
    assert status(second) is ItemStatus.REJECTED and page.items.currentRow() == 2
    statuses = sorted(i.status.value for i in pipeline.items_of(f.ledger, batch_id))
    assert statuses == sorted([ItemStatus.APPROVED.value, ItemStatus.REJECTED.value, ItemStatus.READY.value])


def test_correcting_an_item_records_each_changed_field(
    window: MainWindow, boxes: list[Box], tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    f = with_family(window, tmp_path)
    page, batch_id = _review(window, f, "PADARIA")
    amounts = iter(["12,50", "-5,00"])

    def fill(dialog: ItemDialog) -> int:
        dialog.description.setText("PADARIA CENTRAL")
        dialog.amount.setText(next(amounts))
        dialog.reason.setText("nota fiscal")
        return 1

    monkeypatch.setattr(ItemDialog, "exec", fill)
    page.items.selectRow(0)
    page.correct()
    [item] = pipeline.items_of(f.ledger, batch_id)
    assert item.description == "PADARIA CENTRAL" and item.amount == Decimal("12.50")
    assert {c.field for c in item.corrections} == {"description", "amount"}
    assert {c.reason for c in item.corrections} == {"nota fiscal"}

    page.items.selectRow(0)
    page.correct()  # a signed amount is refused, nothing changes
    assert boxes == [("warning", "OpesVault", "Informe o valor sem sinal; o tipo indica a direção.")]
    [same] = pipeline.items_of(f.ledger, batch_id)
    assert same.amount == Decimal("12.50") and len(same.corrections) == 2


def test_a_protected_pdf_asks_for_its_password_once(
    window: MainWindow, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    with_family(window, tmp_path)
    page = page_of(window, ImportPage)
    window.navigate("import")
    first = tmp_path / "fatura.pdf"
    first.write_bytes(encrypted("AES-256"))
    second = tmp_path / "outra.pdf"
    second.write_bytes(encrypted("AES-128"))
    prompts: list[str] = []
    answers = iter([(PDF_PASSWORD, True), ("", False)])
    monkeypatch.setattr(QInputDialog, "getText", lambda *a, **_k: prompts.append(a[2]) or next(answers))
    page.import_paths([first, second])
    assert window.busy and not page.isEnabled()
    wait(window)
    assert not window.busy and page.isEnabled()
    assert len(prompts) == 2 and "fatura.pdf" in prompts[0] and "outra.pdf" in prompts[1]
    assert window.session is not None
    [batch] = pipeline.batches(window.session.ledger).values()  # the cancelled one stored nothing
    assert batch.status is BatchStatus.IN_REVIEW and page.batch_id == batch.id
    assert [d.meta.original_name for d in window.session.documents] == ["fatura.pdf"]


def test_import_failures_are_reported_per_file(
    window: MainWindow, boxes: list[Box], tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    f = with_family(window, tmp_path)
    _review(window, f, "LOJA A")
    page = page_of(window, ImportPage)
    again = tmp_path / "extrato.csv"
    again.write_bytes(_statement("LOJA A"))
    page.import_paths([again])
    wait(window)
    assert boxes[-1][0] == "information" and boxes[-1][2].startswith("extrato.csv: Este arquivo já foi importado")

    monkeypatch.setattr("opesvault.diagnostics.record", lambda *_a: None)

    def broken(*_a: object, **_k: object) -> None:
        raise RuntimeError("falha interna")

    monkeypatch.setattr(pipeline, "import_document", broken)
    other = tmp_path / "novo.csv"
    other.write_bytes(_statement("LOJA Z"))
    page.import_paths([other])
    wait(window)
    assert boxes[-1] == ("warning", "Importação", "novo.csv: falha ao processar o arquivo.")


def test_dropping_files_imports_the_supported_ones(window: MainWindow, tmp_path: Path) -> None:
    f = with_family(window, tmp_path)
    page = page_of(window, ImportPage)
    statement = tmp_path / "solto.csv"
    statement.write_bytes(_statement("LOJA SOLTA"))
    photo = tmp_path / "foto.png"
    photo.write_bytes(b"\x89PNG")
    mime = QMimeData()
    mime.setUrls([QUrl.fromLocalFile(str(statement)), QUrl.fromLocalFile(str(photo))])
    assert ImportPage._dropped_paths(mime) == [statement]

    buttons, modifiers = Qt.MouseButton.LeftButton, Qt.KeyboardModifier.NoModifier
    enter = QDragEnterEvent(QPoint(1, 1), Qt.DropAction.CopyAction, mime, buttons, modifiers)
    enter.ignore()
    page.dragEnterEvent(enter)
    assert enter.isAccepted()
    page.dropEvent(QDropEvent(QPointF(1, 1), Qt.DropAction.CopyAction, mime, buttons, modifiers))
    wait(window)
    names = [d.meta.original_name for d in window.session.documents] if window.session else []
    assert names == ["solto.csv"] and page.batch_id is not None
    assert pipeline.batches(f.ledger)[page.batch_id].status is BatchStatus.IN_REVIEW


def test_choosing_a_layout_reads_the_document_again(
    window: MainWindow, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    f = with_family(window, tmp_path)
    assert window.session is not None
    data = encrypted("AES-128")
    batch = pipeline.import_document(
        window.session, ImportRequest("fatura.pdf", data, password=PDF_PASSWORD, parser_id="nubank-cartao-pdf")
    )
    pipeline.batches(f.ledger)[batch.id] = batch.model_copy(update={"status": BatchStatus.AMBIGUOUS})
    page = page_of(window, ImportPage)
    window.navigate("import")
    page.batch_id = batch.id
    page.refresh()
    assert not page.layout_row.isHidden() and page.layout_choice.isEnabled()
    select_combo(page.layout_choice, "nubank-cartao-pdf")
    answers = iter([("", False), (PDF_PASSWORD, True)])
    monkeypatch.setattr(QInputDialog, "getText", lambda *_a, **_k: next(answers))
    page._choose_layout()  # the password was never kept: asked again, and cancelled
    assert pipeline.batches(f.ledger)[batch.id].status is BatchStatus.AMBIGUOUS
    page._choose_layout()
    redone = pipeline.batches(f.ledger)[page.batch_id]  # type: ignore[index]
    assert redone.status is BatchStatus.IN_REVIEW and page.layout_row.isHidden()


def test_local_ai_explains_when_it_cannot_help(
    window: MainWindow, boxes: list[Box], tmp_path: Path, ollama: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    from opesvault.ai.ollama import OllamaClient

    f = with_family(window, tmp_path)
    page, batch_id = _review(window, f, "LOJA A")
    page.suggest_ai()
    assert message(window) == "A assistência por IA está desligada ou sem modelo escolhido (Configurações)."

    update_settings(f.ledger, ai_enabled=True, ai_model="modelo-ausente:1b")
    monkeypatch.setattr(
        "opesvault.importing.ai_suggestions.client_from_settings",
        lambda _ledger: OllamaClient("modelo-ausente:1b", ollama),
    )
    page.refresh()
    assert not page.ai_button.isHidden()
    page.suggest_ai()
    assert not page.ai_row.isHidden()
    page.cancel_ai()
    assert page.ai_label.text() == "Cancelando ao fim do lote atual…"
    wait(window)
    kind, title, text = boxes[-1]
    assert (kind, title) == ("information", "IA local") and text.endswith("A revisão manual continua disponível.")
    assert page.ai_row.isHidden()

    [item] = pipeline.items_of(f.ledger, batch_id)
    pipeline.correct_item(f.ledger, item.id, "target_account_id", f.groceries)
    page.suggest_ai()
    assert message(window) == "IA local: nenhum item sem categoria neste documento."


def test_import_page_opens_alerts_coverage_and_evidence(
    window: MainWindow, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from opesvault.ui.coverage import CoverageDialog

    f = with_family(window, tmp_path)
    page, first = _review(window, f, "LOJA A")
    _, second = _review(window, f, "LOJA B")
    page.reveal(first)
    assert page.batch_id == first and second != first
    page.items.selectRow(0)
    assert page.viewer.image.text().startswith("Linha ")  # a structured file shows its source line
    shown: list[object] = []
    monkeypatch.setattr(CoverageDialog, "exec", lambda dialog: shown.append(dialog) or 0)
    page.show_coverage()
    assert len(shown) == 1


# ── ledger ───────────────────────────────────────────────


def _ledger_page(window: MainWindow) -> LedgerPage:
    page = page_of(window, LedgerPage)
    window.navigate("ledger")
    page.reset_filters()
    return page


def test_status_and_origin_filters_narrow_the_list(window: MainWindow, tmp_path: Path) -> None:
    f = with_family(window, tmp_path)
    kept = f.ledger.record_expense(f.bank, f.groceries, "10.00", date(2026, 1, 3), "Feira")
    gone = f.ledger.record_expense(f.bank, f.groceries, "20.00", date(2026, 1, 4), "Duplicada")
    f.ledger.cancel_operation(gone.id, "lançada duas vezes")
    page = _ledger_page(window)
    assert {op.id for op in page.model.ops} == {kept.id, gone.id}
    select_combo(page.filters.status, StatusFilter.ACTIVE)
    assert [op.id for op in page.model.ops] == [kept.id]
    select_combo(page.filters.status, StatusFilter.CANCELLED)
    assert [op.id for op in page.model.ops] == [gone.id]
    page.reset_filters()
    select_combo(page.filters.origin, OriginKind.MANUAL)
    assert {op.id for op in page.model.ops} == {kept.id, gone.id}
    select_combo(page.filters.origin, OriginKind.IMPORT)
    assert page.model.ops == [] and page.views.currentWidget() is page.empty
    assert page.empty.title.text() == "Nenhum lançamento com estes filtros"

    select_combo(page.filters.status, StatusFilter.CANCELLED)  # kept with the vault as enum values
    saved = page.filters.snapshot("Cancelados importados")
    assert (saved.status, saved.origin) == ("cancelled", "import")


def test_row_menu_and_inspector_toggle(window: MainWindow, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    f = with_family(window, tmp_path)
    f.ledger.record_expense(f.bank, f.groceries, "10.00", date(2026, 1, 3), "Feira")
    f.ledger.record_expense(f.bank, f.groceries, "12.00", date(2026, 1, 4), "Padaria")
    page = _ledger_page(window)
    page.table.resize(800, 400)
    menus: list[list[str]] = []

    class RecordedMenu(QMenu):
        """Records the commands instead of showing a modal menu."""

        def exec(self, *_args: object) -> None:  # type: ignore[override]
            menus.append([a.text() for a in self.actions()])

    monkeypatch.setattr("opesvault.ui.pages.ledger.page.QMenu", RecordedMenu)
    page._context_menu(page.table.visualRect(page.model.index(1, 0)).center())
    assert page.selected_ids() == [page.model.ops[1].id]  # right click selects the row it is on
    assert menus and menus[0][0].startswith("Corrigir…") and any(t.startswith("Cancelar lançamento") for t in menus[0])
    page._context_menu(QPoint(5, 390))  # below the rows: no menu
    assert len(menus) == 1

    def resized(width: int) -> None:
        page.resize(width, 600)
        page.resizeEvent(QResizeEvent(QSize(width, 600), QSize(width, 600)))

    resized(700)  # narrow: the table takes the room
    assert page.inspector.isHidden() and not page.details_button.isChecked()
    resized(1200)
    assert not page.inspector.isHidden() and page.details_button.isChecked()
    page.details_button.setChecked(False)
    page.toggle_inspector()
    assert page.inspector.isHidden()
    resized(1300)  # an explicit choice wins over the automatic one
    assert page.inspector.isHidden()
