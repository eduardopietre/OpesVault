"""Ledger page: filters, virtual model, full edit dialog, bulk reclassification and the
import/save race."""

from datetime import date
from decimal import Decimal
from pathlib import Path

import pytest
from PySide6.QtCore import Qt
from PySide6.QtWidgets import QApplication

from opesvault.domain import queries
from opesvault.domain.ledger import DomainError
from opesvault.domain.model import OriginKind, YearMonth
from opesvault.domain.search import OperationFilter, StatusFilter, find_operations
from opesvault.session import Session
from opesvault.ui.main_window import MainWindow
from opesvault.ui.operation_edit import OperationEditDialog, build_postings, imbalance
from opesvault.ui.pages.ledger_page import LedgerPage

from .domain_fixtures import category, family

JAN = YearMonth(year=2026, month=1)


def test_filters() -> None:
    f = family()
    ledger = f.ledger
    a = ledger.record_expense(f.bank, f.groceries, "10.00", date(2026, 1, 5), "Padaria", member_id=f.ana)
    b = ledger.record_expense(f.joint, f.groceries, "20.00", date(2026, 2, 5), "Feira", notes="orgânicos")
    c = ledger.record_income(f.bank, f.salary, "100.00", date(2026, 2, 1), "Salário")
    ledger.cancel_operation(c.id, "duplicado")

    def ids(**kw: object) -> list[object]:
        return [o.id for o in find_operations(ledger, OperationFilter(**kw))]  # type: ignore[arg-type]

    assert ids() == [b.id, c.id, a.id]  # newest first
    assert ids(start=date(2026, 2, 1)) == [b.id, c.id]
    assert ids(end=date(2026, 1, 31)) == [a.id]
    assert ids(account_id=f.joint) == [b.id]
    assert set(ids(account_id=f.groceries)) == {a.id, b.id}
    assert ids(member_id=f.ana) == [a.id]
    assert ids(text="ORGÂN") == [b.id]  # notes are searched too
    assert ids(status=StatusFilter.ACTIVE) == [b.id, a.id]
    assert ids(status=StatusFilter.CANCELLED) == [c.id]
    assert ids(origin=OriginKind.IMPORT) == []


def test_undated_operations_never_match_a_period() -> None:
    f = family()
    op = f.ledger.record_expense(f.bank, f.groceries, "10.00", date(2026, 1, 5), "x")
    f.ledger.update_operation(op.model_copy(update={"occurred_on": None, "booked_on": None, "settled_on": None}), "r")
    assert find_operations(f.ledger, OperationFilter()) != []
    assert find_operations(f.ledger, OperationFilter(start=date(2000, 1, 1))) == []


def test_build_postings_and_balance() -> None:
    f = family()
    rows = [(f.groceries, "60,00", "", f.ana), (f.groceries, "40,00", "", f.bruno), (f.bank, "", "100,00", None)]
    postings = build_postings(rows)
    assert [p.amount for p in postings] == [Decimal("60.00"), Decimal("40.00"), Decimal("-100.00")]
    assert imbalance(rows) == 0
    assert imbalance([(f.bank, "10", "", None), (f.groceries, "", "7", None)]) == Decimal("3")
    assert imbalance([(f.bank, "1,2,3", "", None)]) is None
    with pytest.raises(DomainError):
        build_postings([(f.bank, "10", "10", None), (f.groceries, "", "10", None)])
    with pytest.raises(DomainError):
        build_postings([(f.bank, "-5", "", None), (f.groceries, "", "5", None)])
    with pytest.raises(DomainError):
        build_postings([(None, "5", "", None), (f.groceries, "", "5", None)])
    # Fully empty rows are ignored; one posting is not an operation.
    with pytest.raises(DomainError):
        build_postings([(f.bank, "5", "", None), (None, "", "", None)])


@pytest.fixture(scope="module")
def app() -> QApplication:
    instance = QApplication.instance()
    return instance if isinstance(instance, QApplication) else QApplication([])


@pytest.fixture
def window(app: QApplication, tmp_path: Path) -> MainWindow:
    win = MainWindow()
    f = family()
    session = Session.new(tmp_path / "x.opesvault", "Teste")
    session.ledger = f.ledger
    win.session = session
    win._refresh()
    return win


def ledger_page(window: MainWindow) -> LedgerPage:
    page = next(p for p in window.pages if isinstance(p, LedgerPage))
    window.nav.setCurrentRow(window.pages.index(page))
    return page


def test_edit_dialog_splits_between_members(window: MainWindow) -> None:
    assert window.session is not None
    ledger = window.session.ledger
    f_bank = next(a.id for a in ledger.accounts.values() if a.name == "Banco A")
    groceries = category(ledger, "Alimentação")
    members = {m.name: m.id for m in ledger.members.values()}
    op = ledger.record_expense(f_bank, groceries, "100.00", date(2026, 1, 5), "Mercado")
    dialog = OperationEditDialog(window, ledger, op)
    assert dialog.balance.text() == "Equilibrada ✓"
    with pytest.raises(DomainError):
        dialog.validate()  # reason is required
    dialog.reason.setText("dividir entre Ana e Bruno")
    with pytest.raises(DomainError):
        dialog.validate()  # nothing changed yet

    dialog.add_row(None)
    rows = dialog.rows()
    category_row = next(i for i, r in enumerate(rows) if r[0] == groceries)
    _set_row(dialog, category_row, groceries, "60,00", "", members["Ana"])
    _set_row(dialog, len(rows) - 1, groceries, "30,00", "", members["Bruno"])
    assert dialog.balance.text().startswith("Sobram")
    with pytest.raises(DomainError):
        dialog.validate()  # unbalanced is refused by the domain
    _set_row(dialog, len(rows) - 1, groceries, "40,00", "", members["Bruno"])
    dialog.occurred.set_value(date(2026, 1, 6))
    dialog.validate()
    updated = dialog.apply()
    assert updated.occurred_on == date(2026, 1, 6)
    assert sorted(p.amount for p in updated.postings if p.member_id) == [Decimal("40.00"), Decimal("60.00")]
    assert ledger.history_of(op.id)[-1].reason == "dividir entre Ana e Bruno"
    assert queries.expenses_by_category(ledger, JAN, JAN)[groceries] == Decimal("100.00")


def _set_row(dialog: OperationEditDialog, row: int, account: object, debit: str, credit: str, member: object) -> None:
    from PySide6.QtWidgets import QComboBox, QLineEdit

    from opesvault.ui.common import select_combo

    widgets = [dialog.postings.cellWidget(row, c) for c in range(4)]
    assert isinstance(widgets[0], QComboBox) and isinstance(widgets[3], QComboBox)
    assert isinstance(widgets[1], QLineEdit) and isinstance(widgets[2], QLineEdit)
    select_combo(widgets[0], account)
    widgets[1].setText(debit)
    widgets[2].setText(credit)
    select_combo(widgets[3], member)


def test_unknown_date_stays_unknown_in_the_dialog(window: MainWindow) -> None:
    assert window.session is not None
    ledger = window.session.ledger
    bank = next(a.id for a in ledger.accounts.values() if a.name == "Banco A")
    op = ledger.record_expense(bank, category(ledger, "Alimentação"), "5.00", date(2026, 1, 5), "x")
    dialog = OperationEditDialog(window, ledger, op)
    assert dialog.due.value() is None
    dialog.reason.setText("r")
    dialog.description.setText("y")
    assert dialog.build().due_on is None


def test_virtual_table_sorts_selects_and_reclassifies(window: MainWindow) -> None:
    assert window.session is not None
    ledger = window.session.ledger
    bank = next(a.id for a in ledger.accounts.values() if a.name == "Banco A")
    groceries, leisure = category(ledger, "Alimentação"), category(ledger, "Lazer")
    for day in range(1, 21):
        ledger.record_expense(bank, groceries, f"{day}.00", date(2026, 1, day), f"Compra {day:02d}")
    page = ledger_page(window)
    page.refresh()
    assert page.model.rowCount() == 20
    assert page.model.data(page.model.index(0, 2)) == "Compra 20"  # default: newest first
    page.table.sortByColumn(5, Qt.SortOrder.AscendingOrder)
    assert page.model.data(page.model.index(0, 5)) == "R$ 1,00"
    assert page.model.data(page.model.index(0, 5), Qt.ItemDataRole.TextAlignmentRole) is not None

    page.filter_text.setText("Compra 1")
    page._debounce.timeout.emit()
    assert page.model.rowCount() == 10  # 10..19
    page.table.selectAll()
    ids = page.selected_ids()
    assert len(ids) == 10

    from opesvault.domain.edits import reclassify

    assert reclassify(ledger, ids, leisure, "lazer").changed == 10
    page.refresh()
    assert set(page.selected_ids()) == set(ids)  # selection survives a refresh
    expenses = queries.expenses_by_category(ledger, JAN, JAN)
    assert expenses[leisure] == sum((Decimal(d) for d in range(10, 20)), Decimal(0))


def test_large_ledger_refresh_is_fast(window: MainWindow) -> None:
    import time

    assert window.session is not None
    ledger = window.session.ledger
    bank = next(a.id for a in ledger.accounts.values() if a.name == "Banco A")
    groceries = category(ledger, "Alimentação")
    for i in range(5000):
        ledger.record_expense(bank, groceries, "1.00", date(2026, 1, 1 + i % 28), f"Op {i}")
    page = ledger_page(window)
    started = time.perf_counter()
    page.refresh()
    QApplication.processEvents()
    assert page.model.rowCount() == 5000
    assert time.perf_counter() - started < 2.0


def test_import_blocks_saving_and_editing(window: MainWindow) -> None:
    page = ledger_page(window)
    page.set_busy(True)
    assert window.busy
    central = window.centralWidget()
    assert central is not None and not central.isEnabled()
    frozen_before = window.session.freeze() if window.session else None
    window.save_vault()  # ignored while busy: no job started
    assert not window._jobs
    page.set_busy(False)
    assert not window.busy and central.isEnabled()
    assert frozen_before is not None
