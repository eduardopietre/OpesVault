"""The branches the other UI tests leave out: cancelled and failing dialogs, empty selections,
pages without a vault, and the less travelled flows of the ledger, goals, sharing, reports,
recurrences, investments, the setup wizard and the vault commands.

Pages are mounted alone over a real Session (`mount` from test_ui_pages): `changed()` seals an
undo step like the main window, and notices and navigation are recorded. Modal dialogs, menus,
`decide`/`confirm` and file pickers are answered by the test; vault work goes through the
development worker and the local AI through the fake Ollama.
"""

from collections.abc import Callable, Iterator
from datetime import date
from decimal import Decimal
from pathlib import Path
from types import SimpleNamespace
from typing import Any
from uuid import uuid4

import pytest
from PySide6.QtCore import QModelIndex, Qt, QThreadPool
from PySide6.QtWidgets import QApplication, QFileDialog, QInputDialog, QLineEdit, QMenu, QMessageBox

from opesvault.domain.ledger import DomainError, Ledger
from opesvault.domain.model import (
    AccountSubtype,
    AccountType,
    LedgerAccount,
    Operation,
    OperationKind,
    Posting,
    YearMonth,
)
from opesvault.session import Session
from opesvault.ui import theme
from opesvault.ui.common import select_combo
from opesvault.ui.main_window import MainWindow
from opesvault.vault.client import VaultClient

from .conftest import dev_worker_command
from .domain_fixtures import Family, category, family
from .test_ai import _statement
from .test_ui_pages import Mounted, answer_dialog, column, mount, select_row

TODAY = date.today()
Box = tuple[str, str]


@pytest.fixture(scope="module")
def app() -> QApplication:
    instance = QApplication.instance()
    app = instance if isinstance(instance, QApplication) else QApplication([])
    theme.apply_theme(app, dark=False)
    return app


@pytest.fixture
def env(app: QApplication, tmp_path: Path) -> tuple[Session, Family]:
    f = family()
    session = Session.new(tmp_path / "x.opesvault", "Teste")
    session.ledger = f.ledger
    session.undo_stack().seal()
    return session, f


@pytest.fixture
def boxes(monkeypatch: pytest.MonkeyPatch) -> list[Box]:
    """QMessageBox information/warning calls, recorded as (title, text) instead of shown."""
    shown: list[Box] = []

    def record(_parent: object, title: str, message: str, *_a: object, **_k: object) -> QMessageBox.StandardButton:
        shown.append((title, message))
        return QMessageBox.StandardButton.Ok

    monkeypatch.setattr(QMessageBox, "information", staticmethod(record))
    monkeypatch.setattr(QMessageBox, "warning", staticmethod(record))
    return shown


@pytest.fixture
def forms(monkeypatch: pytest.MonkeyPatch) -> Iterator[list[dict[str, object] | None]]:
    """Answers investment forms in order: a dict fills fields by key, None cancels."""
    from opesvault.ui.pages.investments.forms import Form

    from .test_ui_pages import set_field

    queue: list[dict[str, object] | None] = []

    def run(form: Form) -> bool:
        assert queue, f"unexpected form {form.windowTitle()!r}"
        values = queue.pop(0)
        if values is None:
            return False
        for key, value in values.items():
            set_field(form.fields[key], value)
        return True

    monkeypatch.setattr(Form, "exec", run)
    yield queue
    assert not queue, "every planned form was opened"


def exec_returns(
    monkeypatch: pytest.MonkeyPatch, cls: type, result: int, before: Callable[[Any], object] | None = None
):
    """`cls.exec` answers `result` without validating (a dialog accepted with bad data, or cancelled)."""
    opened: list[Any] = []

    def run(dialog: Any) -> int:
        opened.append(dialog)
        if before is not None:
            before(dialog)
        return result

    monkeypatch.setattr(cls, "exec", run)
    return opened


def seal(m: Mounted[Any]) -> None:
    """What the test built directly is not a user action: no undo step, then the page shows it."""
    m.session.undo_stack().seal()
    m.page.refresh()


# ── Livro financeiro: the model ─────────────────────


def test_period_ranges_end_today_and_start_where_the_name_says() -> None:
    from opesvault.ui.pages.ledger.model import period_range

    today = date(2026, 3, 15)
    assert period_range("this_month", today) == (date(2026, 3, 1), today)
    assert period_range("last_month", today) == (date(2026, 2, 1), date(2026, 2, 28))
    assert period_range("last_3", today) == (date(2026, 1, 1), today)
    assert period_range("this_year", today) == (date(2026, 1, 1), today)
    assert period_range("all", today) == (None, None)


def test_operations_model_roles_headers_and_sorting(app: QApplication) -> None:
    from opesvault.ui.pages.ledger.model import OperationsModel

    f = family()
    model = OperationsModel()
    assert model.data(model.index(0, 0)) is None  # no ledger yet
    kept = f.ledger.record_expense(f.bank, f.groceries, "10.00", date(2026, 1, 3), "Feira", notes="na rua")
    gone = f.ledger.record_expense(f.bank, f.groceries, "30.00", date(2026, 1, 2), "Duplicada")
    f.ledger.cancel_operation(gone.id, "duas vezes")
    model.reset(f.ledger, [f.ledger.operations[kept.id], f.ledger.operations[gone.id]])
    vertical = Qt.Orientation.Vertical
    horizontal = Qt.Orientation.Horizontal
    assert model.headerData(0, vertical) is None
    assert model.headerData(OperationsModel.AMOUNT, horizontal, Qt.ItemDataRole.TextAlignmentRole) == int(
        Qt.AlignmentFlag.AlignRight | Qt.AlignmentFlag.AlignVCenter
    )
    assert model.headerData(0, horizontal, Qt.ItemDataRole.ToolTipRole) is None
    description = model.index(0, OperationsModel.DESCRIPTION)
    assert model.data(description, Qt.ItemDataRole.ToolTipRole) == "na rua"
    assert model.data(description, Qt.ItemDataRole.UserRole) == kept.id
    assert model.data(description, Qt.ItemDataRole.ForegroundRole) is None  # an active row keeps its color
    assert model.data(model.index(1, 0), Qt.ItemDataRole.ForegroundRole) is not None  # cancelled: dimmed
    assert model.data(description, Qt.ItemDataRole.DecorationRole) is None
    assert model.data(model.index(1, OperationsModel.STATUS)) == "Cancelado"
    assert model.data(model.index(0, OperationsModel.COMPETENCE)) in ("—", "jan/2026")
    assert model.rowCount(description) == 0 and model.columnCount(description) == 0  # flat table

    model.sort(OperationsModel.STATUS)
    assert [op.id for op in model.ops] == [gone.id, kept.id]
    model.sort(OperationsModel.AMOUNT, Qt.SortOrder.DescendingOrder)
    assert [op.id for op in model.ops] == [gone.id, kept.id]
    model.sort(OperationsModel.DESCRIPTION)
    assert [op.description for op in model.ops] == ["Duplicada", "Feira"]
    model.sort(OperationsModel.COMPETENCE)
    model.sort(OperationsModel.DATE)
    assert [op.id for op in model.ops] == [gone.id, kept.id]


# ── Livro financeiro: the page ──────────────────────


def _ledger(env: tuple[Session, Family]) -> Any:
    from opesvault.ui.pages.ledger import LedgerPage

    m = mount(LedgerPage, env)
    m.page.reset_filters()
    return m


def _pick(page: Any, *ops: Operation) -> None:
    page.refresh()
    page.table.clearSelection()
    for op in ops:
        row = next(i for i, shown in enumerate(page.model.ops) if shown.id == op.id)
        if op is ops[0]:
            page.table.selectRow(row)
        else:
            page._select({op.id})


def test_row_commands_need_a_selection_and_a_vault(env: tuple[Session, Family], boxes: list[Box]) -> None:
    m = _ledger(env)
    f = m.family
    f.ledger.record_expense(f.bank, f.groceries, "10.00", date(2026, 2, 3), "Feira")
    seal(m)
    page = m.page
    page.table.selectionModel().clear()
    assert page._selected() is None and page.selected_ids() == []
    commands = [
        page.edit,
        page.edit_postings,
        page.reclassify_selected,
        page.tag_selected,
        page.attach_receipt,
        page.detail_income,
        page.name_merchant,
        page.mark_reviewed,
        page.request_reimbursement,
        page.reverse,
        page.cancel,
        page.show_history,
    ]
    for command in commands:
        command()
    assert not m.notices and not boxes and not m.sealed()

    document = uuid4()
    page.open_attachment(document)
    assert m.navigations == [("documents", document, False)]

    page.set_session(None)
    assert page.model.ops == [] and page.count.text() == "" and page.header.subtitle.text() == ""
    page.new_operation("expense")
    page.save_current_filter()
    page.delete_saved_filter(uuid4())
    page.apply_saved_filter(SimpleNamespace(name="x"))
    page.reveal(("tag", "Viagem"))
    for command in commands:
        command()
    assert page._selected() is None and not m.notices and not m.sealed()


def test_reclassify_dialog_asks_for_a_target_and_a_reason(env: tuple[Session, Family]) -> None:
    from opesvault.ui.pages.ledger.actions import ReclassifyDialog

    m = _ledger(env)
    dialog = ReclassifyDialog(m.page, m.ledger, 2)
    dialog.target.setCurrentIndex(-1)
    with pytest.raises(DomainError, match="categoria de destino"):
        dialog.validate()
    dialog.target.setCurrentIndex(0)
    with pytest.raises(DomainError, match="motivo"):
        dialog.validate()
    dialog.reason.setText("revisão")
    dialog.validate()


def test_correction_goes_to_the_full_editor_only_when_needed(
    env: tuple[Session, Family], monkeypatch: pytest.MonkeyPatch, boxes: list[Box]
) -> None:
    from opesvault.domain.search import StatusFilter
    from opesvault.ui.operation_edit import OperationEditDialog, SimpleEditDialog

    m = _ledger(env)
    f = m.family
    leisure = category(f.ledger, "Lazer")
    simple = f.ledger.record_expense(f.bank, f.groceries, "50.00", date(2026, 2, 3), "Mercado")
    split = f.ledger.record_expense(f.bank, [(f.groceries, "10.00"), (leisure, "5.00")], None, date(2026, 2, 4), "Dois")
    seal(m)
    page = m.page
    opened: list[str] = []
    monkeypatch.setattr(OperationEditDialog, "exec", lambda _d: opened.append("full") or 0)

    exec_returns(monkeypatch, SimpleEditDialog, 0, lambda _d: opened.append("simple"))
    _pick(page, simple)
    page.edit()  # cancelled: the full editor is not opened
    assert opened == ["simple"]

    exec_returns(monkeypatch, SimpleEditDialog, 1)
    monkeypatch.setattr(SimpleEditDialog, "apply", lambda _d: (_ for _ in ()).throw(DomainError("Mês fechado.")))
    page.edit()  # confirmed but refused by the domain: nothing recorded, the reason is shown
    assert boxes == [("OpesVault", "Mês fechado.")] and not m.sealed()

    def wants_full(dialog: SimpleEditDialog) -> None:
        dialog._open_full()  # "Corrigir partidas…" closes the simple form
        assert dialog.wants_full_editor and dialog.result() == 0

    exec_returns(monkeypatch, SimpleEditDialog, 0, wants_full)

    def fill_full(dialog: OperationEditDialog) -> int:
        dialog.description.setText("Mercado do bairro")
        dialog.reason.setText("nome no cupom")
        dialog._try_accept()
        return dialog.result()

    monkeypatch.setattr(OperationEditDialog, "exec", fill_full)
    page.edit()
    assert f.ledger.operations[simple.id].description == "Mercado do bairro"
    assert m.notices[-1] == "Lançamento corrigido. A versão anterior ficou no histórico." and len(m.sealed()) == 1

    monkeypatch.setattr(OperationEditDialog, "exec", lambda _d: opened.append("full") or 0)
    _pick(page, split)
    page.edit()  # a split has no simple form: straight to the postings
    assert opened[-1] == "full" and len(m.sealed()) == 1

    f.ledger.cancel_operation(split.id, "lançado errado")
    seal(m)
    select_combo(page.filters.status, StatusFilter.ALL)
    _pick(page, f.ledger.operations[split.id])
    page.edit_postings()
    assert m.notices[-1] == "Lançamento cancelado não pode ser corrigido."


def test_reclassification_reports_skipped_and_refused_operations(
    env: tuple[Session, Family], monkeypatch: pytest.MonkeyPatch, boxes: list[Box]
) -> None:
    from opesvault.domain.periods import close_month
    from opesvault.ui.pages.ledger.actions import ReclassifyDialog

    m = _ledger(env)
    f = m.family
    leisure = category(f.ledger, "Lazer")
    split = f.ledger.record_expense(f.bank, [(f.groceries, "10.00"), (leisure, "5.00")], None, date(2026, 2, 4), "Dois")
    closed = f.ledger.record_expense(f.bank, f.groceries, "8.00", date(2026, 1, 9), "Pão")
    close_month(f.ledger, YearMonth(year=2026, month=1), "conferido")
    seal(m)
    page = m.page

    _pick(page, split)
    exec_returns(monkeypatch, ReclassifyDialog, 0)
    page.reclassify_selected()  # cancelled
    exec_returns(monkeypatch, ReclassifyDialog, 1)
    page.reclassify_selected()  # accepted without a reason: the domain refuses
    assert boxes[-1] == ("OpesVault", "A reclassificação exige um motivo.") and not m.notices

    def to_leisure(dialog: ReclassifyDialog) -> None:
        select_combo(dialog.target, leisure)
        dialog.reason.setText("lazer")

    exec_returns(monkeypatch, ReclassifyDialog, 1, to_leisure)
    page.reclassify_selected()  # a split is kept as it is
    assert m.notices[-1] == "0 reclassificado(s), 1 mantido(s)." and not m.sealed()
    _pick(page, closed)
    page.reclassify_selected()  # a closed month refuses the change: said in a message with the reason
    title, text = boxes[-1]
    assert title == "Reclassificação" and text.startswith("0 reclassificado(s), 1 mantido(s).\n\nPão: ")
    assert not m.sealed()


def test_tags_receipts_merchants_and_reviews_that_change_nothing(
    env: tuple[Session, Family], monkeypatch: pytest.MonkeyPatch, boxes: list[Box], tmp_path: Path
) -> None:
    from opesvault.ui.planning_dialogs import ReimbursementDialog, TagDialog
    from opesvault.ui.tax_dialogs import IncomeDetailDialog

    m = _ledger(env)
    f = m.family
    op = f.ledger.record_expense(f.bank, f.groceries, "10.00", date(2026, 2, 3), "Feira")
    salary = f.ledger.record_income(f.bank, f.salary, "4000.00", date(2026, 2, 5), "Salário")
    seal(m)
    page = m.page
    _pick(page, op)

    exec_returns(monkeypatch, TagDialog, 0)
    page.tag_selected()

    def remove_missing(dialog: TagDialog) -> None:
        dialog.tag.setText("Viagem")
        select_combo(dialog.action, "remove")

    exec_returns(monkeypatch, TagDialog, 1, remove_missing)
    page.tag_selected()  # removing a tag nobody has changes nothing

    monkeypatch.setattr(QFileDialog, "getOpenFileName", staticmethod(lambda *_a, **_k: ("", "")))
    page.attach_receipt()  # no file chosen
    text_file = tmp_path / "nota.txt"
    text_file.write_text("não é imagem", encoding="utf-8")
    monkeypatch.setattr(QFileDialog, "getOpenFileName", staticmethod(lambda *_a, **_k: (str(text_file), "")))
    page.attach_receipt()
    assert boxes[-1] == ("OpesVault", "Anexe um PDF ou uma imagem (PNG ou JPEG).")

    monkeypatch.setattr(QInputDialog, "getText", staticmethod(lambda *_a, **_k: ("Feira livre", False)))
    page.name_merchant()  # cancelled

    page.mark_reviewed()
    assert len(m.sealed()) == 1  # the first review silences the warnings
    page.mark_reviewed()  # already reviewed: said, but nothing recorded
    assert m.notices[-1].startswith("1 lançamento(s) conferido(s)") and len(m.sealed()) == 1

    exec_returns(monkeypatch, ReimbursementDialog, 0)
    page.request_reimbursement()
    monkeypatch.setattr("opesvault.ui.pages.ledger.actions.ask_reason", lambda *_a: None)
    page.reverse()
    page.cancel()

    _pick(page, salary)
    exec_returns(monkeypatch, IncomeDetailDialog, 0)
    page.detail_income()  # cancelled
    assert len(m.sealed()) == 1 and f.ledger.operations[op.id].active


def test_saved_filters_menu_save_apply_and_delete(
    env: tuple[Session, Family], monkeypatch: pytest.MonkeyPatch, boxes: list[Box]
) -> None:
    from opesvault.domain.saved_filters import saved

    m = _ledger(env)
    f = m.family
    f.ledger.record_expense(f.bank, f.groceries, "10.00", date(2026, 2, 3), "Feira")
    seal(m)
    page = m.page
    menu = page.saved_filters.menu()
    assert menu is not None
    page._fill_saved_filters()
    assert [a.text() for a in menu.actions()] == ["Salvar filtro atual…"]  # nothing saved yet

    page.filters.period.setCurrentIndex(page.filters.period.count() - 1)  # custom: not kept
    page.save_current_filter()
    assert m.notices[-1] == "Período personalizado não é salvo. Escolha um período com nome."
    page.reset_filters()
    names = [("  ", True), ("Mercado", False), ("M" * 61, True), ("  Mercado  ", True)]
    monkeypatch.setattr(QInputDialog, "getText", staticmethod(lambda *_a, **_k: names.pop(0)))
    page.save_current_filter()  # blank
    page.save_current_filter()  # cancelled
    page.reveal(("filter", f.groceries, None))
    page.save_current_filter()  # too long for the vault: refused with a message (it used to raise)
    assert boxes == [("OpesVault", "Dados inválidos. Revise os campos.")]
    assert not saved(f.ledger) and not m.sealed()
    page.save_current_filter()
    [flt] = saved(f.ledger)
    assert flt.account_id == f.groceries
    assert m.notices[-1] == "Filtro “Mercado” salvo no cofre." and len(m.sealed()) == 1

    page._fill_saved_filters()
    texts = [a.text() for a in menu.actions()]
    assert texts[0] == "Salvar filtro atual…" and "Mercado" in texts
    page.reset_filters()
    next(a for a in menu.actions() if a.text() == "Mercado").trigger()
    assert page.filters.account.currentData() == f.groceries and m.notices[-1] == "Filtro “Mercado” aplicado."
    remove = next(a.menu() for a in menu.actions() if a.menu() is not None)
    remove.actions()[0].trigger()
    assert not saved(f.ledger) and m.notices[-1] == "Filtro excluído. Ctrl+Z desfaz." and len(m.sealed()) == 2


def test_month_reveals_and_selection_after_a_refresh(
    env: tuple[Session, Family], monkeypatch: pytest.MonkeyPatch
) -> None:
    from opesvault.ui.pages.ledger.model import MONTH_PERIOD

    m = _ledger(env)
    f = m.family
    feira = f.ledger.record_expense(f.bank, f.groceries, "10.00", date(2026, 2, 3), "Feira", member_id=f.bruno)
    f.ledger.record_expense(f.bank, f.groceries, "12.00", date(2026, 2, 4), "Padaria")
    seal(m)
    page = m.page
    assert page.focus_search()
    page.follow_month("fevereiro")  # not a month: ignored
    page.filters.period.setCurrentIndex(MONTH_PERIOD)
    page.follow_month(YearMonth(year=2025, month=7))
    assert page.views.currentWidget() is page.empty
    assert page.empty.title.text() == "Nenhum lançamento em julho de 2025"
    assert page.empty_action.text() == "Ver todo o período"
    page.follow_month(YearMonth(year=2026, month=2))
    assert len(page.model.ops) == 2

    page.reveal(("filter", None, YearMonth(year=2026, month=2), f.bruno))
    assert [op.id for op in page.model.ops] == [feira.id]
    page.reveal(("something else",))  # an unknown reference changes nothing
    assert [op.id for op in page.model.ops] == [feira.id]

    page.reset_filters()
    page.refresh()
    page._select({uuid4()})  # nothing of these on screen: no current row
    page.table.selectionModel().clear()
    page._select({feira.id})
    assert page._selected() is not None and page._selected().id == feira.id

    menus: list[list[str]] = []

    class RecordedMenu(QMenu):
        def exec(self, *_args: object) -> None:  # type: ignore[override]
            menus.append([a.text() for a in self.actions() if a.text()])

    monkeypatch.setattr("opesvault.ui.pages.ledger.page.QMenu", RecordedMenu)
    page.table.resize(800, 400)
    row = next(i for i, op in enumerate(page.model.ops) if op.id == feira.id)
    page._context_menu(page.table.visualRect(page.model.index(row, 0)).center())
    assert menus and page.selected_ids() == [feira.id]  # already selected: the selection stays


# ── Contas e cartões ────────────────────────────────


def test_page_tab_forwards_navigation(env: tuple[Session, Family]) -> None:
    from opesvault.ui.pages.accounts import AccountsPage

    m = mount(AccountsPage, env)
    tab = m.page.accounts_tab
    tab.navigate("ledger", ("filter", None, None), act=True)
    assert m.navigations == [("ledger", ("filter", None, None), True)]


def test_balance_check_says_whether_the_bank_agrees(
    env: tuple[Session, Family], monkeypatch: pytest.MonkeyPatch, boxes: list[Box]
) -> None:
    from opesvault.domain import balance_checks
    from opesvault.ui.dialogs import AccountDialog
    from opesvault.ui.pages.accounts import AccountsPage
    from opesvault.ui.planning_dialogs import BalanceCheckDialog

    m = mount(AccountsPage, env)
    f = m.family
    f.ledger.record_opening_balance(f.bank, "100.00", date(2026, 1, 1))
    seal(m)
    tab = m.page.accounts_tab
    select_row(tab.table, f.bank)

    def informed(value: str) -> Callable[[BalanceCheckDialog], None]:
        return lambda d: d.informed.setText(value)

    exec_returns(monkeypatch, BalanceCheckDialog, 0)
    tab.check_balance()  # cancelled
    exec_returns(monkeypatch, BalanceCheckDialog, 1, informed("cem"))
    tab.check_balance()  # unreadable: refused
    assert boxes and not m.sealed()
    exec_returns(monkeypatch, BalanceCheckDialog, 1, informed("100,00"))
    tab.check_balance()
    assert m.notices[-1] == "Saldo conferido: confere com o banco."
    exec_returns(monkeypatch, BalanceCheckDialog, 1, informed("90,00"))
    tab.check_balance()
    assert m.notices[-1] == "Saldo conferido: diferença de -R$ 10,00. Procure o lançamento."
    assert len(m.sealed()) == 2 and len(balance_checks.results(f.ledger, f.bank)) == 2
    assert tab.checks.rowCount() == 2

    def no_opening(d: AccountDialog) -> None:
        d.name.setText("Carteira")
        select_combo(d.subtype, AccountSubtype.CASH)

    answer_dialog(monkeypatch, AccountDialog, no_opening)
    tab.add()
    wallet = next(a for a in f.ledger.accounts.values() if a.name == "Carteira")
    assert not [op for op in f.ledger.operations.values() if any(p.account_id == wallet.id for p in op.postings)]
    exec_returns(monkeypatch, AccountDialog, 1)  # accepted without a name: refused by the build
    tab.add()
    assert len(m.sealed()) == 3

    tab.open_ledger()
    assert m.navigations[-1][0] == "ledger"
    tab.show_check(f.bank)
    assert tab.checks_section.expanded
    m.page.set_session(None)
    tab.add()
    tab.edit()
    tab.check_balance()
    assert len(m.sealed()) == 3


# ── Metas ───────────────────────────────────────────


def test_goal_dialog_builds_validates_and_edits(env: tuple[Session, Family], monkeypatch: pytest.MonkeyPatch) -> None:
    from opesvault.domain import goals
    from opesvault.ui.pages.goals_page import GoalDialog, GoalsPage

    m = mount(GoalsPage, env)
    f = m.family
    assert m.page.views.currentIndex() == 1  # empty state
    dialog = GoalDialog(m.page, m.ledger)
    with pytest.raises(DomainError, match="Informe o valor da meta"):
        dialog.validate()
    dialog.target.setText("10.000,00")
    with pytest.raises(DomainError, match="nome"):
        dialog.validate()

    def reserve(d: GoalDialog) -> None:
        d.name.setText("Reserva")
        d.target.setText("10.000,00")
        select_combo(d.kind, goals.GoalKind.ACCOUNTS)
        for i in range(d.accounts.count()):
            item = d.accounts.item(i)
            if item.data(Qt.ItemDataRole.UserRole) == f.savings:
                item.setCheckState(Qt.CheckState.Checked)
        d.deadline.set_value(date(2027, 12, 31))

    answer_dialog(monkeypatch, GoalDialog, reserve)
    m.page.add_goal()
    [goal] = goals.goals(m.ledger)
    assert goal.account_ids == (f.savings,) and goal.target_date == date(2027, 12, 31)
    assert m.notices == ["Meta criada."] and m.page.views.currentIndex() == 0
    assert m.page.panel.isVisibleTo(m.page)

    answer_dialog(monkeypatch, GoalDialog, lambda d: select_combo(d.kind, goals.GoalKind.NET_WORTH))
    m.page.edit_goal()
    edited = goals.goals(m.ledger)[0]
    assert edited.kind is goals.GoalKind.NET_WORTH and edited.account_ids == () and edited.id == goal.id

    answers = [None, "não é prioridade agora", "voltou"]
    monkeypatch.setattr("opesvault.ui.pages.goals_page.ask_reason", lambda *_a: answers.pop(0))
    m.page.toggle_archived()  # no reason: nothing
    m.page.toggle_archived()
    assert goals.goals(m.ledger)[0].archived and column(m.page.table, 0) == ["Reserva (arquivada)"]
    assert m.page.header.subtitle.text() == "0 meta(s) ativa(s)"
    m.page.toggle_archived()
    assert not goals.goals(m.ledger)[0].archived and len(m.sealed()) == 4

    m.page.set_session(None)
    m.page.add_goal()
    m.page.edit_goal()
    m.page.toggle_archived()
    assert m.page.table.rowCount() == 0 and len(m.sealed()) == 4


# ── Reembolsos e acertos ────────────────────────────


def test_sharing_receives_denies_and_settles(env: tuple[Session, Family], monkeypatch: pytest.MonkeyPatch) -> None:
    from opesvault.domain import sharing
    from opesvault.ui.pages.sharing_page import SharingPage
    from opesvault.ui.planning_dialogs import ReceiveDialog, SettlementDialog

    _, f = env
    health = category(f.ledger, "Saúde")
    f.ledger.record_expense(f.bank, f.groceries, "60.00", date(2026, 3, 2), "Mercado do Bruno", member_id=f.bruno)
    visit = f.ledger.record_expense(f.bank, health, "200.00", date(2026, 3, 5), "Consulta")
    exam = f.ledger.record_expense(f.bank, health, "90.00", date(2026, 3, 6), "Exame")
    sharing.request(f.ledger, visit.id, "Plano", "150.00")
    sharing.request(f.ledger, exam.id, "Plano", "90.00")
    m = mount(SharingPage, env)
    page = m.page
    assert column(page.balances, 0) == ["Bruno"] and column(page.balances, 1) == ["Ana"]
    assert column(page.shares, 1) == ["Mercado do Bruno"]
    assert page.header.subtitle.text() == "2 reembolso(s) a receber · 1 acerto(s) pendente(s)"

    select_row(
        page.reimbursements, next(r.id for r in sharing.reimbursements(f.ledger).values() if r.operation_id == visit.id)
    )
    answer_dialog(monkeypatch, ReceiveDialog, lambda _d: None)  # the missing amount is suggested
    page.receive()
    assert m.notices[-1] == "Reembolso recebido: a despesa líquida foi reduzida."
    assert "Recebido" in column(page.reimbursements, 5)

    select_row(
        page.reimbursements, next(r.id for r in sharing.reimbursements(f.ledger).values() if r.operation_id == exam.id)
    )
    reasons = [None, "fora da cobertura"]
    monkeypatch.setattr("opesvault.ui.pages.sharing_page.ask_reason", lambda *_a: reasons.pop(0))
    page.deny()
    page.deny()
    assert not sharing.open_items(f.ledger) and len(m.sealed()) == 2
    page.refresh()  # the selected pair stays selected
    assert column(page.shares, 1) == ["Mercado do Bruno"]

    select_row(
        page.reimbursements, next(r.id for r in sharing.reimbursements(f.ledger).values() if r.operation_id == exam.id)
    )
    page.open_reimbursed()
    assert m.navigations[-1] == ("ledger", ("filter", None, (date(2026, 3, 6), date(2026, 3, 6))), False)

    answer_dialog(monkeypatch, SettlementDialog, lambda _d: None)  # who owes whom and how much come filled
    page.settle()
    assert m.notices[-1] == "Acerto registrado." and not sharing.balances(f.ledger)
    assert page.history.rowCount() == 1 and len(m.sealed()) == 3
    assert page.header.subtitle.text() == ""

    page.set_session(None)
    page.settle()
    page.receive()
    assert len(m.sealed()) == 3


# ── Relatórios ──────────────────────────────────────


def _reports(env: tuple[Session, Family]) -> Any:
    from opesvault.ui.pages.reports_page import ReportsPage

    m = mount(ReportsPage, env)
    m.page.resize(900, 600)
    m.page.show()  # the filter counts only while visible to the page
    m.page.follow_month(YearMonth(year=2026, month=3))
    return m


def test_tags_comparison_and_deductibles_lead_to_the_ledger(env: tuple[Session, Family]) -> None:
    from opesvault.charts.data import Point
    from opesvault.domain import tags
    from opesvault.domain.deductibles import DeductibleKind, mark
    from opesvault.ui.pages.reports_page import _uuid, deductibles_chart

    _, f = env
    health = category(f.ledger, "Saúde")
    mark(f.ledger, health, DeductibleKind.HEALTH)
    trip = f.ledger.record_expense(f.bank, f.groceries, "70.00", date(2026, 3, 9), "Feira", member_id=f.ana)
    tags.add_tag(f.ledger, [trip.id], "Viagem")
    f.ledger.record_expense(f.bank, health, "300.00", date(2026, 2, 10), "Consulta", member_id=f.ana)
    f.ledger.record_expense(f.bank, health, "100.00", date(2026, 2, 11), "Farmácia")
    m = _reports(env)
    page = m.page

    page.reveal("tags")
    page.inspect("Marcadores", Point("Viagem", Decimal("70.00")))
    assert page._ledger_ref() == ("tag", "Viagem") and page.open_ledger.isEnabled()
    select_combo(page.scope, "Viagem")
    page.inspect("Viagem", Point("2026-03", Decimal("70.00")))
    assert page._ledger_ref() == ("tag", "Viagem")

    page.reveal("comparison")
    page.inspect("Despesas", Point("Alimentação", Decimal("70.00")))
    assert page._ledger_ref() == ("filter", f.groceries, YearMonth(year=2026, month=3))
    page.inspect("Despesas", Point("Sem categoria", Decimal("1")))
    assert page._ledger_ref() is None

    page.reveal("deductibles")
    assert page._subtitle() and page.scope.currentData() == 2026
    page.follow_month(YearMonth(year=2027, month=1))  # a year filter is rebuilt for the new month
    assert page.scope.currentData() == 2027
    select_combo(page.scope, 2026)
    chart = page.panel.data
    assert chart is not None and {s.name for s in chart.series} == {"Ana", "Sem integrante"}
    point = chart.series[0].points[0]
    page.inspect(chart.series[0].name, point)
    page._open_ledger()
    assert m.navigations[-1] == ("ledger", ("filter", health, (date(2026, 1, 1), date(2026, 12, 31)), None), False)
    page.inspect("Ana", Point("x", Decimal("1")))  # a point without its category
    assert page._ledger_ref() is None
    page.inspect("Ana", Point("x", Decimal("1"), {"_categoria": "não é id"}))
    assert page._ledger_ref() == ("filter", None, (date(2026, 1, 1), date(2026, 12, 31)), None)
    assert _uuid("não é id") is None and _uuid(str(health)) == health
    assert deductibles_chart(f.ledger, 2025).series == []

    page.reveal("annual")
    assert page._subtitle() and not page.year_pdf.isHidden()


def test_annual_report_pdf_is_generated_only_when_confirmed(
    env: tuple[Session, Family], monkeypatch: pytest.MonkeyPatch
) -> None:
    m = _reports(env)
    page = m.page
    page.reveal("annual")
    saved: list[str] = []
    answers = [False, True]

    def save_pdf(_parent: object, suggested: str, build: Callable[[], str]) -> bool:
        saved.append(suggested)
        assert "<" in build()  # the report itself is HTML
        return answers.pop(0)

    monkeypatch.setattr("opesvault.ui.pdf_export.save_pdf", save_pdf)
    page.export_year()
    assert not m.notices
    select_combo(page.scope, 2025)
    page.export_year()
    assert saved == ["fechamento-2026.pdf", "fechamento-2025.pdf"] and m.notices == ["Fechamento de 2025 gerado."]
    page.set_session(None)
    page.export_year()
    assert len(saved) == 2


# ── Recorrências ────────────────────────────────────


def _monthly_charges(m: Mounted[Any], amount: str = "39.90", months: int = 3) -> None:
    last = YearMonth.of(TODAY).add(-1)
    for back in range(months):
        month = last.add(-back)
        m.ledger.record_expense(
            m.family.bank, m.family.groceries, amount, month.first_day().replace(day=12), "STREAMING"
        )
    seal(m)


def test_recurrence_from_charges_that_repeat(env: tuple[Session, Family], monkeypatch: pytest.MonkeyPatch) -> None:
    from opesvault.domain.recurrence import rules
    from opesvault.ui.pages.recurrences_page import RecurrencesPage, RuleDialog

    m = mount(RecurrencesPage, env)
    m.page.create_from_candidate()  # nothing selected
    _monthly_charges(m)
    page = m.page
    assert column(page.candidates, 0) == ["STREAMING"] and page.views.currentIndex() == 0  # shown before any rule
    page.candidates.selectRow(0)
    answer_dialog(monkeypatch, RuleDialog, None)
    page.create_from_candidate()  # cancelled
    assert not rules(m.ledger)
    opened = answer_dialog(monkeypatch, RuleDialog, lambda _d: None)  # filled from the charges
    page.create_from_candidate()
    assert opened[0].description.text() == "STREAMING" and opened[0].day.value() == 12
    [rule] = rules(m.ledger).values()
    assert rule.amount == Decimal("39.90") and rule.account_id == m.family.bank
    assert m.notices[-1] == "Recorrência criada a partir das cobranças repetidas." and len(m.sealed()) == 1

    empty = RuleDialog(page, Ledger.new("Sem contas"))
    empty.description.setText("Escola")
    empty.amount.setText("10,00")
    with pytest.raises(DomainError, match="Cadastre contas"):
        empty.validate()


def test_a_price_change_is_shown_and_revealed(
    env: tuple[Session, Family], monkeypatch: pytest.MonkeyPatch, boxes: list[Box]
) -> None:
    from opesvault.domain.recurrence import ForecastStatus, RecurrenceRule, add_rule, realize
    from opesvault.ui.pages.recurrences_page import RecurrencesPage

    m = mount(RecurrencesPage, env)
    f = m.family
    rule = add_rule(
        m.ledger,
        RecurrenceRule(
            description="Internet",
            account_id=f.bank,
            counterpart_id=f.groceries,
            amount=Decimal("100.00"),
            day=5,
            start=YearMonth.of(TODAY).add(-2).first_day(),
        ),
    )
    seal(m)
    page = m.page
    late = [x for x in page._forecasts if x.status is ForecastStatus.LATE]
    paid = m.ledger.record_expense(f.bank, f.groceries, "130.00", late[0].due_on, "Internet")
    realize(m.ledger, rule.id, late[0].due_on, paid.id)
    seal(m)
    assert column(page.commitments, 5) == ["Valor mudou"]

    page.commitments_section.set_expanded(False)
    page.reveal(("rule", rule.id))
    assert page.commitments_section.expanded and page.rules.currentRow() == 0

    other = late[1] if len(late) > 1 else late[0]
    page.forecast_table.clearSelection()
    page.reveal((rule.id, other.due_on))  # without act: only selected
    chosen = page._selected_forecast()
    assert chosen is not None and chosen.due_on == other.due_on
    page.reveal((uuid4(), other.due_on))  # a forecast no longer listed: nothing

    def refused(*_a: object) -> object:
        raise DomainError("recusado")

    monkeypatch.setattr("opesvault.ui.pages.recurrences_page.update_rule", refused)
    select_row(page.rules, rule.id)
    page.toggle()
    monkeypatch.setattr("opesvault.ui.pages.recurrences_page.skip", refused)
    page.skip_selected()
    m.ledger.record_expense(f.bank, f.groceries, "100.00", other.due_on, "Internet de novo")
    seal(m)
    page.reveal((rule.id, other.due_on))
    monkeypatch.setattr("opesvault.ui.pages.recurrences_page.realize", refused)
    monkeypatch.setattr(QInputDialog, "getItem", staticmethod(lambda _p, _t, _l, labels, *_a: (labels[0], True)))
    page.link_selected()
    monkeypatch.setattr("opesvault.ui.pages.recurrences_page.confirm", lambda *_a: True)
    page.link_suggestions()
    assert boxes and not m.sealed()


# ── Investimentos ───────────────────────────────────


def test_investment_commands_without_a_position_or_a_vault(
    env: tuple[Session, Family], boxes: list[Box], forms: list[dict[str, object] | None]
) -> None:
    from opesvault.ui.pages.investments import InvestmentsPage

    m = mount(InvestmentsPage, env)
    page = m.page
    for command in (page.sell, page.opening, page.split, page.bonus, page.distribution, page.redemption, page.net_only):
        command()
    assert m.notices == ["Selecione um investimento."] * 7
    page.set_session(None)
    page.pay_tax()
    page.new_rule()
    assert not m.steps and not boxes


def test_quantity_valuation_and_refused_events(
    env: tuple[Session, Family],
    monkeypatch: pytest.MonkeyPatch,
    boxes: list[Box],
    forms: list[dict[str, object] | None],
) -> None:
    from opesvault.investments import service as inv
    from opesvault.investments.model import AssetClass, TaxRule, TaxRuleKind, TrackingMode, ValueNature
    from opesvault.ui.pages.investments import InvestmentsPage

    m = mount(InvestmentsPage, env)
    pos = inv.create_position(m.ledger, "Ações XYZ", AssetClass.STOCK, date(2026, 1, 2), mode=TrackingMode.QUANTITY)
    seal(m)
    page = m.page
    forms.append(
        {"on": date(2026, 3, 31), "value": "1.000,00", "nature": ValueNature.GROSS, "quantity": "10", "price": "100,00"}
    )
    page.new_valuation()
    [valuation] = inv.valuations_of(m.ledger, pos.id)
    assert valuation.quantity == Decimal("10") and valuation.unit_price == Decimal("100.00")
    assert len(m.sealed()) == 1

    select_row(page.detail.valuations, valuation.id)

    def refused(*_a: object) -> object:
        raise DomainError("Avaliação já usada.")

    monkeypatch.setattr("opesvault.investments.service.select_valuation", refused)
    page.use_valuation()
    assert boxes[-1] == ("OpesVault", "Avaliação já usada.") and len(m.sealed()) == 1

    m.ledger.put("tax_rule", TaxRule(name="IR", kind=TaxRuleKind.RATE_ON_POSITIVE_GAIN, rate=Decimal("0.15")))
    seal(m)
    forms.append({"on": date(2026, 3, 31), "gross": ""})
    page.simulate()  # no gross value: the simulation is refused, nothing shown as a result
    assert boxes[-1][0] == "OpesVault" and len(m.sealed()) == 1


# ── Registro de operações ───────────────────────────


def test_account_choices_label_subcategories_and_hide_unused_archived(app: QApplication) -> None:
    from opesvault.ui.operation_edit import OptionalDate, account_choices

    f = family()
    fair = f.ledger.add_account(
        LedgerAccount(name="Feira", type=AccountType.EXPENSE, subtype=AccountSubtype.CATEGORY, parent_id=f.groceries)
    )
    old = f.ledger.add_account(
        LedgerAccount(name="Conta antiga", type=AccountType.ASSET, subtype=AccountSubtype.CHECKING, archived=True)
    )
    labels = dict((value, label) for label, value in account_choices(f.ledger, set()))
    assert labels[fair.id] == "Despesa: Alimentação › Feira" and old.id not in labels
    assert old.id in {value for _, value in account_choices(f.ledger, {old.id})}  # kept when already used

    when = OptionalDate(date(2026, 1, 2))
    when.set_value(None)
    assert when.value() is None and not when.edit.isEnabled()


def test_full_editor_rows_balance_and_description(app: QApplication) -> None:
    from opesvault.ui.operation_edit import OperationEditDialog

    f = family()
    op = f.ledger.record_expense(f.bank, f.groceries, "50.00", date(2026, 2, 3), "Mercado")
    dialog = OperationEditDialog(None, f.ledger, op)
    assert dialog.balance.text() == "Equilibrada ✓"
    debit = dialog.postings.cellWidget(0, 1)
    assert isinstance(debit, QLineEdit) and debit.text() == "50,00"
    debit.setText("abc")
    assert dialog.balance.text() == "Valor ilegível"
    dialog.add_row(None)
    dialog.postings.setCurrentCell(0, 0)
    dialog.remove_row()  # the current row
    assert dialog.postings.rowCount() == 2
    dialog.postings.setCurrentCell(-1, -1)
    dialog.remove_row()  # no current row: the last one
    assert dialog.postings.rowCount() == 1
    dialog.description.setText("  ")
    with pytest.raises(DomainError, match="descrição"):
        dialog.build()


def _simple(ledger: Ledger, op: Operation) -> Any:
    from opesvault.ui.operation_edit import SimpleEditDialog

    return SimpleEditDialog(None, ledger, op)


def test_simple_editor_for_each_kind_and_its_checks(app: QApplication) -> None:
    from opesvault.ui.operation_edit import is_simple

    f = family()
    transfer = f.ledger.record_transfer(f.bank, f.savings, "100.00", date(2026, 2, 3))
    income = f.ledger.record_income(f.bank, f.salary, "4000.00", date(2026, 2, 5), "Salário")
    payment = f.ledger.add_operation(
        Operation(
            kind=OperationKind.CARD_PAYMENT,
            description="Pagamento da fatura",
            postings=(
                Posting(account_id=f.card_account, amount=Decimal("80")),
                Posting(account_id=f.bank, amount=Decimal("-80")),
            ),
            occurred_on=date(2026, 2, 10),
            settled_on=date(2026, 2, 10),
        )
    )
    assert all(is_simple(f.ledger, op) for op in (transfer, income, payment))
    reversal = f.ledger.reverse_operation(transfer.id, date(2026, 2, 4), "errado")
    assert not is_simple(f.ledger, reversal)  # not a day-to-day kind
    lopsided = transfer.model_copy(update={"postings": (transfer.postings[0], transfer.postings[0])})
    assert not is_simple(f.ledger, lopsided)

    dialog = _simple(f.ledger, transfer)
    assert dialog.form.rowCount() == 8  # no competence or member for a transfer
    assert not dialog.wants_full_editor
    with pytest.raises(DomainError, match="motivo"):
        dialog.validate()
    dialog.reason.setText("conferido")
    with pytest.raises(DomainError, match="Nada foi alterado"):
        dialog.validate()
    dialog.description.setText("")
    with pytest.raises(DomainError, match="descrição"):
        dialog.build()
    dialog.description.setText("Para a poupança")
    dialog.amount.setText("0")
    with pytest.raises(DomainError, match="valor positivo"):
        dialog.build()
    dialog.amount.setText("100,00")
    select_combo(dialog.debit, f.bank)
    with pytest.raises(DomainError, match="contas diferentes"):
        dialog.build()

    paid = _simple(f.ledger, payment)
    assert not paid.debit.isEnabled() and paid.credit.isEnabled()  # the card stays; the paying account may change
    earned = _simple(f.ledger, income)
    assert earned.form.rowCount() == 10

    f.ledger.update_account(f.ledger.accounts[f.savings].model_copy(update={"archived": True}), "encerrada")
    kept = _simple(f.ledger, f.ledger.operations[transfer.id])
    assert kept.debit.currentData() == f.savings  # an account no longer offered is still shown


# ── Configuração inicial ────────────────────────────


def test_setup_wizard_pages_report_problems(app: QApplication, boxes: list[Box]) -> None:
    from opesvault.ui.setup_wizard import FinishPage, SetupWizard

    f = family()
    wizard = SetupWizard(None, f.ledger)
    assert "Ana" in wizard.members_page.names.placeholderText()
    accounts = wizard.accounts_page
    accounts.initializePage()
    accounts.holders[0].setChecked(True)
    accounts.initializePage()  # again: the old boxes go, the checked ones stay checked
    assert accounts.holders[0].isChecked()

    accounts.name.setText("Conta nova")
    accounts.balance.setText("cem")
    assert not accounts.add_current() and accounts.error.text()
    assert wizard.cards_page._payers() == [a.name for a in f.ledger.accounts.values() if a.is_liquid]
    wizard.finish_page.initializePage()
    assert wizard.finish_page.summary.text().startswith("Revise as etapas anteriores:")
    accounts.balance.clear()
    assert accounts.add_current()
    accounts.name.setText("conta NOVA")
    assert not accounts.add_current() and accounts.error.text() == "A conta conta NOVA já está na lista."
    accounts.name.clear()
    accounts.table.setCurrentCell(0, 0)
    accounts.remove_selected()
    assert accounts.planned == []
    accounts.remove_selected()  # nothing left: nothing happens

    cards = wizard.cards_page
    cards.add_row()  # left without a name: not a card
    assert cards.cards() == []

    wizard.members_page.names.setPlainText("Ana")  # already a member
    assert not wizard.finish_page.validatePage()
    assert boxes[-1] == ("Assistente", "Há integrantes com o mesmo nome.")
    wizard.members_page.names.setPlainText("Lia")
    assert wizard.finish_page.validatePage()

    alone = FinishPage()  # outside a wizard it says nothing and lets go
    alone.initializePage()
    assert alone.summary.text() == "" and alone.validatePage()
    wizard.deleteLater()


# ── Gráficos com tabela de valores ──────────────────


def test_chart_panel_rows_clicks_and_export(app: QApplication, monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    from opesvault.charts.data import Chart, Point, Series
    from opesvault.ui.chart_panel import ChartPanel, value_label

    assert value_label(Decimal("0.125"), "%") == "12,50%" and value_label(None, "%") == "—"
    inspected: list[tuple[str, Point]] = []
    panel = ChartPanel("teste/painel", lambda name, point: inspected.append((name, point)))
    panel.export_csv()  # nothing shown: nothing to export
    first, second = Point("2026-01", Decimal("10")), Point("2026-02", Decimal("20"))
    panel.show_chart(Chart("Saídas", "BRL", [Series("Saídas", [first, second])]))
    labels = column(panel.table, 0)
    assert labels[:2] == ["jan/2026", "fev/2026"] and "Total" in labels

    panel._row_clicked(99)  # outside the table
    panel._row_clicked(labels.index("Total"))  # a summary row points at nothing
    assert inspected == []
    panel._row_clicked(1)
    assert inspected == [("Saídas", second)]
    panel._chart_clicked("Saídas", first)
    assert panel.table.currentRow() == 0 and inspected[-1] == ("Saídas", first)
    panel._chart_clicked("Saídas", Point("2030-01", Decimal("1")))  # no row for it
    assert inspected[-1][1].x == "2030-01"
    quiet = ChartPanel("teste/sem-inspecao")  # nobody listening to the clicks
    quiet.show_chart(Chart("Saídas", "BRL", [Series("Saídas", [first])]))
    quiet._chart_clicked("Saídas", first)
    assert quiet.table.currentRow() == 0

    target = tmp_path / "valores.csv"
    paths = ["", str(target), str(target)]
    monkeypatch.setattr(QFileDialog, "getSaveFileName", staticmethod(lambda *_a, **_k: (paths.pop(0), "")))
    answers = [False, True]
    monkeypatch.setattr("opesvault.ui.chart_panel.confirm", lambda *_a: answers.pop(0))
    panel.export_csv()  # no file chosen
    panel.export_csv()  # refused
    assert not target.exists()
    panel.export_csv()
    assert target.read_bytes() == panel.csv_bytes() and b"2026-01;10" in target.read_bytes()


# ── Assistência local por IA ────────────────────────


@pytest.fixture
def shell(app: QApplication, monkeypatch: pytest.MonkeyPatch, dev_worker_env: None) -> Iterator[MainWindow]:
    from .test_ui_shell import Answers

    for kind in ("information", "warning", "critical"):
        monkeypatch.setattr(QMessageBox, kind, staticmethod(lambda *_a, **_k: QMessageBox.StandardButton.Ok))
    monkeypatch.setattr("opesvault.ui.shell.vault.decide", Answers("cancel"))
    monkeypatch.setattr("opesvault.ui.shell.vault.confirm", Answers(False))
    win = MainWindow()
    win.client = VaultClient(dev_worker_command())
    yield win
    _wait(win)
    win._drop_session()


def _wait(window: MainWindow) -> None:
    for _ in range(4):
        QThreadPool.globalInstance().waitForDone(15000)
        for _ in range(20):
            QApplication.processEvents()


def _with_family(window: MainWindow, tmp_path: Path) -> Family:
    f = family()
    session = Session.new(tmp_path / "x.opesvault", "Teste")
    session.ledger = f.ledger
    window.session = session
    window._refresh()
    return f


def _import_page(window: MainWindow, f: Family, *descriptions: str) -> tuple[Any, Any]:
    from opesvault.importing import pipeline
    from opesvault.importing.pipeline import ImportRequest
    from opesvault.ui.pages.imports import ImportPage

    assert window.session is not None
    batch = pipeline.import_document(
        window.session, ImportRequest("extrato.csv", _statement(*descriptions), account_id=f.bank)
    )
    window.session.undo_stack().seal()
    page = next(p for p in window.pages if isinstance(p, ImportPage))
    window.navigate("import")
    page.batch_id = batch.id
    page.refresh()
    return page, batch.id


def _synchronous_jobs(monkeypatch: pytest.MonkeyPatch) -> None:
    """The model is asked on the test thread, so its answer arrives before the next line."""
    from opesvault.ui.background import BackgroundJob

    monkeypatch.setattr(BackgroundJob, "start", lambda job: job.run())


def test_ai_answers_cancellations_and_failures_after_an_import(
    shell: MainWindow, tmp_path: Path, ollama: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    import json

    from opesvault.ai.ollama import OllamaClient
    from opesvault.domain.settings import update_settings
    from opesvault.importing import ai_suggestions, pipeline

    from .fake_ollama import FakeOllama

    f = _with_family(shell, tmp_path)
    _, first = _import_page(shell, f, "LOJA DE BRINQUEDO")
    page, batch_id = _import_page(shell, f, "LOJA DE ROUPA")
    assert page._ai_client() is None  # AI off
    update_settings(f.ledger, ai_enabled=True, ai_model="gpt-oss:120b-cloud")
    assert page._ai_client() is None  # a cloud model is never used
    update_settings(f.ledger, ai_enabled=True, ai_model="gemma4:12b")
    monkeypatch.setattr(ai_suggestions, "client_from_settings", lambda _l: OllamaClient("gemma4:12b", ollama))
    _synchronous_jobs(monkeypatch)

    # Two documents: the first is answered, the second gets an answer that is not JSON.
    FakeOllama.answers = [json.dumps({"suggestions": [{"index": 0, "category": "Alimentação"}]})]
    FakeOllama.answer = "não é json"
    assert shell.session is not None
    steps = len(shell.session.undo_stack().undo_steps)
    page._start_ai([first, batch_id], quiet=True)
    message = shell.statusBar().currentMessage()
    assert message == "IA local: 1 categoria(s) sugerida(s); 1 item(ns) sem resposta válida. Revise antes de aprovar."
    assert len(shell.session.undo_stack().undo_steps) == steps + 1  # one undo step for the whole answer
    assert page.ai_row.isHidden() and page._ai_job is None

    FakeOllama.answer = json.dumps({"suggestions": []})
    page._start_ai([batch_id], quiet=True)
    assert shell.statusBar().currentMessage() == "IA local: 0 categoria(s) sugerida(s)."
    assert len(shell.session.undo_stack().undo_steps) == steps + 1  # nothing new: no undo step

    real_ask = ai_suggestions.ask

    def cancelled(client: Any, requests: Any, *, on_progress: Any, cancel: Any) -> Any:
        cancel.set()
        on_progress(0, 1)
        return real_ask(client, requests, on_progress=on_progress, cancel=cancel)

    monkeypatch.setattr(ai_suggestions, "ask", cancelled)
    page._start_ai([batch_id], quiet=True)
    assert "consulta cancelada" in shell.statusBar().currentMessage()

    monkeypatch.setattr(ai_suggestions, "ask", real_ask)
    FakeOllama.missing_model = True
    page._start_ai([batch_id], quiet=True)  # after an import a failure goes to the status bar
    failure = shell.statusBar().currentMessage()
    assert failure.startswith("IA local: ") and "categoria(s)" not in failure
    FakeOllama.missing_model = False

    [pending] = [i for i in pipeline.items_of(f.ledger, batch_id) if i.target_account_id is None]
    pipeline.correct_item(f.ledger, pending.id, "target_account_id", f.groceries)
    shown = shell.statusBar().currentMessage()
    page._start_ai([batch_id], quiet=True)  # nothing left to ask, and quietly
    assert shell.statusBar().currentMessage() == shown

    page._ai_job = object()  # type: ignore[assignment]
    page.suggest_ai()  # a consultation is already running
    page._ai_job = None
    shell.session = None
    shell._refresh()
    assert page._ai_client() is None


def test_ai_answer_after_the_vault_closed_is_dropped(
    shell: MainWindow, tmp_path: Path, ollama: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    import json

    from opesvault.ai.ollama import OllamaClient
    from opesvault.domain.settings import update_settings
    from opesvault.importing import ai_suggestions, pipeline

    from .fake_ollama import FakeOllama

    f = _with_family(shell, tmp_path)
    page, batch_id = _import_page(shell, f, "LOJA DE BRINQUEDO")
    update_settings(f.ledger, ai_enabled=True, ai_model="gemma4:12b")
    monkeypatch.setattr(ai_suggestions, "client_from_settings", lambda _l: OllamaClient("gemma4:12b", ollama))
    FakeOllama.answer = json.dumps(
        {"suggestions": [{"index": 0, "category": "Alimentação"}, {"index": 1, "category": "Inventada"}]}
    )
    real_ask = ai_suggestions.ask

    def close_meanwhile(*args: Any, **kwargs: Any) -> Any:
        shell.session = None  # the user closed the vault while the model thought
        shell._refresh()
        return real_ask(*args, **kwargs)

    monkeypatch.setattr(ai_suggestions, "ask", close_meanwhile)
    _synchronous_jobs(monkeypatch)
    pending = {i.id for i in pipeline.items_of(f.ledger, batch_id) if i.target_account_id is None}
    assert len(pending) == 1
    page._start_ai([batch_id], quiet=False)
    assert page.ai_row.isHidden() and page._ai_job is None
    assert [i.target_account_id for i in pipeline.items_of(f.ledger, batch_id) if i.id in pending] == [None]


# ── Cofre: comandos ─────────────────────────────────


def _saved(path: Path) -> Session:
    client = VaultClient(dev_worker_command())
    session = Session.new(path, "Projeto Lima")
    frozen = session.freeze()
    session.mark_saved(frozen, client.save_frozen(frozen))
    return session


def _refuse_ledger(monkeypatch: pytest.MonkeyPatch) -> None:
    def refuse(*_a: object) -> Session:
        raise DomainError("Cofre de versão mais nova.")

    monkeypatch.setattr(Session, "from_opened", staticmethod(refuse))


def test_vault_commands_that_stop_early(shell: MainWindow, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    said: list[str] = []
    monkeypatch.setattr(QMessageBox, "warning", staticmethod(lambda _p, _t, text, *_a: said.append(text)))
    monkeypatch.setattr(QFileDialog, "getOpenFileName", staticmethod(lambda *_a, **_k: ("", "")))
    shell.run_setup_wizard()  # no vault
    shell.change_password()
    shell.export("csv")
    shell.export_year_report()
    shell._after_save()
    shell._auto_backup()
    shell.open_vault()  # no file chosen
    assert shell.session is None and not said

    shell._vault_busy = True
    shell.new_vault()
    shell.open_vault()
    shell.verify_backup()
    shell.restore_backup()
    shell._vault_busy = False

    path = tmp_path / "familia.opesvault"
    _saved(path)
    assert isinstance(shell._read_vault(path)(), Session)  # decrypting and parsing, as the worker job does
    _refuse_ledger(monkeypatch)
    assert isinstance(shell._read_vault(path)(), DomainError)
    shell.open_path(path)
    _wait(shell)
    assert shell.session is None and said == ["Cofre de versão mais nova."]
    assert shell.lock is None  # the lock is given back


def test_new_vault_without_the_lock_and_the_wizard_applied(
    shell: MainWindow, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from opesvault.ui.setup_wizard import SetupWizard
    from opesvault.vault.lock import VaultLock

    errors: list[object] = []
    monkeypatch.setattr(shell, "_show_error", errors.append)
    path = tmp_path / "novo.opesvault"
    monkeypatch.setattr(QFileDialog, "getSaveFileName", staticmethod(lambda *_a, **_k: (str(path), "")))
    monkeypatch.setattr(QInputDialog, "getText", staticmethod(lambda *_a, **_k: ("Projeto Lima", True)))
    other = VaultLock(path)
    other.acquire()  # another window holds it
    try:
        shell.new_vault()
    finally:
        other.release()
    assert shell.session is None and len(errors) == 1

    shell.session = Session.new(tmp_path / "x.opesvault", "Teste")
    shell._refresh()

    def plan(wizard: SetupWizard) -> int:
        wizard.members_page.names.setPlainText("Lia")
        return 1

    monkeypatch.setattr(SetupWizard, "exec", plan)
    shell.run_setup_wizard()
    assert [m.name for m in shell.session.ledger.members.values()] == ["Lia"]
    assert len(shell.session.undo_stack().undo_steps) == 1


def test_reports_and_exports_from_the_vault_menu(
    shell: MainWindow, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from opesvault.ui.pages.overview_page import OverviewPage

    _with_family(shell, tmp_path)
    monkeypatch.setattr("opesvault.ui.shell.vault.confirm", lambda *_a: True)
    monkeypatch.setattr(QFileDialog, "getSaveFileName", staticmethod(lambda *_a, **_k: ("", "")))
    shell.export("json")  # confirmed, but no file chosen
    assert not list(tmp_path.glob("*.json"))

    reports: list[object] = []
    monkeypatch.setattr(OverviewPage, "export_report", lambda page: reports.append(page))
    shell.export_month_report()
    assert len(reports) == 1

    years = [(2025, False), (2025, True)]
    monkeypatch.setattr(QInputDialog, "getInt", staticmethod(lambda *_a, **_k: years.pop(0)))
    pdfs: list[str] = []
    monkeypatch.setattr("opesvault.ui.pdf_export.save_pdf", lambda _p, name, build: pdfs.append(name) or bool(build()))
    shell.export_year_report()
    shell.export_year_report()
    assert pdfs == ["fechamento-2025.pdf"]

    shell.session = None
    shell.export_month_report()
    assert len(reports) == 1


# ── Cofre: backups ──────────────────────────────────


def test_backups_that_cannot_be_read_restored_or_listed(
    shell: MainWindow, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from opesvault.domain.settings import update_settings
    from opesvault.vault.backup import create_backup
    from opesvault.vault.lock import VaultLock

    said: list[tuple[str, str]] = []
    for kind in ("information", "warning"):
        monkeypatch.setattr(QMessageBox, kind, staticmethod(lambda _p, title, text, *_a: said.append((title, text))))
    picked: list[str] = []
    monkeypatch.setattr(QFileDialog, "getOpenFileName", staticmethod(lambda *_a, **_k: (picked.pop(0), "")))
    saves: list[str] = []
    monkeypatch.setattr(QFileDialog, "getSaveFileName", staticmethod(lambda *_a, **_k: (saves.pop(0), "")))

    path = tmp_path / "familia.opesvault"
    session = _saved(path)
    assert session.revision is not None
    backup = create_backup(path, session.revision.revision, tmp_path / "backups")

    picked += ["", ""]
    shell.verify_backup()  # no vault open, no file chosen
    shell.restore_backup()
    assert not said

    picked.append(str(backup))
    saves.append("")
    shell.restore_backup()  # the backup is valid, but no destination chosen
    _wait(shell)
    assert said[-1][0] == "Restaurar" and shell.session is None

    destination = tmp_path / "restaurado.opesvault"
    holder = VaultLock(destination)
    holder.acquire()
    errors: list[object] = []
    monkeypatch.setattr(shell, "_show_error", errors.append)
    picked.append(str(backup))
    saves.append(str(destination))
    try:
        shell.restore_backup()  # copied, but another window holds the new file
        _wait(shell)
    finally:
        holder.release()
    assert destination.exists() and shell.session is None and len(errors) == 1

    _refuse_ledger(monkeypatch)
    picked += [str(backup), str(backup)]
    shell.restore_backup()
    _wait(shell)
    assert said[-1] == ("Restaurar", "Cofre de versão mais nova.")
    shell.verify_backup()
    _wait(shell)
    assert said[-1] == ("Verificar backup", "Cofre de versão mais nova.")

    shell.session = session
    update_settings(session.ledger, backup_dir=str(tmp_path / "backups"))

    def unreadable(*_a: object) -> list[object]:
        raise OSError("pasta sumiu")

    monkeypatch.setattr("opesvault.vault.backup.list_backups", unreadable)
    [alert] = shell.backup_alerts()  # an unreadable folder counts as no backup
    assert alert.detail == "nenhum backup encontrado na pasta de backups"
    shell.session = None


def test_backup_report_without_revision_newer_backup_and_no_open_vault(tmp_path: Path) -> None:
    from datetime import UTC, datetime

    from opesvault.ui.shell.backups import backup_report
    from opesvault.vault.model import RevisionInfo

    f = family()
    restored = Session.new(tmp_path / "b.opesvault")
    restored.ledger = f.ledger
    text = backup_report(restored, None)
    assert "Revisão" not in text and "outro cofre" not in text and "Nada foi alterado" in text
    restored.revision = RevisionInfo(
        vault_id=restored.vault_id,
        format_version=1,
        revision=7,
        revision_id=restored.vault_id,
        saved_at=datetime(2026, 3, 1, 10, tzinfo=UTC),
    )
    current = Session(path=tmp_path / "a.opesvault", vault_id=restored.vault_id, ledger=f.ledger)
    current.revision = restored.revision.model_copy(update={"revision": 5})
    text = backup_report(restored, current)  # the backup is newer than the open vault: no comparison line
    assert "atrás" not in text and "mesma revisão" not in text and "outro cofre" not in text
    current.revision = restored.revision
    assert "na mesma revisão da aberta" in backup_report(restored, current)


def test_model_index_helpers_survive_an_invalid_index(app: QApplication) -> None:
    from opesvault.ui.pages.ledger.model import OperationsModel

    f = family()
    model = OperationsModel()
    model.reset(f.ledger, [])
    assert model.data(QModelIndex()) is None
