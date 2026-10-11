"""Page actions driven through the page API, with every modal dialog answered by the test.

Each page is mounted alone over a real Session: `changed()` seals an undo step like the main
window does, and navigation, notices and the shared month are recorded instead of acted on.
"""

from collections.abc import Callable, Iterator
from dataclasses import dataclass, field
from datetime import date, timedelta
from decimal import Decimal
from pathlib import Path
from typing import Any
from uuid import UUID

import pytest
from PySide6.QtWidgets import (
    QApplication,
    QCheckBox,
    QComboBox,
    QDateEdit,
    QFileDialog,
    QInputDialog,
    QLineEdit,
    QMessageBox,
    QTableWidget,
)

from opesvault.domain import budget, queries
from opesvault.domain.ledger import DomainError
from opesvault.domain.model import YearMonth
from opesvault.session import Session
from opesvault.ui import theme
from opesvault.ui.common import select_combo, to_qdate
from opesvault.ui.pages.base import Page
from opesvault.undo import Step

from .domain_fixtures import Family, family
from .test_ai import _statement

TODAY = date.today()


@pytest.fixture(scope="module")
def app() -> QApplication:
    instance = QApplication.instance()
    app = instance if isinstance(instance, QApplication) else QApplication([])
    theme.apply_theme(app, dark=False)
    return app


@dataclass
class Mounted[P: Page]:
    """A page over a session, with what it asked of the window."""

    page: P
    session: Session
    family: Family
    steps: list[Step | None] = field(default_factory=list)
    navigations: list[tuple[str, object, bool]] = field(default_factory=list)
    notices: list[str] = field(default_factory=list)
    months: list[object] = field(default_factory=list)

    @property
    def ledger(self):  # type: ignore[no-untyped-def]
        return self.session.ledger

    def sealed(self) -> list[Step]:
        """Undo steps closed by `changed()`; an action that edits must close exactly one."""
        return [s for s in self.steps if s is not None]


@pytest.fixture
def env(app: QApplication, tmp_path: Path) -> tuple[Session, Family]:
    f = family()
    session = Session.new(tmp_path / "x.opesvault", "Teste")
    session.ledger = f.ledger
    session.undo_stack().seal()  # what the fixture built is not an undoable user action
    return session, f


def mount[P: Page](kind: type[P], env: tuple[Session, Family]) -> Mounted[P]:
    session, f = env
    holder: list[Mounted[P]] = []

    def changed() -> None:  # MainWindow.on_changed: one user action = one undo step, then refresh
        mounted = holder[0]
        mounted.steps.append(session.undo_stack().seal())
        mounted.page.refresh()

    page = kind(changed)
    mounted = Mounted(page, session, f)
    holder.append(mounted)
    page.set_navigate_hook(lambda target, ref=None, act=False: mounted.navigations.append((target, ref, act)))
    page.set_notify_hook(mounted.notices.append)
    page.set_month_hook(lambda _page, month: mounted.months.append(month))
    page.set_session(session)
    session.undo_stack().seal()
    return mounted


@pytest.fixture
def boxes(monkeypatch: pytest.MonkeyPatch) -> list[tuple[str, str]]:
    """QMessageBox information/warning calls, recorded as (title, text) instead of shown."""
    shown: list[tuple[str, str]] = []

    def record(_parent: object, title: str, message: str, *_a: object, **_k: object) -> QMessageBox.StandardButton:
        shown.append((title, message))
        return QMessageBox.StandardButton.Ok

    monkeypatch.setattr(QMessageBox, "information", staticmethod(record))
    monkeypatch.setattr(QMessageBox, "warning", staticmethod(record))
    return shown


def answer_dialog(monkeypatch: pytest.MonkeyPatch, cls: type, fill: Callable[[Any], object] | None) -> list[Any]:
    """`cls.exec` runs `fill` and accepts after validating, like the dialog's confirm button.

    With `fill=None` the dialog is cancelled. Returns the dialogs that were opened.
    """
    opened: list[Any] = []

    def run(dialog: Any) -> bool:
        opened.append(dialog)
        if fill is None:
            return False
        fill(dialog)
        if hasattr(dialog, "validate"):
            dialog.validate()
        return True

    monkeypatch.setattr(cls, "exec", run)
    return opened


def set_field(widget: object, value: object) -> None:
    if isinstance(widget, QLineEdit):
        widget.setText(str(value))
    elif isinstance(widget, QComboBox):
        select_combo(widget, value)
        assert widget.currentData() == value, f"{value!r} is not an option"
    elif isinstance(widget, QDateEdit):
        assert isinstance(value, date)
        widget.setDate(to_qdate(value))
    elif isinstance(widget, QCheckBox):
        widget.setChecked(bool(value))
    else:  # pragma: no cover - a field type the helper does not know
        raise AssertionError(type(widget))


def select_row(table: QTableWidget, key: object) -> None:
    from PySide6.QtCore import Qt

    for row in range(table.rowCount()):
        item = table.item(row, 0)
        if item is not None and item.data(Qt.ItemDataRole.UserRole) == key:
            table.selectRow(row)
            return
    raise AssertionError(f"{key!r} not in the table")


def column(table: QTableWidget, index: int) -> list[str]:
    return [item.text() if (item := table.item(r, index)) else "" for r in range(table.rowCount())]


# ── Investimentos ───────────────────────────────────


@pytest.fixture
def forms(monkeypatch: pytest.MonkeyPatch) -> Iterator[list[dict[str, object] | None]]:
    """Answers investment forms in order: a dict fills fields by key, None cancels."""
    from opesvault.ui.pages.investments_page import Form

    queue: list[dict[str, object] | None] = []

    def run(form: Form) -> bool:
        assert queue, f"unexpected form {form.windowTitle()!r}"
        values = queue.pop(0)
        if values is None:
            return False
        for key, value in values.items():
            set_field(form.fields[key], value)
        form.validate()
        return True

    monkeypatch.setattr(Form, "exec", run)
    yield queue
    assert not queue, "every planned form was opened"


def _value_position(m: Mounted[Any], name: str = "CDB Banco", cost: str = "1000.00") -> UUID:
    from opesvault.investments import service as inv
    from opesvault.investments.model import AssetClass

    pos = inv.create_position(
        m.ledger, name, AssetClass.FIXED_INCOME, date(2026, 1, 2), initial_cost=cost, from_account=m.family.bank
    )
    m.session.undo_stack().seal()
    m.page.refresh()
    return pos.id


def test_investment_parsers_read_the_brazilian_format() -> None:
    from opesvault.ui.pages.investments_page import parse_quantity, parse_rate, percent_label

    assert parse_quantity(" 1.234,5 ") == Decimal("1234.5")
    assert parse_rate("22,5") == Decimal("0.225") and parse_rate("  ") is None
    assert percent_label(None) == "indisponível" and percent_label(Decimal("0.1234")) == "12,34%"
    for bad, parse in (("dez", parse_quantity), ("15%", parse_rate)):
        with pytest.raises(DomainError):
            parse(bad)


def test_value_combo_keeps_the_enum_qt_would_flatten(app: QApplication) -> None:
    from opesvault.investments.model import TrackingMode
    from opesvault.ui.pages.investments_page import ValueCombo

    combo = ValueCombo([("Valor", TrackingMode.VALUE), ("Quantidade", TrackingMode.QUANTITY)], empty="(nenhum)")
    assert combo.value() is None
    combo.setCurrentIndex(2)
    assert type(combo.currentData()) is str  # what Qt itself hands back
    assert combo.value() is TrackingMode.QUANTITY


def test_new_value_position_takes_money_from_the_account(
    env: tuple[Session, Family], forms: list[dict[str, object] | None]
) -> None:
    from opesvault.investments import service as inv
    from opesvault.ui.pages.investments_page import InvestmentsPage

    m = mount(InvestmentsPage, env)
    assert m.page.views.currentIndex() == 1  # empty state
    forms.append(None)  # cancelled: nothing happens
    m.page.new_position()
    assert not inv.positions(m.ledger) and not m.steps
    forms.append({"name": "CDB Banco", "on": date(2026, 1, 2), "cost": "1.500,00", "from": m.family.bank})
    m.page.new_position()
    (pos,) = inv.positions(m.ledger).values()
    assert pos.cost_known and inv.remaining_cost(m.ledger, pos.id) == Decimal("1500.00")
    assert queries.balance(m.ledger, m.family.bank) == Decimal("-1500.00")
    assert len(m.sealed()) == 1 and m.page.views.currentIndex() == 0
    assert m.page.header.subtitle.text() == "1 em carteira"
    assert m.page.detail_title.text() == "CDB Banco"  # the first row is selected by itself
    m.session.undo_stack().undo()
    assert not inv.positions(m.ledger) and queries.balance(m.ledger, m.family.bank) == Decimal("0")


def test_new_position_form_requires_name_and_cost_or_reference(
    env: tuple[Session, Family], monkeypatch: pytest.MonkeyPatch
) -> None:
    from opesvault.ui.pages.investments_page import Form, InvestmentsPage

    m = mount(InvestmentsPage, env)
    errors: list[str] = []

    def run(form: Form) -> bool:
        for values in ({}, {"name": "Tesouro"}):
            for key, value in values.items():
                set_field(form.fields[key], value)
            with pytest.raises(DomainError) as caught:
                form.validate()
            errors.append(str(caught.value))
        return False

    monkeypatch.setattr(Form, "exec", run)
    m.page.new_position()
    assert errors == ["Informe o nome.", "Informe o custo inicial ou um valor de referência."]


def test_quantity_position_from_the_form_is_tracked_by_quantity(
    env: tuple[Session, Family], forms: list[dict[str, object] | None], boxes: list[tuple[str, str]]
) -> None:
    """The mode reaches the service as the enum: a quantity position starts empty with known cost."""
    from opesvault.investments import service as inv
    from opesvault.investments.model import AssetClass, TrackingMode
    from opesvault.ui.pages.investments_page import InvestmentsPage

    m = mount(InvestmentsPage, env)
    forms.append({"name": "PETR4", "class": AssetClass.STOCK, "mode": TrackingMode.QUANTITY, "reference": "2.000,00"})
    m.page.new_position()
    (pos,) = inv.positions(m.ledger).values()
    assert pos.mode is TrackingMode.QUANTITY and pos.cost_known
    # A cost typed for a quantity position is refused: purchases or an opening lot bring the cost.
    forms.append({"name": "VALE3", "mode": TrackingMode.QUANTITY, "cost": "500,00", "from": m.family.bank})
    m.page.new_position()
    assert boxes and "começam vazias" in boxes[-1][1]
    assert len(inv.positions(m.ledger)) == 1 and queries.balance(m.ledger, m.family.bank) == Decimal("0")


def test_position_actions_need_a_selected_investment(env: tuple[Session, Family], boxes: list[tuple[str, str]]) -> None:
    from opesvault.ui.pages.investments_page import InvestmentsPage

    m = mount(InvestmentsPage, env)
    assert not any(action.isEnabled() for action in m.page.position_actions)
    for action in (m.page.contribution, m.page.buy, m.page.simulate, m.page.new_valuation):
        action()
    assert boxes == [("Investimentos", "Selecione um investimento.")] * 4
    m.page.complete()  # needs the incomplete redemption in Movimentos
    assert boxes[-1] == ("Investimentos", "Selecione o resgate incompleto na aba Movimentos.")
    m.page.use_valuation()
    m.page.fix_valuation()  # no valuation selected: silently nothing
    assert not m.steps


def test_cash_events_of_a_value_position(env: tuple[Session, Family], forms: list[dict[str, object] | None]) -> None:
    from opesvault.investments import service as inv
    from opesvault.investments.model import EventKind, EventQuality
    from opesvault.ui.pages.investments_page import InvestmentsPage

    m = mount(InvestmentsPage, env)
    pos_id = _value_position(m)
    bank = m.family.bank
    forms.append({"on": date(2026, 2, 1), "value": "500,00", "from": bank})
    m.page.contribution()
    forms.append({"on": date(2026, 3, 1), "value": "100,00", "tax": "15,00", "to": bank})
    m.page.distribution()
    forms.append({"on": date(2026, 4, 1), "gross": "300,00", "cost": "250,00", "withheld": "7,50", "to": bank})
    m.page.redemption()
    forms.append({"on": date(2026, 5, 1), "net": "200,00", "to": bank})
    m.page.net_only()
    kinds = [e.kind for e in inv.events_of(m.ledger, pos_id)]
    assert kinds.count(EventKind.CONTRIBUTION) == 2 and EventKind.DISTRIBUTION in kinds
    assert queries.balance(m.ledger, bank) == Decimal("-1000") - 500 + 85 + Decimal("292.50") + 200
    assert len(m.sealed()) == 4  # one undo step per registered event
    assert "a discriminar" in column(m.page.events, 4)

    incomplete = next(e for e in inv.events_of(m.ledger, pos_id) if e.quality is EventQuality.INCOMPLETE)
    select_row(m.page.events, incomplete.id)
    forms.append({"gross": "210,00", "cost": "150,00", "withheld": "10,00"})
    m.page.complete()
    done = inv.events(m.ledger)[incomplete.id]
    assert done.quality is EventQuality.COMPLETE and done.gross == Decimal("210.00")
    assert "a discriminar" not in column(m.page.events, 4)


def test_valuations_are_added_chosen_and_corrected(
    env: tuple[Session, Family], forms: list[dict[str, object] | None]
) -> None:
    from opesvault.investments import service as inv
    from opesvault.investments.model import ValueNature
    from opesvault.ui.pages.investments_page import InvestmentsPage

    m = mount(InvestmentsPage, env)
    pos_id = _value_position(m)
    on = date(2026, 6, 30)
    forms.append({"on": on, "value": "1.100,00", "nature": ValueNature.GROSS, "source": "extrato"})
    m.page.new_valuation()
    forms.append({"on": on, "value": "1.080,00", "nature": ValueNature.NET_INFORMED, "source": "app"})
    m.page.new_valuation()
    second = next(v for v in inv.valuations_of(m.ledger, pos_id) if v.source == "app")
    assert second.nature is ValueNature.NET_INFORMED and not second.selected  # the first of a date is used
    select_row(m.page.valuations, second.id)
    m.page.use_valuation()
    assert inv.valuations(m.ledger)[second.id].selected
    select_row(m.page.valuations, second.id)
    forms.append({"value": "1.090,00", "reason": "valor do informe"})
    m.page.fix_valuation()
    assert inv.valuations(m.ledger)[second.id].value == Decimal("1090.00")
    assert len(m.sealed()) == 4
    # Two selected dates make a period: the returns table computes it.
    assert m.page.period_start.count() == 2 and m.page.returns_table.rowCount() > 0


def test_returns_compare_with_an_imported_benchmark(
    env: tuple[Session, Family],
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    boxes: list[tuple[str, str]],
) -> None:
    from opesvault.investments import service as inv
    from opesvault.investments.benchmarks import benchmarks
    from opesvault.investments.model import ValueNature
    from opesvault.ui.pages.investments_page import InvestmentsPage

    m = mount(InvestmentsPage, env)
    pos_id = _value_position(m)
    inv.add_valuation(m.ledger, pos_id, date(2026, 6, 30), "1100.00", ValueNature.GROSS, source="extrato")
    csv = tmp_path / "indice.csv"
    csv.write_text("data;valor\n02/01/2026;100,00\n30/06/2026;105,00\n", encoding="utf-8")
    picked: list[str] = [""]
    monkeypatch.setattr(QFileDialog, "getOpenFileName", staticmethod(lambda *_a, **_k: (picked[0], "")))
    names: list[tuple[str, bool]] = []
    monkeypatch.setattr(QInputDialog, "getText", staticmethod(lambda *_a, **_k: names.pop(0)))
    m.page.import_benchmark()  # no file chosen
    picked[0] = str(csv)
    names += [("  ", True), ("IPCA", False)]
    m.page.import_benchmark()  # blank name
    m.page.import_benchmark()  # name dialog cancelled
    assert not benchmarks(m.ledger) and not m.steps
    names.append(("IPCA", True))
    m.page.import_benchmark()
    (bench,) = benchmarks(m.ledger).values()
    assert bench.name == "IPCA" and bench.source == "arquivo indice.csv" and len(m.sealed()) == 1

    page = m.page
    rows_without = page.returns_table.rowCount()
    select_combo(page.benchmark, bench.id)
    page._show_returns()
    assert page.returns_table.rowCount() == rows_without + 1
    results = dict(zip(column(page.returns_table, 0), column(page.returns_table, 1), strict=True))
    assert results["variação do índice IPCA (arquivo indice.csv)"] == "5,00%"
    assert results["retorno simples do período"] == "10,00%"
    page.period_end.setCurrentIndex(0)  # an empty period computes nothing
    page._show_returns()
    assert page.returns_table.rowCount() == 0
    csv.write_text("data;valor\n02/01/2026;100,00\n", encoding="utf-8")
    names.append(("CDI", True))
    page.import_benchmark()
    assert boxes[-1] == ("OpesVault", "O arquivo precisa de ao menos duas datas com valores.")


def test_tax_rule_and_redemption_simulator(
    env: tuple[Session, Family], forms: list[dict[str, object] | None], boxes: list[tuple[str, str]]
) -> None:
    from opesvault.investments import service as inv
    from opesvault.investments.model import TaxRuleKind, ValueNature
    from opesvault.ui.pages.investments_page import InvestmentsPage

    m = mount(InvestmentsPage, env)
    pos_id = _value_position(m)
    inv.add_valuation(m.ledger, pos_id, date(2026, 6, 30), "1200.00", ValueNature.GROSS, source="extrato")
    m.page.simulate()
    assert boxes[-1][0] == "Simulador" and not m.steps  # no rule yet
    forms.append({"name": "IR 15%", "kind": TaxRuleKind.RATE_ON_POSITIVE_GAIN, "rate": "quinze"})
    m.page.new_rule()
    assert boxes[-1] == ("OpesVault", "Alíquota inválida.") and not m.ledger.entities("tax_rule")
    forms.append({"name": "", "rate": "15"})
    m.page.new_rule()
    assert boxes[-1] == ("OpesVault", "Informe o nome.")
    forms.append({"name": "IR 15%", "kind": TaxRuleKind.RATE_ON_POSITIVE_GAIN, "rate": "15"})
    m.page.new_rule()
    (rule,) = m.ledger.entities("tax_rule").values()
    assert rule.kind is TaxRuleKind.RATE_ON_POSITIVE_GAIN and rule.rate == Decimal("0.15")
    steps = len(m.sealed())

    forms.append(None)
    m.page.simulate()  # cancelled
    forms.append({"on": date(2026, 6, 30), "gross": "600,00", "rule": rule})
    m.page.simulate()
    title, summary = boxes[-1]
    assert title == "Simulador de resgate" and summary.startswith("SIMULAÇÃO — não registra operação")
    assert "Ganho: R$ 100,00" in summary and "Imposto (estimado): R$ 15,00" in summary
    assert len(m.sealed()) == steps and not m.ledger.journal  # a simulation records nothing


def test_tax_payment_leaves_cash_when_paid(env: tuple[Session, Family], forms: list[dict[str, object] | None]) -> None:
    from opesvault.ui.pages.investments_page import InvestmentsPage

    m = mount(InvestmentsPage, env)
    forms.append({"on": date(2026, 4, 30), "value": "45,00", "from": m.family.bank})
    m.page.pay_tax()
    assert queries.balance(m.ledger, m.family.bank) == Decimal("-45.00") and len(m.sealed()) == 1


def test_trades_by_quantity_honour_the_chosen_cost_method(
    env: tuple[Session, Family], forms: list[dict[str, object] | None], boxes: list[tuple[str, str]]
) -> None:
    """Average cost chosen for a class whose default is per lot must be applied (enum kept)."""
    from opesvault.investments import service as inv
    from opesvault.investments.model import AssetClass, EventKind, TrackingMode
    from opesvault.investments.trades import CostMethod, holding, lots_of
    from opesvault.ui.pages.investments_page import InvestmentsPage

    m = mount(InvestmentsPage, env)
    pos = inv.create_position(
        m.ledger, "Tesouro IPCA", AssetClass.TREASURY, date(2026, 1, 2), mode=TrackingMode.QUANTITY
    )
    m.page.refresh()
    bank = m.family.bank
    forms.append({"on": date(2026, 1, 5), "qty": "10", "price": "10,00", "from": bank})
    m.page.buy()
    forms.append({"on": date(2026, 1, 6), "qty": "10", "price": "20,00", "fees": "0,00", "from": bank})
    m.page.buy()
    forms.append({"on": date(2026, 2, 1), "qty": "10", "price": "30,00", "method": CostMethod.AVERAGE, "to": bank})
    m.page.sell()
    sale = next(e for e in inv.events_of(m.ledger, pos.id) if e.kind is EventKind.SELL)
    assert sale.cost_attributed == Decimal("150.00")  # average of 10,00 and 20,00; per lot would be 100,00
    forms.append({"on": date(2026, 2, 2), "qty": "dez", "price": "30,00", "to": bank})
    m.page.sell()
    assert boxes[-1] == ("OpesVault", "Quantidade inválida.")

    forms.append({"on": date(2026, 1, 3), "qty": "4", "cost": "40,00"})
    m.page.opening()
    forms.append({"on": date(2026, 3, 1), "factor": "2"})
    m.page.split()
    forms.append({"on": date(2026, 3, 2), "qty": "1", "cost": ""})
    m.page.bonus()
    assert holding(m.ledger, pos.id).quantity == (10 + 4) * 2 + 1
    assert len(m.sealed()) == 6 and m.page.lots.rowCount() == len(lots_of(m.ledger, pos.id))


# ── Contas e cartões ────────────────────────────────


def test_members_accounts_cards_and_categories_are_registered(
    env: tuple[Session, Family], monkeypatch: pytest.MonkeyPatch
) -> None:
    from opesvault.domain.model import AccountSubtype, AccountType
    from opesvault.ui.dialogs import AccountDialog, CardDialog, CategoryDialog, MemberDialog
    from opesvault.ui.pages.accounts_page import AccountsPage

    m = mount(AccountsPage, env)
    ledger = m.ledger
    answer_dialog(monkeypatch, MemberDialog, lambda d: d.name.setText("Lia"))
    m.page.add_member()
    lia = next(x for x in ledger.members.values() if x.name == "Lia")
    select_row(m.page.members, lia.id)
    answer_dialog(monkeypatch, MemberDialog, lambda d: d.name.setText("Lia Souza"))
    m.page.edit_member()
    assert ledger.members[lia.id].name == "Lia Souza"

    def new_account(d: AccountDialog) -> None:
        d.name.setText("Corretora")
        select_combo(d.subtype, AccountSubtype.SAVINGS)
        d.opening.setText("250,00")
        d.opening_date.setDate(to_qdate(date(2026, 1, 1)))

    answer_dialog(monkeypatch, AccountDialog, new_account)
    m.page.add_account()
    broker = next(a for a in ledger.accounts.values() if a.name == "Corretora")
    assert queries.balance(ledger, broker.id) == Decimal("250.00")
    select_row(m.page.accounts, broker.id)
    answer_dialog(monkeypatch, AccountDialog, lambda d: d.institution.setText("XP"))
    m.page.edit_account()
    assert ledger.accounts[broker.id].institution == "XP"

    def new_card(d: CardDialog) -> None:
        d.name.setText("Cartão Lia")
        d.last4.setText("9876")
        d.closing.setValue(1)
        d.due.setValue(8)

    answer_dialog(monkeypatch, CardDialog, new_card)
    m.page.add_card()
    card = next(c for c in ledger.cards.values() if c.name == "Cartão Lia")
    select_row(m.page.cards, card.id)
    answer_dialog(monkeypatch, CardDialog, lambda d: d.due.setValue(12))
    m.page.edit_card()
    assert ledger.cards[card.id].due_day == 12

    answer_dialog(monkeypatch, CategoryDialog, lambda d: d.name.setText("Pets"))
    m.page.add_category()
    pets = next(a for a in ledger.categories(AccountType.EXPENSE) if a.name == "Pets")
    assert "Pets" in column(m.page.categories, 0) and pets.parent_id is None
    assert len(m.sealed()) == 7  # each saved dialog is one undo step
    assert m.page.bill_card.findText("Cartão Lia") >= 0  # the bills tab lists the new card


def test_cancelled_dialogs_change_nothing(env: tuple[Session, Family], monkeypatch: pytest.MonkeyPatch) -> None:
    from opesvault.ui.dialogs import AccountDialog, CardDialog, CategoryDialog, MemberDialog
    from opesvault.ui.pages.accounts_page import AccountsPage
    from opesvault.ui.rule_dialog import RuleDialog

    m = mount(AccountsPage, env)
    for cls in (AccountDialog, CardDialog, CategoryDialog, MemberDialog, RuleDialog):
        answer_dialog(monkeypatch, cls, None)
    for action in (m.page.add_member, m.page.add_account, m.page.add_card, m.page.add_category, m.page.add_rule):
        action()
    for action in (m.page.edit_member, m.page.edit_account, m.page.edit_card, m.page.edit_rule, m.page.toggle_rule):
        action()  # nothing selected
    assert not m.steps and not m.notices


def _overdue_bill(m: Mounted[Any]) -> YearMonth:
    from opesvault.domain.cards import bills

    f = m.family
    m.ledger.record_card_purchase(f.card, f.groceries, "300.00", TODAY - timedelta(days=40), "Mercado")
    m.session.undo_stack().seal()
    months = [YearMonth.of(TODAY).add(offset) for offset in range(-6, 7)]
    return next(b.cycle.month for b in bills(m.ledger, f.card, months) if b.total)


def test_bill_is_revealed_and_paid_from_the_bills_tab(
    env: tuple[Session, Family], monkeypatch: pytest.MonkeyPatch
) -> None:
    from opesvault.ui.dialogs import BillPaymentDialog
    from opesvault.ui.pages.accounts_page import AccountsPage

    m = mount(AccountsPage, env)
    month = _overdue_bill(m)
    m.page.refresh()
    m.page.reveal("not a bill")
    assert m.page.tabs.currentIndex() != m.page.bills_tab
    m.page.reveal((m.family.card, month))  # without act: only shows it
    assert m.page.tabs.currentIndex() == m.page.bills_tab and m.page._selected_bill() is not None
    assert m.page.pay_button.isEnabled() and column(m.page.bills, 9) == ["Vencida"]
    opened = answer_dialog(monkeypatch, BillPaymentDialog, None)
    m.page.pay_bill()
    assert len(opened) == 1 and not m.steps  # cancelled
    answer_dialog(monkeypatch, BillPaymentDialog, lambda d: None)  # the remaining amount comes filled in
    m.page.reveal((m.family.card, month), act=True)
    assert m.notices == ["Pagamento da fatura de Cartão X registrado."] and len(m.sealed()) == 1
    assert queries.balance(m.ledger, m.family.card_account) == Decimal("0")
    select_row(m.page.bills, month)
    assert column(m.page.bills, 9) == ["Paga"] and not m.page.pay_button.isEnabled()
    m.page.pay_bill()  # a paid bill has nothing left to pay
    assert len(m.sealed()) == 1


def test_category_rules_are_created_edited_and_switched(
    env: tuple[Session, Family], monkeypatch: pytest.MonkeyPatch
) -> None:
    from opesvault.importing import rules
    from opesvault.ui.pages.accounts_page import AccountsPage
    from opesvault.ui.rule_dialog import RuleDialog

    m = mount(AccountsPage, env)
    groceries = m.family.groceries

    def create(d: RuleDialog) -> None:
        d.pattern.setText("SUPERMERCADO")
        select_combo(d.target, groceries)

    answer_dialog(monkeypatch, RuleDialog, create)
    m.page.add_rule()
    (rule,) = rules.rules(m.ledger).values()
    assert rule.pattern == "SUPERMERCADO" and rule.target_account_id == groceries
    assert m.notices[-1] == "Regra criada. 0 item(ns) pendente(s) recategorizado(s)."
    assert column(m.page.rules, 2) == ["Qualquer conta"] and column(m.page.rules, 4) == ["Ativa"]

    select_row(m.page.rules, rule.id)

    def edit(d: RuleDialog) -> None:
        d.pattern.setText("MERCADO")
        d.reason.setText("pega mais lojas")

    answer_dialog(monkeypatch, RuleDialog, edit)
    m.page.edit_rule()
    assert rules.rules(m.ledger)[rule.id].pattern == "MERCADO" and m.notices[-1] == "Regra alterada."

    reasons: list[str | None] = [None, "não uso mais"]
    monkeypatch.setattr("opesvault.ui.dialogs.ask_reason", lambda *_a: reasons.pop(0))
    select_row(m.page.rules, rule.id)
    m.page.toggle_rule()  # reason refused: nothing changes
    assert rules.rules(m.ledger)[rule.id].active
    m.page.toggle_rule()
    assert not rules.rules(m.ledger)[rule.id].active
    assert m.notices[-1] == "Regra desativada. 0 item(ns) pendente(s) revisto(s)."
    assert column(m.page.rules, 4) == ["Desativada"] and len(m.sealed()) == 3


def test_accounts_page_without_session_is_empty(env: tuple[Session, Family]) -> None:
    from opesvault.ui.pages.accounts_page import AccountsPage

    m = mount(AccountsPage, env)
    assert m.page.accounts.rowCount() > 0
    m.page.set_session(None)
    assert all(t.rowCount() == 0 for t in (m.page.members, m.page.accounts, m.page.cards, m.page.categories))
    m.page._refresh_rules()
    m.page._refresh_bills()
    assert m.page.rules.rowCount() == 0 and m.page.bills.rowCount() == 0 and not m.page.pay_button.isEnabled()


# ── Recorrências ────────────────────────────────────


def _rent_rule(m: Mounted[Any], day: int = 5) -> Any:
    from opesvault.domain.recurrence import RecurrenceRule, add_rule

    start = YearMonth.of(TODAY).add(-2).first_day()
    rule = add_rule(
        m.ledger,
        RecurrenceRule(
            description="Aluguel",
            account_id=m.family.bank,
            counterpart_id=m.family.groceries,
            amount=Decimal("1500.00"),
            day=day,
            start=start,
        ),
    )
    m.session.undo_stack().seal()
    m.page.refresh()
    return rule


def test_recurrence_dialog_validates_and_creates_the_rule(
    env: tuple[Session, Family], monkeypatch: pytest.MonkeyPatch
) -> None:
    from opesvault.domain.recurrence import Frequency, rules
    from opesvault.ui.pages.recurrences_page import RecurrencesPage, RuleDialog

    m = mount(RecurrencesPage, env)
    assert m.page.views.currentIndex() == 1  # empty state
    dialog = RuleDialog(m.page, m.ledger)
    with pytest.raises(DomainError, match="descrição"):
        dialog.validate()
    dialog.description.setText("Escola")
    with pytest.raises(DomainError, match="valor"):
        dialog.validate()

    def fill(d: RuleDialog) -> None:
        d.description.setText("Escola")
        select_combo(d.account, m.family.bank)
        select_combo(d.counterpart, m.family.groceries)
        d.amount.setText("-800,00")  # the sign is the category's, not the typed one
        d.tolerance.setText("10,00")
        select_combo(d.frequency, Frequency.MONTHLY)
        d.day.setValue(10)

    answer_dialog(monkeypatch, RuleDialog, fill)
    m.page.add()
    (rule,) = rules(m.ledger).values()
    assert rule.amount == Decimal("800.00") and rule.tolerance == Decimal("10.00") and rule.day == 10
    assert rule.frequency is Frequency.MONTHLY
    assert m.page.views.currentIndex() == 0 and len(m.sealed()) == 1
    assert m.page.header.subtitle.text() == "1 regra(s) ativa(s)"


def test_recurrence_is_paused_and_forecasts_are_skipped(env: tuple[Session, Family]) -> None:
    from opesvault.domain.recurrence import ForecastStatus, rules
    from opesvault.ui.pages.recurrences_page import RecurrencesPage

    m = mount(RecurrencesPage, env)
    rule = _rent_rule(m)
    assert "Atrasada" in column(m.page.forecast_table, 3)
    late_row = column(m.page.forecast_table, 3).index("Atrasada")
    m.page.forecast_table.selectRow(late_row)
    forecast = m.page._selected_forecast()
    assert forecast is not None and forecast.status is ForecastStatus.LATE
    m.page.skip_selected()
    assert column(m.page.forecast_table, 3)[late_row] == "Pulada"
    select_row(m.page.rules, rule.id)
    m.page.toggle()
    assert rules(m.ledger)[rule.id].paused and column(m.page.rules, 4) == ["Pausada"]
    assert m.page.forecast_table.rowCount() == 0  # a paused rule forecasts nothing
    assert len(m.sealed()) == 2


def test_forecast_alert_links_the_realized_operation(
    env: tuple[Session, Family], monkeypatch: pytest.MonkeyPatch, boxes: list[tuple[str, str]]
) -> None:
    from opesvault.domain.recurrence import ForecastStatus, links
    from opesvault.ui.pages.recurrences_page import RecurrencesPage

    m = mount(RecurrencesPage, env)
    rule = _rent_rule(m)
    late = next(f for f in m.page._forecasts if f.status is ForecastStatus.LATE)
    m.page.reveal((rule.id, late.due_on), act=True)  # no matching operation yet
    assert boxes[-1] == ("Recorrências", "Nenhum lançamento compatível (conta, valor e data).")
    op = m.ledger.record_expense(m.family.bank, m.family.groceries, "1500.00", late.due_on, "Aluguel março")
    m.session.undo_stack().seal()
    m.page.refresh()
    asked: list[list[str]] = []

    def pick(_parent: object, _title: str, _label: str, labels: list[str], *_a: object) -> tuple[str, bool]:
        asked.append(labels)
        return labels[0], len(asked) > 1  # cancelled the first time

    monkeypatch.setattr(QInputDialog, "getItem", staticmethod(pick))
    m.page.reveal("not a forecast", act=True)
    m.page.reveal((rule.id, late.due_on), act=True)
    assert not links(m.ledger)
    m.page.reveal((rule.id, late.due_on), act=True)
    assert asked[-1] == [f"{late.due_on.strftime('%d/%m/%Y')} Aluguel março"]
    (link,) = links(m.ledger).values()
    assert link.operation_id == op.id and len(m.sealed()) == 1
    realized = next(f for f in m.page._forecasts if f.due_on == late.due_on)
    assert realized.status is ForecastStatus.REALIZED and realized.operation_id == op.id


def test_unique_suggestions_are_linked_after_confirmation(
    env: tuple[Session, Family], monkeypatch: pytest.MonkeyPatch, boxes: list[tuple[str, str]]
) -> None:
    from opesvault.domain.recurrence import ForecastStatus, links
    from opesvault.ui.pages.recurrences_page import RecurrencesPage

    m = mount(RecurrencesPage, env)
    m.page.link_suggestions()
    assert boxes[-1] == ("Recorrências", "Nenhuma previsão com um único lançamento compatível.")
    _rent_rule(m)
    late = [f for f in m.page._forecasts if f.status is ForecastStatus.LATE]
    for forecast in late:
        m.ledger.record_expense(m.family.bank, m.family.groceries, "1500.00", forecast.due_on, "Aluguel")
    m.session.undo_stack().seal()
    answers = [False, True]
    asked: list[str] = []

    def confirm(_parent: object, title: str, _message: str, action: str) -> bool:
        asked.append(f"{title}|{action}")
        return answers.pop(0)

    monkeypatch.setattr("opesvault.ui.pages.recurrences_page.confirm", confirm)
    m.page.link_suggestions()
    assert not links(m.ledger) and not m.steps
    m.page.link_suggestions()
    assert asked[-1] == f"Vincular {len(late)} previsão(ões) aos lançamentos?|Vincular"
    assert len(links(m.ledger)) == len(late) and len(m.sealed()) == 1  # every link in one undo step
    assert "Atrasada" not in column(m.page.forecast_table, 3)
    m.page.link_selected()  # nothing selected
    m.page.skip_selected()
    assert len(m.sealed()) == 1


def test_recurrence_navigation_and_empty_session(env: tuple[Session, Family]) -> None:
    from opesvault.ui.pages.recurrences_page import RecurrencesPage

    m = mount(RecurrencesPage, env)
    _rent_rule(m)
    assert m.page.rules.rowCount() == 1
    m.page.set_session(None)
    assert m.page.rules.rowCount() == 0 and m.page.forecast_table.rowCount() == 0
    m.page.add()
    m.page.toggle()
    m.page.link_suggestions()
    assert not m.steps


# ── Orçamento ───────────────────────────────────────


def test_budget_value_is_defined_changed_and_removed(
    env: tuple[Session, Family], monkeypatch: pytest.MonkeyPatch
) -> None:
    from opesvault.ui.pages.budget_page import BudgetDialog, BudgetPage

    m = mount(BudgetPage, env)
    month = m.page.month.current()
    groceries = m.family.groceries
    assert m.page.views.currentWidget() is m.page.empty
    opened = answer_dialog(monkeypatch, BudgetDialog, None)
    m.page.define()
    assert len(opened) == 1 and not m.steps

    def fill(d: BudgetDialog) -> None:
        select_combo(d.category, groceries)
        d.amount.setText("600,00")

    answer_dialog(monkeypatch, BudgetDialog, fill)
    m.page.define()
    line = budget.line_for(m.ledger, groceries, month)
    assert line is not None and line.amount == Decimal("600.00")
    assert m.notices[-1].startswith("Orçamento de ") and m.notices[-1].endswith(" atualizado.")
    assert m.page.views.currentWidget() is m.page.table

    m.page.reveal((groceries, month))
    seen: list[str] = []

    def change(d: BudgetDialog) -> None:
        seen.append(d.amount.text())
        assert not d.category.isEnabled()  # editing a row keeps its category
        d.amount.setText("650,00")

    answer_dialog(monkeypatch, BudgetDialog, change)
    m.page.edit_selected()
    assert seen == ["600,00"]
    assert budget.line_for(m.ledger, groceries, month).amount == Decimal("650.00")  # type: ignore[union-attr]
    m.page.reveal((groceries, month))
    m.page.remove_selected()
    assert budget.line_for(m.ledger, groceries, month) is None
    assert m.notices[-1] == "Categoria removida do orçamento. Ctrl+Z desfaz."
    assert len(m.sealed()) == 3
    m.session.undo_stack().undo()
    assert budget.line_for(m.ledger, groceries, month) is not None


def test_budget_dialog_refuses_empty_and_non_positive_values(env: tuple[Session, Family]) -> None:
    from opesvault.ui.pages.budget_page import BudgetDialog, BudgetGridDialog

    session, f = env
    month = YearMonth(year=2026, month=5)
    dialog = BudgetDialog(None, session.ledger, month)
    dialog.category.setCurrentIndex(-1)
    with pytest.raises(DomainError, match="categoria"):
        dialog.validate()
    select_combo(dialog.category, f.groceries)
    for typed in ("", "0,00"):
        dialog.amount.setText(typed)
        with pytest.raises(DomainError):
            dialog.validate()
    grid = BudgetGridDialog(None, session.ledger, month)
    grid.edits[0].setText("-5,00")
    grid._try_accept()
    assert not grid.error.isHidden() and "valor positivo" in grid.error.text()
    assert grid.result() == 0  # still open
    grid.edits[0].clear()
    grid._try_accept()
    assert grid.result() == 1
    for widget in (dialog, grid):
        widget.deleteLater()


def test_month_grid_and_copy_from_the_previous_month(
    env: tuple[Session, Family], monkeypatch: pytest.MonkeyPatch, boxes: list[tuple[str, str]]
) -> None:
    from opesvault.ui.pages.budget_page import BudgetGridDialog, BudgetPage

    m = mount(BudgetPage, env)
    month = m.page.month.current()
    groceries = m.family.groceries
    m.page.copy_previous()
    assert boxes[-1][0] == "Orçamento" and boxes[-1][1].startswith("Nada a copiar") and not m.steps
    budget.set_budget(m.ledger, groceries, month.add(-1), "400.00")
    m.session.undo_stack().seal()
    m.page.copy_previous()
    assert budget.line_for(m.ledger, groceries, month).amount == Decimal("400.00")  # type: ignore[union-attr]
    assert m.notices[-1].startswith("1 categoria(s) copiada(s)") and len(m.sealed()) == 1

    def grid(d: BudgetGridDialog) -> None:
        rows = {category_id: i for i, (_, category_id) in enumerate(d.categories)}
        d.edits[rows[groceries]].setText("450,00")

    answer_dialog(monkeypatch, BudgetGridDialog, grid)
    m.page.define_month()
    assert budget.line_for(m.ledger, groceries, month).amount == Decimal("450.00")  # type: ignore[union-attr]
    assert m.notices[-1].endswith(": 1 categoria(s) alterada(s).") and len(m.sealed()) == 2
    answer_dialog(monkeypatch, BudgetGridDialog, lambda d: None)  # saved without changes
    m.page.define_month()
    assert len(m.sealed()) == 2


def test_budget_status_words_and_shared_month(env: tuple[Session, Family]) -> None:
    from opesvault.ui.pages.budget_page import BudgetPage

    m = mount(BudgetPage, env)
    month = YearMonth(year=2026, month=3)
    m.page.follow_month(month)  # following another page does not echo the month back
    assert m.page.month.current() == month and not m.months
    budget.set_budget(m.ledger, m.family.groceries, month, "100.00")
    m.ledger.record_expense(m.family.bank, m.family.groceries, "150.00", date(2026, 3, 10), "Feira")
    m.page.refresh()
    assert column(m.page.table, 5) == ["Estourado"] and column(m.page.table, 4) == ["150%"]
    assert m.page.header.subtitle.text() == "1 categoria(s) estourada(s)"
    m.page.month.set_month(month.add(1))  # chosen here: the other pages follow
    assert m.months == [month.add(1)]
    m.page.reveal("not a budget alert")
    assert m.page.month.current() == month.add(1)
    m.page.set_session(None)
    assert m.page.table.rowCount() == 0
    m.page.define()
    m.page.define_month()
    m.page.copy_previous()
    m.page.remove_selected()
    assert not m.steps


# ── Relatórios ──────────────────────────────────────


def test_month_of_reads_only_monthly_labels() -> None:
    from opesvault.ui.pages.reports_page import _month_of

    assert _month_of("2026-03") == YearMonth(year=2026, month=3)
    assert _month_of("Alimentação") is None and _month_of(None) is None


def _shown_reports(env: tuple[Session, Family]) -> Mounted[Any]:
    from opesvault.ui.pages.reports_page import ReportsPage

    m = mount(ReportsPage, env)
    m.page.resize(900, 600)
    m.page.show()  # filters count only while visible to the page
    m.page.follow_month(YearMonth(year=2026, month=3))
    return m


def test_category_report_opens_the_ledger_by_month_or_whole_period(env: tuple[Session, Family]) -> None:
    from opesvault.charts.data import Point

    _, f = env
    f.ledger.record_expense(f.bank, f.groceries, "70.00", date(2026, 3, 9), "Feira")
    m = _shown_reports(env)
    page = m.page
    page.reveal("categories")
    assert page._key() == "categories" and not page.scope.isHidden()
    page.inspect("Despesas", Point("Alimentação", Decimal("70.00")))
    start, end = page._range()
    page._open_ledger()
    assert m.navigations[-1] == ("ledger", ("filter", f.groceries, (start.first_day(), end.last_day()), None), False)
    page.inspect("Despesas", Point("Sem nome", Decimal("1")))
    assert not page.open_ledger.isEnabled()  # a bar that is not a category
    select_combo(page.scope, f.groceries)
    page.inspect("Alimentação", Point("2026-03", Decimal("70.00")))
    page._open_ledger()
    assert m.navigations[-1][1] == ("filter", f.groceries, YearMonth(year=2026, month=3), None)


def test_result_report_filters_by_member_and_position_charts_have_no_ledger(env: tuple[Session, Family]) -> None:
    from opesvault.charts.data import Point

    m = _shown_reports(env)
    page = m.page
    page.reveal("result")
    labels = [page.scope.itemText(i) for i in range(page.scope.count())]
    assert labels == ["Família inteira", "Ana", "Bruno"]
    select_combo(page.scope, m.family.bruno)
    page.inspect("Resultado", Point("2026-02", Decimal("10")))
    assert page._ledger_ref() == ("filter", None, YearMonth(year=2026, month=2), m.family.bruno)
    for key in ("net_worth", "composition", "projection"):
        page.reveal(key)
        assert page._key() == key and page.scope.isHidden()
        page.inspect("x", Point("2026-02", Decimal("10")))
        assert not page.open_ledger.isEnabled()
    count = len(m.navigations)
    page._open_ledger()
    assert len(m.navigations) == count
    page.reveal("unknown")
    assert page._key() == "projection"


def test_report_follows_the_month_and_period(env: tuple[Session, Family]) -> None:
    from opesvault.charts.data import Point

    m = _shown_reports(env)
    page = m.page
    assert page.header.subtitle.text() == "De abril de 2025 a março de 2026"
    assert page._range() == (YearMonth(year=2025, month=4), YearMonth(year=2026, month=3))
    page.months.setCurrentIndex(0)
    assert page._range()[0] == YearMonth(year=2025, month=10)
    page.inspect("Saídas", Point("2026-03", Decimal("1")))
    page.follow_month(YearMonth(year=2026, month=3))  # same month: the inspected point stays
    assert page._inspected is not None
    page.follow_month("março")
    page.follow_month(YearMonth(year=2026, month=4))
    assert page._inspected is None and page._range()[1] == YearMonth(year=2026, month=4)


def test_export_asks_before_writing_outside_the_vault(
    env: tuple[Session, Family], monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    m = _shown_reports(env)
    page = m.page
    target = tmp_path / "grafico.png"
    paths = ["", str(target), str(target)]
    monkeypatch.setattr(QFileDialog, "getSaveFileName", staticmethod(lambda *_a, **_k: (paths.pop(0), "")))
    answers = [False, True]
    monkeypatch.setattr("opesvault.ui.pages.reports_page.confirm", lambda *_a: answers.pop(0))
    written: list[str] = []
    monkeypatch.setattr(page.chart, "export_png", written.append)
    page.export()  # no file chosen
    page.export()  # refused in the confirmation
    assert not written and len(answers) == 1
    page.export()
    assert written == [str(target)]
    page.chart.chart = None
    page.export()  # nothing drawn: nothing to export
    assert len(paths) == 0 and written == [str(target)]


def test_reports_without_session_build_nothing(env: tuple[Session, Family]) -> None:
    m = _shown_reports(env)
    m.page.set_session(None)
    assert m.page.build() is None and m.page.scope.isHidden() and m.page._ledger_ref() is None


# ── Visão geral ─────────────────────────────────────


def test_tone_follows_the_sign() -> None:
    from opesvault.ui.pages.overview_page import _tone

    assert [_tone(None), _tone(Decimal("0")), _tone(Decimal("1")), _tone(Decimal("-1"))] == [
        None,
        None,
        "positive",
        "negative",
    ]


def test_overview_opens_on_the_latest_month_with_activity(env: tuple[Session, Family]) -> None:
    from opesvault.ui.pages.overview_page import SHARE_ROLE, OverviewPage

    _, f = env
    ledger = f.ledger
    for name, amount in (("Alimentação", "300.00"), ("Transporte", "100.00"), ("Lazer", "100.00")):
        category = next(a.id for a in ledger.accounts.values() if a.name == name)
        ledger.record_expense(f.bank, category, amount, date(2025, 11, 10), name)
    m = mount(OverviewPage, env)
    november = YearMonth(year=2025, month=11)
    assert m.page.month.current() == november and m.months == [november]
    assert column(m.page.categories, 0)[0] == "Alimentação" and column(m.page.categories, 2) == ["60%", "20%", "20%"]
    item = m.page.categories.item(0, 2)
    assert item is not None and item.data(SHARE_ROLE) == pytest.approx(0.6)
    m.page.resize(900, 700)
    m.page.show()
    assert not m.page.categories.grab().isNull()  # the share bars paint
    m.page._open_row(m.page.balances, 0)
    assert m.navigations[-1][0] == "ledger" and m.navigations[-1][1][2] == november  # type: ignore[index]
    m.page._open_row(m.page.balances, 99)  # no such row
    assert len(m.navigations) == 1
    m.page.follow_month(YearMonth(year=2025, month=12))
    assert m.months == [november]  # followed, not chosen
    m.page.show_alerts()
    assert m.page.month.current() == YearMonth(year=2025, month=12)


def test_month_is_closed_with_a_note_when_pending_and_reopened(
    env: tuple[Session, Family], monkeypatch: pytest.MonkeyPatch
) -> None:
    from opesvault.domain.periods import is_closed, pending_items
    from opesvault.importing.pipeline import ImportRequest, import_document
    from opesvault.ui.pages.overview_page import OverviewPage

    session, f = env
    import_document(session, ImportRequest("x.csv", _statement("LOJA 1"), account_id=f.bank))
    session.undo_stack().seal()
    m = mount(OverviewPage, env)
    m.page.month.set_month(YearMonth(year=2026, month=2))
    month = m.page.month.current()
    assert pending_items(m.ledger, month) and not m.page.pending_section.isHidden()
    reasons: list[str | None] = [None, "conferido com o extrato", None, "faltou um lançamento"]
    monkeypatch.setattr("opesvault.ui.dialogs.ask_reason", lambda *_a: reasons.pop(0))
    m.page.close_month()  # justification refused
    assert not is_closed(m.ledger, month)
    m.page.close_month()
    assert is_closed(m.ledger, month) and m.page.header.subtitle.text() == "Mês fechado"
    assert m.page.close_button.isHidden() and not m.page.reopen_button.isHidden()
    assert m.notices[-1] == "Fevereiro de 2026 fechado."
    m.page.reopen_month()
    assert is_closed(m.ledger, month)
    m.page.reopen_month()
    assert not is_closed(m.ledger, month) and m.notices[-1] == "Fevereiro de 2026 reaberto."
    assert len(m.sealed()) == 2


def test_month_without_pending_closes_without_asking(
    env: tuple[Session, Family], monkeypatch: pytest.MonkeyPatch
) -> None:
    from opesvault.domain.periods import is_closed
    from opesvault.ui.pages.overview_page import OverviewPage

    m = mount(OverviewPage, env)
    monkeypatch.setattr("opesvault.ui.dialogs.ask_reason", lambda *_a: pytest.fail("no reason is needed"))
    m.page.close_month()
    assert is_closed(m.ledger, m.page.month.current()) and len(m.sealed()) == 1
    m.page.set_session(None)
    m.page.close_month()
    m.page.reopen_month()
    assert len(m.sealed()) == 1


# ── Documentos ──────────────────────────────────────


def test_documents_list_preview_and_open_the_review(env: tuple[Session, Family]) -> None:
    from opesvault.importing.pipeline import ImportRequest, import_document
    from opesvault.ui.pages.documents_page import DocumentsPage

    from . import synthetic_docs as docs

    session, f = env
    batch = import_document(session, ImportRequest("extrato.csv", _statement("LOJA 1"), account_id=f.bank))
    pdf = session.add_document("solto.pdf", docs.nubank_card_pdf())
    session.undo_stack().seal()
    m = mount(DocumentsPage, env)
    page = m.page
    assert page.views.currentIndex() == 0 and page.header.subtitle.text().startswith("2 arquivo(s) · ")
    rows = {
        name: (where, state) for name, where, state in zip(*(column(page.table, c) for c in (0, 2, 3)), strict=True)
    }
    assert rows["extrato.csv"][0] == "Banco A" and rows["solto.pdf"] == ("—", "Sem importação")
    # The list is sorted on screen; each file still carries its own size and hash.
    csv_doc = session.document(batch.document_id)
    for row in range(page.table.rowCount()):
        item = page.table.item(row, 0)
        assert item is not None
        own = pdf if item.text() == "solto.pdf" else csv_doc
        assert item.toolTip().endswith(f"SHA-256 {own.meta.sha256}")

    select_row(page.table, pdf.meta.id)
    assert not page.open_review.isEnabled() and page.viewer.data == pdf.data
    assert page.viewer._pdf is not None and page.viewer.image.pixmap() is not None
    page._open_review()
    assert not m.navigations  # a loose document has no review

    select_row(page.table, batch.document_id)
    assert page.open_review.isEnabled()
    assert page.viewer.image.text() == "Arquivo estruturado (CSV/OFX): sem visualização de página."
    assert page.viewer._pdf is None and page.viewer.data is None  # the previous PDF is not kept around
    page._open_review()
    assert m.navigations == [("import", batch.id, False)]

    page.set_session(None)
    assert page.table.rowCount() == 0 and page.viewer.image.text() == "Nenhum documento selecionado"


def test_empty_vault_shows_the_empty_state(env: tuple[Session, Family]) -> None:
    from opesvault.ui.pages.documents_page import DocumentsPage

    m = mount(DocumentsPage, env)
    assert m.page.views.currentIndex() == 1 and m.page.table.rowCount() == 0


def test_viewer_reports_unreadable_pdfs_and_turns_pages(app: QApplication) -> None:
    from opesvault.ui.pages.documents_page import PdfView

    from . import synthetic_docs as docs

    view = PdfView()
    view.show_pdf(b"not a pdf")
    assert view.image.text() == "Não foi possível abrir este PDF." and view._pdf is None
    data = docs.nubank_card_pdf()
    view.show_pdf(data, page=1, highlight=(10.0, 10.0, 60.0, 20.0))
    assert view._pdf is not None and view.page.value() == 1 and view.page.maximum() >= 1
    assert not view.image.pixmap().isNull()
    handle = view._pdf
    view.show_pdf(data, page=1)  # another item of the same document keeps the open handle
    assert view._pdf is handle
    view.show_pdf(None)
    assert view._pdf is None and view.image.text() == "Nenhum documento selecionado"
    view.deleteLater()


def test_viewer_asks_for_the_password_until_it_opens(app: QApplication, monkeypatch: pytest.MonkeyPatch) -> None:
    from opesvault.ui.pages.documents_page import PdfView

    from .test_pdf_password import PASSWORD, encrypted

    view = PdfView()
    view.show_pdf(encrypted("AES-256"), page=1)
    assert view.image.text() == "Este PDF é protegido por senha." and not view.unlock_button.isHidden()
    answers = [("", False), ("errada", True), (PASSWORD, True)]
    monkeypatch.setattr(QInputDialog, "getText", staticmethod(lambda *_a, **_k: answers.pop(0)))
    view.ask_password()  # cancelled
    assert view._pdf is None
    view.ask_password()
    assert view.image.text() == "Senha incorreta. Tente de novo." and view._pdf is None
    view.ask_password()
    assert view._pdf is not None and view.unlock_button.isHidden() and not view.image.pixmap().isNull()
    view.show_pdf(None)
    view.deleteLater()


def test_identical_candidates_get_distinct_labels() -> None:
    from opesvault.ui.pages.recurrences_page import distinct_labels

    labels = distinct_labels(["05/03/2026 Aluguel", "05/03/2026 Aluguel", "06/03/2026 Aluguel"])
    assert labels == ["05/03/2026 Aluguel", "05/03/2026 Aluguel (2)", "06/03/2026 Aluguel"]
    assert labels.index("05/03/2026 Aluguel (2)") == 1  # the second entry is reachable by its label
