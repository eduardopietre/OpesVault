"""Every row command of the Livro financeiro carried through, with its dialog filled and confirmed.

The walk over every screen (test_every_screen) cancels each dialog; here each one is filled the
way a person would, and the test checks the ledger, the message and the single undo step.
"""

from collections.abc import Callable
from datetime import date
from decimal import Decimal
from pathlib import Path
from typing import Any

import pytest
from PySide6.QtWidgets import QApplication, QFileDialog, QInputDialog, QMessageBox

from opesvault.domain import queries, sharing, tags
from opesvault.domain.model import Operation, OperationStatus
from opesvault.session import Session
from opesvault.ui.common import select_combo
from opesvault.ui.main_window import MainWindow
from opesvault.ui.pages.ledger import LedgerPage

from .domain_fixtures import Family, category, family


@pytest.fixture(scope="module")
def app() -> QApplication:
    instance = QApplication.instance()
    return instance if isinstance(instance, QApplication) else QApplication([])


@pytest.fixture
def setup(app: QApplication, tmp_path: Path) -> tuple[MainWindow, Family, LedgerPage]:
    window = MainWindow()
    f = family()
    session = Session.new(tmp_path / "x.opesvault", "Teste")
    session.ledger = f.ledger
    f.ledger.record_opening_balance(f.bank, "5000.00", date(2026, 1, 1))
    window.session = session
    window._refresh()
    session.undo_stack().seal()
    session.undo_stack().undo_steps.clear()
    page = next(p for p in window.pages if isinstance(p, LedgerPage))
    window.show_page(window.pages.index(page))
    return window, f, page


def _pick(page: LedgerPage, *ops: Operation) -> None:
    page.refresh()
    page.table.clearSelection()
    for op in ops:
        row = next(i for i, shown in enumerate(page.model.ops) if shown.id == op.id)
        if op is ops[0]:
            page.table.selectRow(row)
        else:
            page._select({op.id})


def _accept(monkeypatch: pytest.MonkeyPatch, cls: type, fill: Callable[[Any], None]) -> list[Any]:
    """Patches `cls.exec`: the dialog is filled by `fill` and confirmed through its own validation."""
    opened: list[Any] = []

    def run(dialog: Any) -> int:
        opened.append(dialog)
        fill(dialog)
        dialog._try_accept()
        assert dialog.result() == 1, dialog.error.text()
        return 1

    monkeypatch.setattr(cls, "exec", run)
    return opened


def _steps(window: MainWindow) -> int:
    assert window.session is not None
    return len(window.session.undo_stack().undo_steps)


def test_a_new_expense_is_registered_from_the_menu(
    setup: tuple[MainWindow, Family, LedgerPage], monkeypatch: pytest.MonkeyPatch
) -> None:
    from opesvault.ui.dialogs import OperationDialog

    window, f, page = setup

    def fill(dialog: Any) -> None:
        dialog.description.setText("Feira")
        dialog.amount.setText("87,40")
        select_combo(dialog.source, f.bank)
        select_combo(dialog.target, f.groceries)

    _accept(monkeypatch, OperationDialog, fill)
    page.new_operation("expense")
    assert queries.balance(f.ledger, f.groceries) == Decimal("87.40")
    assert "Despesa: lançamento registrado." in window.statusBar().currentMessage()
    assert _steps(window) == 1


def test_a_correction_keeps_the_previous_version_in_the_history(
    setup: tuple[MainWindow, Family, LedgerPage], monkeypatch: pytest.MonkeyPatch
) -> None:
    from opesvault.ui.operation_edit import SimpleEditDialog

    window, f, page = setup
    op = f.ledger.record_expense(f.bank, f.groceries, "50.00", date(2026, 2, 3), "Mercado")
    _pick(page, op)

    def fill(dialog: Any) -> None:
        dialog.amount.setText("55,00")
        dialog.reason.setText("valor do cupom")

    _accept(monkeypatch, SimpleEditDialog, fill)
    page.edit()
    assert queries.balance(f.ledger, f.groceries) == Decimal("55.00")
    assert [h.reason for h in f.ledger.history_of(op.id)][-1] == "valor do cupom"
    assert _steps(window) == 1


def test_a_cancelled_operation_cannot_be_corrected(setup: tuple[MainWindow, Family, LedgerPage]) -> None:
    window, f, page = setup
    op = f.ledger.record_expense(f.bank, f.groceries, "50.00", date(2026, 2, 3), "Mercado")
    f.ledger.cancel_operation(op.id, "duplicado")
    from opesvault.domain.search import StatusFilter

    select_combo(page.filters.status, StatusFilter.ALL)
    _pick(page, op)
    page.edit()
    assert window.statusBar().currentMessage() == "Lançamento cancelado não pode ser corrigido."


def test_several_operations_are_reclassified_with_a_reason(
    setup: tuple[MainWindow, Family, LedgerPage], monkeypatch: pytest.MonkeyPatch
) -> None:
    from opesvault.ui.pages.ledger.actions import ReclassifyDialog

    window, f, page = setup
    leisure = category(f.ledger, "Lazer")
    ops = [f.ledger.record_expense(f.bank, f.groceries, "10.00", date(2026, 2, d), "Lanche") for d in (1, 2, 3)]
    _pick(page, *ops)
    assert len(page.selected_ids()) == 3

    def fill(dialog: Any) -> None:
        select_combo(dialog.target, leisure)
        dialog.reason.setText("era passeio")

    _accept(monkeypatch, ReclassifyDialog, fill)
    page.reclassify_selected()
    assert queries.balance(f.ledger, leisure) == Decimal("30.00")
    assert window.statusBar().currentMessage() == "3 reclassificado(s), 0 mantido(s)."
    assert _steps(window) == 1


def test_tags_merchant_and_reviewed_mark(
    setup: tuple[MainWindow, Family, LedgerPage], monkeypatch: pytest.MonkeyPatch
) -> None:
    from opesvault.domain import merchants
    from opesvault.ui.planning_dialogs import TagDialog

    window, f, page = setup
    op = f.ledger.record_expense(f.bank, f.groceries, "10.00", date(2026, 2, 1), "PAG*JOSEDASILVA 123")
    _pick(page, op)
    _accept(monkeypatch, TagDialog, lambda dialog: dialog.tag.setText("Feira"))
    page.tag_selected()
    assert tags.tags_of(f.ledger, op.id) == ("Feira",)
    assert page._selected() is not None  # still the current row after the page refreshed

    monkeypatch.setattr(QInputDialog, "getText", staticmethod(lambda *a, **k: ("Feira do José", True)))
    page.name_merchant()
    assert merchants.merchant_of(f.ledger, op.description) == "Feira do José"
    page.mark_reviewed()
    assert "conferido" in window.statusBar().currentMessage()
    assert _steps(window) >= 2


def test_reverse_and_cancel_ask_for_a_reason(
    setup: tuple[MainWindow, Family, LedgerPage], monkeypatch: pytest.MonkeyPatch
) -> None:
    _window, f, page = setup
    op = f.ledger.record_expense(f.bank, f.groceries, "40.00", date(2026, 2, 1), "Padaria")
    answers = iter([("", True), ("cobrado em dobro", True), ("lançado errado", True)])
    warned: list[str] = []
    monkeypatch.setattr(QInputDialog, "getText", staticmethod(lambda *a, **k: next(answers)))
    monkeypatch.setattr(QMessageBox, "warning", staticmethod(lambda *a, **k: warned.append(a[2])))
    _pick(page, op)
    page.reverse()  # an empty reason is refused, nothing happens
    assert warned == ["O motivo é obrigatório."] and len(f.ledger.operations) == 2
    page.reverse()
    assert queries.balance(f.ledger, f.groceries) == Decimal("0.00")  # the reversal undoes the amount
    other = f.ledger.record_expense(f.bank, f.groceries, "15.00", date(2026, 2, 2), "Pão")
    _pick(page, other)
    page.cancel()
    assert f.ledger.operations[other.id].status is OperationStatus.CANCELLED


def test_history_and_reimbursement(
    setup: tuple[MainWindow, Family, LedgerPage], monkeypatch: pytest.MonkeyPatch
) -> None:
    from opesvault.ui.planning_dialogs import ReimbursementDialog

    _window, f, page = setup
    health = category(f.ledger, "Saúde")
    op = f.ledger.record_expense(f.bank, health, "300.00", date(2026, 2, 1), "Exame")
    shown: list[str] = []
    monkeypatch.setattr(QMessageBox, "information", staticmethod(lambda *a, **k: shown.append(a[2])))
    _pick(page, op)
    page.show_history()
    assert shown and "v1" in shown[0]

    def fill(dialog: Any) -> None:
        dialog.payer.setText("Plano")

    _accept(monkeypatch, ReimbursementDialog, fill)
    page.request_reimbursement()
    [item] = sharing.reimbursements(f.ledger).values()
    assert item.operation_id == op.id and item.expected == Decimal("300.00")


def test_a_receipt_is_attached_and_unreadable_files_are_reported(
    setup: tuple[MainWindow, Family, LedgerPage], monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    from opesvault.domain.attachments import of_operation

    from . import synthetic_docs as docs

    window, f, page = setup
    op = f.ledger.record_expense(f.bank, f.groceries, "20.00", date(2026, 2, 1), "Farmácia")
    receipt = tmp_path / "recibo.pdf"
    receipt.write_bytes(docs.nubank_card_pdf())
    chosen = iter([(str(tmp_path / "sumiu.pdf"), ""), (str(receipt), "")])
    warned: list[str] = []
    monkeypatch.setattr(QFileDialog, "getOpenFileName", staticmethod(lambda *a, **k: next(chosen)))
    monkeypatch.setattr(QMessageBox, "warning", staticmethod(lambda *a, **k: warned.append(a[2])))
    _pick(page, op)
    page.attach_receipt()
    assert warned == ["Não foi possível ler o arquivo."]
    page.attach_receipt()
    assert len(of_operation(f.ledger, op.id)) == 1
    assert window.session is not None and len(window.session.documents) == 1


def test_income_detail_only_for_income(
    setup: tuple[MainWindow, Family, LedgerPage], monkeypatch: pytest.MonkeyPatch
) -> None:
    from opesvault.tax import records
    from opesvault.ui.tax_dialogs import IncomeDetailDialog

    window, f, page = setup
    expense = f.ledger.record_expense(f.bank, f.groceries, "20.00", date(2026, 2, 1), "Mercado")
    _pick(page, expense)
    page.detail_income()
    assert window.statusBar().currentMessage() == "Só receitas têm detalhamento de rendimento."
    salary = f.ledger.record_income(f.bank, f.salary, "4000.00", date(2026, 2, 5), "Salário")

    def fill(dialog: Any) -> None:
        dialog.gross.setText("5.000,00")
        dialog.withheld.setText("500,00")
        dialog.social.setText("500,00")

    _accept(monkeypatch, IncomeDetailDialog, fill)
    _pick(page, salary)
    page.detail_income()
    detail = records.detail_of(f.ledger, salary.id)
    assert detail is not None and detail.gross == Decimal("5000.00")
