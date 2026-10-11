"""Edge cases and guard paths of the domain layer (docs/04 invariants, docs/06 §9 money rules).

Every rejected change must leave the ledger untouched and say why in Portuguese.
"""

import json
import re
from datetime import date
from decimal import Decimal
from uuid import UUID, uuid4

import pytest

from opesvault.domain import queries
from opesvault.domain.alerts import Severity, Target, _when, card_alerts, recurrence_alerts
from opesvault.domain.cards import (
    CompetencePolicy,
    bills,
    find_plan_for_installment,
    plans,
    record_installment_purchase,
)
from opesvault.domain.edits import reclassify
from opesvault.domain.ledger import MISSING, SCHEMA_VERSION, DomainError, Ledger, LedgerMeta
from opesvault.domain.model import (
    AccountSubtype,
    AccountType,
    AdditionalCard,
    Card,
    HistoryEntry,
    LedgerAccount,
    MemberRole,
    Operation,
    OperationKind,
    OperationStatus,
    Posting,
    YearMonth,
)
from opesvault.domain.money import (
    MoneyError,
    allocate,
    format_brl,
    format_decimal_br,
    is_cents,
    round_money,
    to_decimal,
)
from opesvault.domain.onboarding import AccountPlan, CardPlan, SetupPlan, apply_setup, check_plan
from opesvault.domain.periods import close_month, closed_figures_unchanged, is_closed, months_of, reopen_month
from opesvault.domain.recurrence import (
    ForecastStatus,
    Frequency,
    RecurrenceRule,
    add_rule,
    candidates,
    forecasts,
    occurrences,
    realize,
    skip,
    update_rule,
)

from .domain_fixtures import Family, family

D = Decimal
JAN = YearMonth(year=2026, month=1)


def exact(message: str) -> str:
    """`pytest.raises(match=...)` pattern for exactly this user-facing message."""
    return f"^{re.escape(message)}$"


def snapshot(ledger: Ledger) -> tuple[int, int, int]:
    return len(ledger.operations), len(ledger.history), len(ledger.accounts)


def op(*postings: tuple[UUID, str], **extra: object) -> Operation:
    return Operation(
        kind=OperationKind.OTHER,
        description="teste",
        postings=tuple(Posting(account_id=a, amount=D(v)) for a, v in postings),
        occurred_on=date(2026, 1, 10),
        **extra,  # type: ignore[arg-type]
    )


# ── money ───────────────────────────────────────────


@pytest.mark.parametrize(
    ("value", "expected"),
    [(7, D("7")), (" 12.50 ", D("12.50")), (D("-3.1"), D("-3.1")), ("1e2", D("100"))],
)
def test_to_decimal_accepts_exact_inputs(value: object, expected: Decimal) -> None:
    result = to_decimal(value)
    assert result == expected and isinstance(result, Decimal)


@pytest.mark.parametrize(
    ("value", "message"),
    [
        (1.5, "float or bool is not accepted for financial values"),
        (True, "float or bool is not accepted for financial values"),
        ("doze", "invalid decimal"),
        ("", "invalid decimal"),
        (None, "unsupported type: NoneType"),
        ([1], "unsupported type: list"),
        ("NaN", "non-finite value"),
        ("Infinity", "non-finite value"),
        (D("-Infinity"), "non-finite value"),
    ],
)
def test_to_decimal_rejects_inexact_or_invalid_values(value: object, message: str) -> None:
    with pytest.raises(MoneyError, match=exact(message)):
        to_decimal(value)


@pytest.mark.parametrize(
    ("value", "expected"),
    [("0.005", "0.01"), ("-0.005", "-0.01"), ("2.675", "2.68"), ("0.015", "0.02"), ("1.004", "1.00")],
)
def test_round_money_breaks_ties_away_from_zero(value: str, expected: str) -> None:
    # ROUND_HALF_EVEN would give 0.00 / 2.67 / 0.02 here; management rounding is half-up.
    assert round_money(D(value)) == D(expected)


@pytest.mark.parametrize(
    ("value", "places", "expected"),
    [
        (D("1234567.891"), None, "1.234.567,891"),
        (D("-1234.5"), None, "-1.234,5"),
        (D("1000"), None, "1.000"),
        (D("999"), None, "999"),
        (D("0.125"), 2, "0,13"),
        (D("-2.5"), 0, "-3"),
    ],
)
def test_format_decimal_br(value: Decimal, places: int | None, expected: str) -> None:
    assert format_decimal_br(value, places) == expected


@pytest.mark.parametrize(
    ("value", "sign", "expected"),
    [
        (D("1234567.8"), False, "R$ 1.234.567,80"),
        (D("-0.004"), False, "R$ 0,00"),  # rounds to zero: never "-R$ 0,00"
        (D("5"), True, "+R$ 5,00"),
        (D("0"), True, "R$ 0,00"),
        (D("-5"), True, "-R$ 5,00"),
    ],
)
def test_format_brl_signs(value: Decimal, sign: bool, expected: str) -> None:
    assert format_brl(value, sign=sign) == expected


@pytest.mark.parametrize(
    ("total", "weights"),
    [
        (D("10.00"), []),
        (D("10.00"), [D("1"), D("-1"), D("1")]),
        (D("10.00"), [D("0"), D("0")]),
    ],
)
def test_allocate_rejects_invalid_weights(total: Decimal, weights: list[Decimal]) -> None:
    with pytest.raises(MoneyError, match=exact("invalid weights")):
        allocate(total, weights)


def test_allocate_requires_cents_and_keeps_negative_totals_exact() -> None:
    with pytest.raises(MoneyError, match=exact("total must be in cents")):
        allocate(D("10.001"), [D("1"), D("1")])
    parts = allocate(D("-10.00"), [D("1"), D("1"), D("1")])
    assert sum(parts) == D("-10.00") and all(is_cents(p) for p in parts)
    assert sorted(parts) == [D("-3.34"), D("-3.33"), D("-3.33")]


# ── ledger: change journal and tracked collections ──


def test_missing_marker_is_distinct_from_none() -> None:
    assert repr(MISSING) == "MISSING" and MISSING is not None


def test_meta_change_is_undone_and_redone_through_the_journal() -> None:
    f = family()
    f.ledger.journal = []
    original = f.ledger.meta
    f.ledger.meta = original.model_copy(update={"family_name": "Outra família"})
    entries = list(f.ledger.journal)
    f.ledger.revert(entries)
    assert f.ledger.meta == original
    f.ledger.replay(entries)
    assert f.ledger.meta.family_name == "Outra família"
    # Revert and replay are not journaled themselves.
    assert f.ledger.journal == entries


def test_pop_from_tracked_collection_is_journaled_only_when_something_was_removed() -> None:
    f = family()
    f.ledger.journal = []
    assert f.ledger.members.pop(uuid4(), None) is None
    assert f.ledger.journal == []
    removed = f.ledger.members.pop(f.bruno)
    assert removed.name == "Bruno" and f.bruno not in f.ledger.members
    assert ("member", f.bruno) in f.ledger.dirty
    f.ledger.revert(list(f.ledger.journal))
    assert f.ledger.members[f.bruno] == removed


def test_external_journal_entries_are_called_in_both_directions() -> None:
    f = family()
    calls: list[bool] = []
    entries = [("external", calls.append)]
    f.ledger.revert(entries)
    f.ledger.replay(entries)
    assert calls == [False, True]


def test_unknown_kinds_get_a_collection_on_demand() -> None:
    ledger = Ledger.new("F")
    collection = ledger.entities("not_registered_yet")
    assert collection == {} and ledger.entities("not_registered_yet") is collection


def test_put_requires_a_reason_to_replace_an_entity() -> None:
    f = family()
    member = f.ledger.members[f.ana]
    with pytest.raises(DomainError, match=exact("Alterações exigem um motivo.")):
        f.ledger.put("member", member.model_copy(update={"name": "Ana Maria"}))
    assert f.ledger.members[f.ana].name == "Ana"


# ── ledger: members, accounts and cards ─────────────


def test_member_names_are_unique_ignoring_case_and_spaces() -> None:
    f = family()
    with pytest.raises(DomainError, match=exact("Já existe um integrante com esse nome.")):
        f.ledger.add_member("  ana ")
    kid = f.ledger.add_member(" Caio ", MemberRole.DEPENDENT)
    assert kid.name == "Caio" and kid.role is MemberRole.DEPENDENT


def test_update_member_needs_an_existing_member() -> None:
    f = family()
    stranger = f.ledger.members[f.ana].model_copy(update={"id": uuid4()})
    with pytest.raises(DomainError, match=exact("Integrante inexistente.")):
        f.ledger.update_member(stranger, "motivo")
    renamed = f.ledger.update_member(f.ledger.members[f.ana].model_copy(update={"name": "Ana Paula"}), "grafia")
    assert f.ledger.history_of(f.ana)[-1].reason == "grafia" and renamed.name == "Ana Paula"


def _account(**fields: object) -> LedgerAccount:
    base: dict[str, object] = {"name": "Nova", "type": AccountType.ASSET, "subtype": AccountSubtype.CHECKING}
    return LedgerAccount(**{**base, **fields})  # type: ignore[arg-type]


@pytest.mark.parametrize(
    ("fields", "message"),
    [
        ({"holders": (uuid4(),)}, "Titular inexistente."),
        (
            {"type": AccountType.ASSET, "subtype": AccountSubtype.CREDIT_CARD},
            "Tipo de conta incompatível com o subtipo.",
        ),
        ({"type": AccountType.ASSET, "subtype": AccountSubtype.LOAN}, "Tipo de conta incompatível com o subtipo."),
        (
            {"type": AccountType.ASSET, "subtype": AccountSubtype.TAX_PAYABLE},
            "Tipo de conta incompatível com o subtipo.",
        ),
        (
            {"type": AccountType.LIABILITY, "subtype": AccountSubtype.OPENING_EQUITY},
            "Tipo de conta incompatível com o subtipo.",
        ),
        ({"type": AccountType.ASSET, "subtype": AccountSubtype.CATEGORY}, "Categorias são de receita ou despesa."),
        ({"parent_id": uuid4()}, "Categoria-mãe inválida."),
    ],
)
def test_invalid_accounts_are_rejected(fields: dict[str, object], message: str) -> None:
    f = family()
    before = snapshot(f.ledger)
    with pytest.raises(DomainError, match=exact(message)):
        f.ledger.add_account(_account(**fields))
    assert snapshot(f.ledger) == before


def test_parent_category_must_have_the_same_type() -> None:
    f = family()
    child = _account(type=AccountType.INCOME, subtype=AccountSubtype.CATEGORY, parent_id=f.groceries)
    with pytest.raises(DomainError, match=exact("Categoria-mãe inválida.")):
        f.ledger.add_account(child)


def test_category_hierarchy_cannot_be_circular() -> None:
    f = family()
    child = f.ledger.add_account(
        _account(name="Mercado", type=AccountType.EXPENSE, subtype=AccountSubtype.CATEGORY, parent_id=f.groceries)
    )
    grandchild = f.ledger.add_account(
        _account(name="Feira", type=AccountType.EXPENSE, subtype=AccountSubtype.CATEGORY, parent_id=child.id)
    )
    looped = f.ledger.accounts[f.groceries].model_copy(update={"parent_id": grandchild.id})
    with pytest.raises(DomainError, match=exact("Hierarquia de categorias circular.")):
        f.ledger.update_account(looped, "reorganização")
    assert f.ledger.accounts[f.groceries].parent_id is None


def test_type_or_currency_of_a_used_account_cannot_change() -> None:
    f = family()
    unused = f.ledger.accounts[f.savings].model_copy(update={"currency": "USD"})
    assert f.ledger.update_account(unused, "conta no exterior").currency == "USD"
    f.ledger.record_opening_balance(f.bank, "10.00", date(2026, 1, 1))
    used = f.ledger.accounts[f.bank].model_copy(update={"type": AccountType.LIABILITY})
    with pytest.raises(DomainError, match=exact("Não é possível mudar tipo ou moeda de uma conta com lançamentos.")):
        f.ledger.update_account(used, "engano")
    renamed = f.ledger.update_account(f.ledger.accounts[f.bank].model_copy(update={"name": "Banco B"}), "nome")
    assert renamed.name == "Banco B"


def test_update_account_needs_an_existing_account() -> None:
    f = family()
    with pytest.raises(DomainError, match=exact("Conta inexistente.")):
        f.ledger.update_account(_account(), "motivo")


def _card(f: Family, **fields: object) -> Card:
    base: dict[str, object] = {
        "name": "Cartão Y",
        "liability_account_id": f.card_account,
        "holder_id": f.ana,
        "last4": "9999",
        "closing_day": 5,
        "due_day": 12,
    }
    return Card(**{**base, **fields})  # type: ignore[arg-type]


@pytest.mark.parametrize(
    ("field", "message"),
    [
        ("liability_bank", "O cartão precisa de uma conta de cartão de crédito."),
        ("liability_missing", "O cartão precisa de uma conta de cartão de crédito."),
        ("holder", "Portador inexistente."),
        ("additional", "Portador inexistente."),
        ("settlement_missing", "Conta de pagamento da fatura inválida."),
        ("settlement_card", "Conta de pagamento da fatura inválida."),
    ],
)
def test_invalid_cards_are_rejected(field: str, message: str) -> None:
    f = family()
    fields = {
        "liability_bank": {"liability_account_id": f.bank},
        "liability_missing": {"liability_account_id": uuid4()},
        "holder": {"holder_id": uuid4()},
        "additional": {"additional": (AdditionalCard(member_id=uuid4(), last4="1111"),)},
        "settlement_missing": {"settlement_account_id": uuid4()},
        "settlement_card": {"settlement_account_id": f.card_account},
    }[field]
    before = len(f.ledger.cards)
    with pytest.raises(DomainError, match=exact(message)):
        f.ledger.add_card(_card(f, **fields))
    assert len(f.ledger.cards) == before


def test_update_card_validates_like_add_card() -> None:
    f = family()
    with pytest.raises(DomainError, match=exact("Cartão inexistente.")):
        f.ledger.update_card(_card(f), "motivo")
    current = f.ledger.cards[f.card]
    with pytest.raises(DomainError, match=exact("Portador inexistente.")):
        f.ledger.update_card(current.model_copy(update={"holder_id": uuid4()}), "motivo")
    extra = AdditionalCard(member_id=f.bruno, last4="4321")
    updated = f.ledger.update_card(current.model_copy(update={"additional": (extra,)}), "adicional do Bruno")
    assert updated.additional == (extra,)


# ── ledger: operation invariants (docs/04 §2) ──────


def test_validate_operation_guard_table() -> None:
    f = family()
    bank, groceries = f.bank, f.groceries
    cases: list[tuple[Operation, str]] = [
        (op((bank, "10.00")), "Uma operação precisa de pelo menos duas partidas."),
        (op((bank, "10.00"), (uuid4(), "-10.00")), "Partida aponta para conta inexistente."),
        (op((bank, "0"), (groceries, "0")), "Partidas de valor zero não são permitidas."),
        (op((bank, "10.00"), (groceries, "-10.00"), currency="USD"), "Moeda da conta difere da moeda da operação."),
        (op((bank, "10.001"), (groceries, "-10.001")), "Valores em reais precisam estar em centavos."),
        (op((bank, "10.00"), (groceries, "-9.99")), "Débitos e créditos não se equilibram."),
        (op((bank, "10.00"), (groceries, "-10.00"), member_id=uuid4()), "Integrante inexistente."),
        (op((bank, "10.00"), (groceries, "-10.00"), card_id=uuid4()), "Cartão inexistente."),
        (op((bank, "10.00"), (groceries, "-10.00"), cardholder_id=uuid4()), "Portador inexistente."),
        (op((bank, "10.00"), (groceries, "-10.00"), reversal_of=uuid4()), "Estorno de operação inexistente."),
    ]
    split_member = Operation(
        kind=OperationKind.OTHER,
        description="rateio",
        postings=(
            Posting(account_id=groceries, amount=D("10.00"), member_id=uuid4()),
            Posting(account_id=bank, amount=D("-10.00")),
        ),
    )
    cases.append((split_member, "Integrante do rateio inexistente."))
    before = snapshot(f.ledger)
    for candidate, message in cases:
        with pytest.raises(DomainError, match=exact(message)):
            f.ledger.add_operation(candidate)
    assert snapshot(f.ledger) == before


def test_non_brl_accounts_accept_sub_cent_amounts_in_their_own_currency() -> None:
    f = family()
    usd_a = f.ledger.add_account(_account(name="Conta USD", currency="USD")).id
    usd_b = f.ledger.add_account(_account(name="Corretora USD", currency="USD")).id
    created = f.ledger.add_operation(op((usd_a, "0.001"), (usd_b, "-0.001"), currency="USD"))
    assert created.version == 1


def test_operation_ids_cannot_be_reused() -> None:
    f = family()
    first = f.ledger.record_transfer(f.bank, f.savings, "5.00", date(2026, 1, 2))
    with pytest.raises(DomainError, match=exact("Operação já existe.")):
        f.ledger.add_operation(first)


def test_update_operation_guards() -> None:
    f = family()
    expense = f.ledger.record_expense(f.bank, f.groceries, "30.00", date(2026, 1, 5), "Feira")
    with pytest.raises(DomainError, match=exact("Operação inexistente.")):
        f.ledger.update_operation(expense.model_copy(update={"id": uuid4()}), "motivo")
    with pytest.raises(DomainError, match=exact("Correções exigem um motivo.")):
        f.ledger.update_operation(expense, "   ")
    unbalanced = expense.model_copy(
        update={"postings": (expense.postings[0], Posting(account_id=f.bank, amount=D("-1")))}
    )
    with pytest.raises(DomainError, match=exact("Débitos e créditos não se equilibram.")):
        f.ledger.update_operation(unbalanced, "valor")
    assert f.ledger.operations[expense.id].version == 1
    f.ledger.cancel_operation(expense.id, "duplicada")
    with pytest.raises(DomainError, match=exact("Operação cancelada não pode ser editada.")):
        f.ledger.update_operation(expense, "motivo")


def test_cancel_operation_guards_and_history() -> None:
    f = family()
    expense = f.ledger.record_expense(f.bank, f.groceries, "30.00", date(2026, 1, 5), "Feira")
    with pytest.raises(DomainError, match=exact("Cancelamentos exigem um motivo.")):
        f.ledger.cancel_operation(expense.id, "")
    cancelled = f.ledger.cancel_operation(expense.id, "duplicada")
    assert cancelled.status is OperationStatus.CANCELLED and cancelled.version == 2
    assert queries.balance(f.ledger, f.bank) == 0  # a cancelled operation stops counting
    for missing in (expense.id, uuid4()):
        with pytest.raises(DomainError, match=exact("Operação inexistente ou já cancelada.")):
            f.ledger.cancel_operation(missing, "de novo")


def test_reversal_keeps_the_original_and_mirrors_every_posting() -> None:
    f = family()
    shared = f.ledger.record_expense(
        f.bank, [(f.groceries, "20.00")], "20.00", date(2026, 1, 5), "Feira", member_id=f.ana
    )
    with pytest.raises(DomainError, match=exact("Estornos exigem um motivo.")):
        f.ledger.reverse_operation(shared.id, date(2026, 1, 9), " ")
    with pytest.raises(DomainError, match=exact("Operação inexistente ou cancelada.")):
        f.ledger.reverse_operation(uuid4(), date(2026, 1, 9), "motivo")
    reversal = f.ledger.reverse_operation(shared.id, date(2026, 2, 9), "cobrança indevida")
    assert reversal.kind is OperationKind.REVERSAL and reversal.reversal_of == shared.id
    assert reversal.description == "Estorno: Feira" and reversal.notes == "cobrança indevida"
    assert reversal.accrual_month == YearMonth(year=2026, month=2) and reversal.member_id == f.ana
    assert [p.amount for p in reversal.postings] == [-p.amount for p in shared.postings]
    assert f.ledger.operations[shared.id] == shared  # the original stays intact
    assert queries.balance(f.ledger, f.bank) == 0
    f.ledger.cancel_operation(shared.id, "teste")
    with pytest.raises(DomainError, match=exact("Operação inexistente ou cancelada.")):
        f.ledger.reverse_operation(shared.id, date(2026, 2, 9), "de novo")


# ── ledger: convenience builders ───────────────────


def test_opening_balance_of_a_liability_is_an_amount_owed() -> None:
    f = family()
    loan = f.ledger.add_account(_account(name="Empréstimo", type=AccountType.LIABILITY, subtype=AccountSubtype.LOAN))
    created = f.ledger.record_opening_balance(loan.id, "1500.00", date(2026, 1, 1))
    assert created.kind is OperationKind.OPENING_BALANCE
    assert queries.balance(f.ledger, loan.id) == D("1500.00")
    assert queries.net_worth(f.ledger).net == D("-1500.00")
    # Opening balances are never income.
    assert queries.income_statement(f.ledger, JAN).total_income == 0


def test_opening_balance_requires_a_balance_sheet_account_and_opening_equity() -> None:
    f = family()
    with pytest.raises(DomainError, match=exact("Conta de tipo inadequado para esta operação.")):
        f.ledger.record_opening_balance(f.groceries, "10.00", date(2026, 1, 1))
    bare = Ledger(LedgerMeta(family_name="Sem patrimônio"))
    account = bare.add_account(_account())
    with pytest.raises(DomainError, match=exact("Cofre sem conta de patrimônio de abertura.")):
        bare.record_opening_balance(account.id, "10.00", date(2026, 1, 1))


@pytest.mark.parametrize("amount", ["0", "-5.00"])
def test_income_transfer_and_card_payment_need_positive_values(amount: str) -> None:
    f = family()
    message = exact("Informe um valor positivo.")
    with pytest.raises(DomainError, match=message):
        f.ledger.record_income(f.bank, f.salary, amount, date(2026, 1, 5), "Salário")
    with pytest.raises(DomainError, match=message):
        f.ledger.record_transfer(f.bank, f.savings, amount, date(2026, 1, 5))
    with pytest.raises(DomainError, match=message):
        f.ledger.record_card_payment(f.card, f.bank, amount, date(2026, 1, 5))
    assert len(f.ledger.operations) == 0


def test_income_needs_an_asset_account_and_an_income_category() -> None:
    f = family()
    with pytest.raises(DomainError, match=exact("Conta de tipo inadequado para esta operação.")):
        f.ledger.record_income(f.bank, f.groceries, "10.00", date(2026, 1, 5), "x")
    with pytest.raises(DomainError, match=exact("Conta de tipo inadequado para esta operação.")):
        f.ledger.record_income(f.card_account, f.salary, "10.00", date(2026, 1, 5), "x")


def test_transfer_rejects_same_account_and_categories() -> None:
    f = family()
    with pytest.raises(DomainError, match=exact("Origem e destino iguais.")):
        f.ledger.record_transfer(f.bank, f.bank, "1.00", date(2026, 1, 5))
    with pytest.raises(DomainError, match=exact("Conta de tipo inadequado para esta operação.")):
        f.ledger.record_transfer(f.bank, f.groceries, "1.00", date(2026, 1, 5))


@pytest.mark.parametrize(
    ("splits", "amount", "message"),
    [
        ("single", None, "Informe o valor."),
        ([("groceries", "10.00"), ("groceries", "5.00")], "16.00", "O rateio não soma o valor total."),
        ([("groceries", "10.00"), ("groceries", "-5.00")], None, "Informe valores positivos."),
        ([], None, "Informe valores positivos."),
        ("single_zero", "0", "Informe valores positivos."),
        ([("salary", "10.00")], None, "Conta de tipo inadequado para esta operação."),
    ],
)
def test_expense_split_guards(splits: object, amount: str | None, message: str) -> None:
    f = family()
    ids = {"groceries": f.groceries, "salary": f.salary}
    if splits in ("single", "single_zero"):
        resolved: object = f.groceries
    else:
        assert isinstance(splits, list)
        resolved = [(ids[name], value) for name, value in splits]
    with pytest.raises(DomainError, match=exact(message)):
        f.ledger.record_expense(f.bank, resolved, amount, date(2026, 1, 5), "Compra")  # type: ignore[arg-type]
    with pytest.raises(DomainError, match=exact(message)):
        f.ledger.record_card_purchase(f.card, resolved, amount, date(2026, 1, 5), "Compra")  # type: ignore[arg-type]
    assert len(f.ledger.operations) == 0


def test_expense_split_sums_every_part_into_the_paying_account() -> None:
    f = family()
    health = next(a.id for a in f.ledger.categories(AccountType.EXPENSE) if a.name == "Saúde")
    created = f.ledger.record_expense(
        f.bank, [(f.groceries, "12.34"), (health, "7.66")], "20.00", date(2026, 1, 5), "Farmácia e mercado"
    )
    assert created.postings[-1] == Posting(account_id=f.bank, amount=D("-20.00"))
    assert queries.income_statement(f.ledger, JAN).total_expense == D("20.00")


def test_card_operations_need_an_existing_card() -> None:
    f = family()
    with pytest.raises(DomainError, match=exact("Cartão inexistente.")):
        f.ledger.record_card_purchase(uuid4(), f.groceries, "10.00", date(2026, 1, 5), "x")
    with pytest.raises(DomainError, match=exact("Cartão inexistente.")):
        f.ledger.record_card_payment(uuid4(), f.bank, "10.00", date(2026, 1, 5))
    with pytest.raises(DomainError, match=exact("Conta de tipo inadequado para esta operação.")):
        f.ledger.record_card_payment(f.card, f.card_account, "10.00", date(2026, 1, 5))


def test_card_purchase_defaults_the_cardholder_to_the_card_holder() -> None:
    f = family()
    own = f.ledger.record_card_purchase(f.card, f.groceries, "10.00", date(2026, 1, 5), "Mercado")
    other = f.ledger.record_card_purchase(f.card, f.groceries, "10.00", date(2026, 1, 6), "Mercado", f.bruno)
    assert (own.cardholder_id, other.cardholder_id) == (f.ana, f.bruno)
    assert own.settled_on is None  # a purchase never touches cash
    assert queries.balance(f.ledger, f.card_account) == D("20.00")


# ── ledger: persistence ────────────────────────────


def _raw_lines(ledger: Ledger) -> list[tuple[str, str, str]]:
    return [(str(rid), kind, json.dumps(payload)) for rid, kind, payload in ledger.to_records()]


def test_from_records_and_from_raw_need_exactly_one_meta_row() -> None:
    f = family()
    rows = [r for r in f.ledger.to_records() if r[1] != "ledger.meta"]
    message = exact("Cofre sem dados financeiros reconhecíveis.")
    with pytest.raises(DomainError, match=message):
        Ledger.from_records(rows)
    with pytest.raises(DomainError, match=message):
        Ledger.from_records([*f.ledger.to_records(), *[r for r in f.ledger.to_records() if r[1] == "ledger.meta"]])
    with pytest.raises(DomainError, match=message):
        Ledger.from_raw([line for line in _raw_lines(f.ledger) if line[1] != "ledger.meta"])


def test_unknown_kinds_mean_a_newer_app_version() -> None:
    f = family()
    message = exact("Cofre contém dados de uma versão mais nova do OpesVault.")
    with pytest.raises(DomainError, match=message):
        Ledger.from_records([*f.ledger.to_records(), (uuid4(), "kind_from_the_future", {})])
    with pytest.raises(DomainError, match=message):
        Ledger.from_raw([*_raw_lines(f.ledger), (str(uuid4()), "kind_from_the_future", "{}")])


@pytest.mark.parametrize(
    ("version", "message"),
    [
        (SCHEMA_VERSION + 1, "Cofre criado por uma versão mais nova do OpesVault."),
        (0, "Não há migração disponível para este cofre."),
    ],
)
def test_schema_versions_without_a_migration_path_are_refused(version: int, message: str) -> None:
    f = family()
    rows = [
        (rid, kind, {**payload, "schema_version": version} if kind == "ledger.meta" else payload)
        for rid, kind, payload in f.ledger.to_records()
    ]
    with pytest.raises(DomainError, match=exact(message)):
        Ledger.from_records(rows)


def test_from_raw_routes_old_schemas_through_the_migration() -> None:
    f = family()
    lines = []
    for rid, kind, payload in f.ledger.to_records():
        if kind == "ledger.meta":
            payload = {**payload, "schema_version": 1}
        elif kind == "member":
            payload = {k: v for k, v in payload.items() if k != "role"}
        lines.append((str(rid), kind, json.dumps(payload)))
    opened = Ledger.from_raw(lines)
    assert opened.migrated_from == 1 and opened.meta.schema_version == SCHEMA_VERSION
    assert {m.role for m in opened.members.values()} == {MemberRole.HOLDER}
    assert opened.dirty == {} and opened.change_count == 0


def test_raw_history_is_parsed_only_when_read() -> None:
    f = family()
    f.ledger.record_income(f.bank, f.salary, "100.00", date(2026, 1, 5), "Salário")
    count = len(f.ledger.history)
    opened = Ledger.from_raw(_raw_lines(f.ledger))
    assert len(opened.history) == count  # counted without parsing
    assert list(opened.history.recent()) == []  # type: ignore[attr-defined]
    first = opened.history[0]
    assert isinstance(first, HistoryEntry)
    oldest = min(f.ledger.history, key=lambda h: h.at)
    record = opened.record_for("history", oldest.id)
    assert record is not None and record["entity_id"] == str(oldest.entity_id)


def test_record_for_returns_current_payloads_or_none() -> None:
    f = family()
    assert f.ledger.record_for("ledger.meta", uuid4()) == f.ledger.meta.model_dump(mode="json")
    assert f.ledger.record_for("member", f.ana) == f.ledger.members[f.ana].model_dump(mode="json")
    assert f.ledger.record_for("member", uuid4()) is None
    assert f.ledger.record_for("never_seen_kind", uuid4()) is None
    assert f.ledger.record_for("history", uuid4()) is None
    latest = f.ledger.history[-1]
    assert f.ledger.record_for("history", latest.id) == latest.model_dump(mode="json")


def test_row_counts_only_list_non_empty_kinds() -> None:
    f = family()
    counts = f.ledger.row_counts()
    assert counts["ledger.meta"] == 1 and counts["member"] == 2 and counts["card"] == 1
    assert counts["history"] == len(f.ledger.history)
    assert "operation" not in counts and all(v > 0 for v in counts.values())


# ── queries ────────────────────────────────────────


def test_is_internal_depends_on_balance_sheet_accounts_and_perimeter() -> None:
    f = family()
    transfer = f.ledger.record_transfer(f.bank, f.savings, "50.00", date(2026, 1, 5))
    income = f.ledger.record_income(f.bank, f.salary, "100.00", date(2026, 1, 5), "Salário")
    opening = f.ledger.record_opening_balance(f.joint, "10.00", date(2026, 1, 1))
    assert queries.is_internal(f.ledger, transfer)
    assert queries.is_internal(f.ledger, transfer, {f.bank, f.savings})
    assert not queries.is_internal(f.ledger, transfer, {f.bank})
    assert not queries.is_internal(f.ledger, income)
    assert not queries.is_internal(f.ledger, opening)  # equity is not inside the family perimeter


def test_balances_include_accounts_with_zero_balance_only_once_dated() -> None:
    f = family()
    f.ledger.record_transfer(f.bank, f.savings, "50.00", date(2026, 1, 5))
    f.ledger.record_transfer(f.savings, f.bank, "50.00", date(2026, 1, 6))
    assert queries.balances(f.ledger, date(2026, 1, 4)) == {}
    later = queries.balances(f.ledger, date(2026, 1, 7))
    assert later == {f.bank: D("0"), f.savings: D("0")}


def test_operations_without_dates_count_only_in_the_overall_balance() -> None:
    f = family()
    undated = Operation(
        kind=OperationKind.OTHER,
        description="sem data",
        postings=(Posting(account_id=f.bank, amount=D("5.00")), Posting(account_id=f.savings, amount=D("-5.00"))),
    )
    f.ledger.add_operation(undated)
    assert queries.balance(f.ledger, f.bank) == D("5.00")
    assert queries.balance(f.ledger, f.bank, date(2026, 12, 31)) == 0
    assert queries.cash_flow(f.ledger, JAN, JAN)[JAN].net == 0


def test_member_view_of_the_income_statement_uses_split_shares() -> None:
    f = family()
    shared = Operation(
        kind=OperationKind.EXPENSE,
        description="Mercado",
        postings=(
            Posting(account_id=f.groceries, amount=D("60.00"), member_id=f.ana),
            Posting(account_id=f.groceries, amount=D("40.00"), member_id=f.bruno),
            Posting(account_id=f.joint, amount=D("-100.00")),
        ),
        occurred_on=date(2026, 1, 10),
        settled_on=date(2026, 1, 10),
    )
    f.ledger.add_operation(shared)
    assert queries.income_statement(f.ledger, JAN, f.ana).total_expense == D("60.00")
    assert queries.income_statement(f.ledger, JAN, f.bruno).total_expense == D("40.00")
    assert queries.income_statement(f.ledger, JAN).total_expense == D("100.00")


# ── bulk edits ─────────────────────────────────────


def test_reclassify_guards() -> None:
    f = family()
    with pytest.raises(DomainError, match=exact("A reclassificação exige um motivo.")):
        reclassify(f.ledger, [], f.groceries, " ")
    with pytest.raises(DomainError, match=exact("Escolha uma categoria de destino.")):
        reclassify(f.ledger, [], f.bank, "motivo")


def test_reclassify_skips_missing_cancelled_unchanged_and_split_operations() -> None:
    f = family()
    health = next(a.id for a in f.ledger.categories(AccountType.EXPENSE) if a.name == "Saúde")
    leisure = next(a.id for a in f.ledger.categories(AccountType.EXPENSE) if a.name == "Lazer")
    plain = f.ledger.record_expense(f.bank, f.groceries, "10.00", date(2026, 1, 5), "Mercado")
    cancelled = f.ledger.record_expense(f.bank, f.groceries, "10.00", date(2026, 1, 5), "Mercado")
    f.ledger.cancel_operation(cancelled.id, "duplicada")
    already = f.ledger.record_expense(f.bank, health, "10.00", date(2026, 1, 5), "Remédio")
    split = f.ledger.record_expense(f.bank, [(f.groceries, "5.00"), (leisure, "5.00")], None, date(2026, 1, 5), "Misto")
    transfer = f.ledger.record_transfer(f.bank, f.savings, "1.00", date(2026, 1, 5))
    result = reclassify(
        f.ledger, [plain.id, cancelled.id, already.id, split.id, transfer.id, uuid4()], health, "categoria certa"
    )
    assert (result.changed, result.skipped, result.errors) == (1, 5, ())
    assert {p.account_id for p in f.ledger.operations[plain.id].postings} == {health, f.bank}
    assert f.ledger.operations[split.id] == split  # a split is never collapsed without a source


def test_reclassify_with_a_source_moves_only_that_part_of_a_split() -> None:
    f = family()
    leisure = next(a.id for a in f.ledger.categories(AccountType.EXPENSE) if a.name == "Lazer")
    health = next(a.id for a in f.ledger.categories(AccountType.EXPENSE) if a.name == "Saúde")
    split = f.ledger.record_expense(f.bank, [(f.groceries, "5.00"), (leisure, "5.00")], None, date(2026, 1, 5), "Misto")
    result = reclassify(f.ledger, [split.id], health, "parte era farmácia", source_id=leisure)
    assert result.changed == 1
    assert [p.account_id for p in f.ledger.operations[split.id].postings] == [f.groceries, health, f.bank]


def test_reclassify_reports_operations_blocked_by_a_closed_month() -> None:
    f = family()
    health = next(a.id for a in f.ledger.categories(AccountType.EXPENSE) if a.name == "Saúde")
    expense = f.ledger.record_expense(f.bank, f.groceries, "10.00", date(2026, 1, 5), "Mercado")
    close_month(f.ledger, JAN)
    result = reclassify(f.ledger, [expense.id], health, "motivo")
    assert (result.changed, result.skipped) == (0, 1)
    assert result.errors == ("Mercado: O mês 2026-01 está fechado. Reabra-o com um motivo antes de alterar.",)


# ── periods ────────────────────────────────────────


def test_closing_reopening_and_closing_again_keeps_the_reasons() -> None:
    f = family()
    f.ledger.record_income(f.bank, f.salary, "100.00", date(2026, 1, 5), "Salário")
    first = close_month(f.ledger, JAN)
    assert first.summary.income == D("100.00") and first.summary.net_worth == D("100.00")
    with pytest.raises(DomainError, match=exact("Mês já fechado.")):
        close_month(f.ledger, JAN)
    with pytest.raises(
        DomainError, match=exact("O mês 2026-01 está fechado. Reabra-o com um motivo para lançar nele.")
    ):
        f.ledger.record_income(f.bank, f.salary, "1.00", date(2026, 1, 6), "Extra")
    with pytest.raises(DomainError, match=exact("A reabertura exige motivo.")):
        reopen_month(f.ledger, JAN, " ")
    reopen_month(f.ledger, JAN, " esqueci um lançamento ")
    with pytest.raises(DomainError, match=exact("Mês não está fechado.")):
        reopen_month(f.ledger, JAN, "de novo")
    f.ledger.record_income(f.bank, f.salary, "1.00", date(2026, 1, 6), "Extra")
    assert not closed_figures_unchanged(f.ledger, JAN)
    again = close_month(f.ledger, JAN)
    assert again.id == first.id and again.reopen_reasons == ("esqueci um lançamento",)
    assert again.summary.income == D("101.00") and closed_figures_unchanged(f.ledger, JAN)


def test_undated_operations_are_never_in_a_closed_month() -> None:
    f = family()
    close_month(f.ledger, JAN)
    assert not is_closed(f.ledger, None)
    undated = op((f.bank, "1.00"), (f.savings, "-1.00")).model_copy(update={"occurred_on": None})
    assert months_of(undated) == set()
    assert f.ledger.add_operation(undated).version == 1


def test_cosmetic_edits_are_allowed_in_a_closed_month() -> None:
    f = family()
    income = f.ledger.record_income(f.bank, f.salary, "100.00", date(2026, 1, 5), "Salário")
    close_month(f.ledger, JAN)
    edited = f.ledger.update_operation(income.model_copy(update={"description": "Salário de janeiro"}), "descrição")
    assert edited.description == "Salário de janeiro"
    with pytest.raises(DomainError, match="fechado"):
        f.ledger.cancel_operation(income.id, "engano")


def test_pending_forecasts_need_a_note_to_close() -> None:
    f = family()
    rule = add_rule(
        f.ledger,
        RecurrenceRule(
            description="Aluguel",
            account_id=f.bank,
            counterpart_id=f.groceries,
            amount=D("900"),
            day=10,
            start=date(2026, 1, 1),
        ),
    )
    with pytest.raises(DomainError, match=r"^Há pendências: 1 previsão\(ões\) recorrente\(s\) sem realização\."):
        close_month(f.ledger, JAN)
    closed = close_month(f.ledger, JAN, pending_note="  aluguel pago em dinheiro  ")
    assert closed.pending_note == "aluguel pago em dinheiro" and rule.id


# ── recurrence ─────────────────────────────────────


def _rule(f: Family, **fields: object) -> RecurrenceRule:
    base: dict[str, object] = {
        "description": "Academia",
        "account_id": f.bank,
        "counterpart_id": f.groceries,
        "amount": D("100.00"),
        "day": 10,
        "start": date(2026, 1, 1),
    }
    return RecurrenceRule(**{**base, **fields})  # type: ignore[arg-type]


@pytest.mark.parametrize(
    ("fields", "message"),
    [
        ({"account_id": uuid4()}, "Conta ou categoria inexistente."),
        ({"counterpart_id": uuid4()}, "Conta ou categoria inexistente."),
        ({"amount": D("0")}, "Informe um valor esperado positivo."),
        ({"amount": D("-1")}, "Informe um valor esperado positivo."),
        ({"end": date(2025, 12, 31)}, "Fim antes do início."),
    ],
)
def test_add_rule_guards(fields: dict[str, object], message: str) -> None:
    f = family()
    with pytest.raises(DomainError, match=exact(message)):
        add_rule(f.ledger, _rule(f, **fields))


def test_update_rule_needs_an_existing_rule_and_a_reason() -> None:
    f = family()
    with pytest.raises(DomainError, match=exact("Regra inexistente.")):
        update_rule(f.ledger, _rule(f), "motivo")
    rule = add_rule(f.ledger, _rule(f))
    paused = update_rule(f.ledger, rule.model_copy(update={"paused": True}), "férias")
    assert paused.paused
    assert forecasts(f.ledger, date(2026, 1, 1), date(2026, 3, 31), date(2026, 1, 1)) == []


def test_weekly_occurrences_respect_start_end_and_skips() -> None:
    f = family()
    rule = _rule(
        f, frequency=Frequency.WEEKLY, start=date(2026, 1, 2), end=date(2026, 1, 30), skipped=(date(2026, 1, 16),)
    )
    assert occurrences(rule, date(2026, 1, 5), date(2026, 2, 28)) == [
        date(2026, 1, 9),
        date(2026, 1, 23),
        date(2026, 1, 30),
    ]


def test_monthly_and_yearly_occurrences_clamp_to_the_month_end() -> None:
    f = family()
    monthly = _rule(f, day=31, start=date(2026, 1, 15))
    assert occurrences(monthly, date(2026, 1, 1), date(2026, 4, 30)) == [
        date(2026, 1, 31),
        date(2026, 2, 28),
        date(2026, 3, 31),
        date(2026, 4, 30),
    ]
    yearly = _rule(f, frequency=Frequency.YEARLY, day=29, start=date(2024, 2, 1))
    assert occurrences(yearly, date(2024, 1, 1), date(2026, 12, 31)) == [
        date(2024, 2, 29),
        date(2025, 2, 28),
        date(2026, 2, 28),
    ]


def test_candidates_ignore_linked_and_out_of_window_operations() -> None:
    f = family()
    rule = add_rule(f.ledger, _rule(f, tolerance=D("5")))
    near = f.ledger.record_expense(f.bank, f.groceries, "103.00", date(2026, 1, 12), "Academia")
    far = f.ledger.record_expense(f.bank, f.groceries, "100.00", date(2026, 1, 20), "Academia")
    off = f.ledger.record_expense(f.bank, f.groceries, "110.00", date(2026, 1, 10), "Academia")
    jan, feb = forecasts(f.ledger, date(2026, 1, 1), date(2026, 2, 28), date(2026, 1, 1))
    assert jan.amount == D("-100.00") and jan.status is ForecastStatus.PENDING
    assert [o.id for o in candidates(f.ledger, jan)] == [near.id]
    assert far.id and off.id
    realize(f.ledger, rule.id, jan.due_on, near.id)
    assert f.ledger.operations[near.id].forecast_id == rule.id
    # Once linked, an operation is no longer offered for another forecast.
    moved = feb.__class__(feb.rule_id, date(2026, 1, 12), feb.amount, feb.description, feb.status)
    assert candidates(f.ledger, moved) == []
    with pytest.raises(DomainError, match=exact("Previsão já resolvida.")):
        realize(f.ledger, rule.id, jan.due_on, near.id)
    with pytest.raises(DomainError, match=exact("Operação inexistente.")):
        realize(f.ledger, rule.id, feb.due_on, uuid4())


def test_skipped_and_late_forecast_states() -> None:
    f = family()
    rule = add_rule(f.ledger, _rule(f, counterpart_id=f.salary, window_days=2))
    skip(f.ledger, rule.id, date(2026, 1, 10))
    jan, feb = forecasts(f.ledger, date(2026, 1, 1), date(2026, 2, 28), date(2026, 2, 13))
    assert jan.status is ForecastStatus.SKIPPED and jan.amount == D("100.00")  # income enters the account
    assert feb.status is ForecastStatus.LATE


# ── cards ──────────────────────────────────────────


def test_installment_purchase_guards() -> None:
    f = family()
    with pytest.raises(DomainError, match=exact("Cartão inexistente.")):
        record_installment_purchase(f.ledger, uuid4(), f.groceries, "100", date(2026, 1, 2), "TV", 3)
    with pytest.raises(DomainError, match=exact("Parcelamento exige ao menos 2 parcelas.")):
        record_installment_purchase(f.ledger, f.card, f.groceries, "100", date(2026, 1, 2), "TV", 1)
    with pytest.raises(DomainError, match=exact("Informe um valor positivo.")):
        record_installment_purchase(f.ledger, f.card, f.groceries, "0", date(2026, 1, 2), "TV", 3)
    assert len(f.ledger.operations) == 0 and plans(f.ledger) == {}


def test_bills_ignore_operations_that_do_not_touch_the_card_liability() -> None:
    f = family()
    assert bills(f.ledger, f.card, []) == []
    f.ledger.record_expense(f.bank, f.groceries, "10.00", date(2026, 1, 2), "Mercado", card_id=f.card)
    undated_payment = Operation(
        kind=OperationKind.CARD_PAYMENT,
        description="Pagamento sem data",
        postings=(Posting(account_id=f.card_account, amount=D("5.00")), Posting(account_id=f.bank, amount=D("-5.00"))),
        card_id=f.card,
    )
    f.ledger.add_operation(undated_payment)
    undated_charge = Operation(
        kind=OperationKind.CARD_CHARGE,
        description="Tarifa sem data",
        postings=(
            Posting(account_id=f.groceries, amount=D("2.00")),
            Posting(account_id=f.card_account, amount=D("-2.00")),
        ),
        card_id=f.card,
    )
    f.ledger.add_operation(undated_charge)
    assert bills(f.ledger, f.card, []) == []  # nothing dated reaches any bill
    (bill,) = bills(f.ledger, f.card, [JAN])
    assert (bill.total, bill.payments, bill.operation_ids) == (D("0"), D("0"), [])


def test_imported_installment_lines_match_registered_plans() -> None:
    f = family()
    plan = record_installment_purchase(f.ledger, f.card, f.groceries, "100.00", date(2026, 1, 2), "Geladeira Loja", 3)
    match = find_plan_for_installment(f.ledger, f.card, "GELADEIRA", 2, 3, D("33.33"))
    assert match is not None and match.plan_id == plan.id
    assert match.operation_id == plan.operation_ids[0]  # purchase policy: one operation for every installment
    assert find_plan_for_installment(f.ledger, f.card, "GELADEIRA", 2, 4, D("33.33")) is None
    assert find_plan_for_installment(f.ledger, f.card, "GELADEIRA", 4, 3, D("33.33")) is None
    assert find_plan_for_installment(f.ledger, f.card, "GELADEIRA", 1, 3, D("33.33")) is None  # first is 33.34
    assert find_plan_for_installment(f.ledger, f.card, "FOGAO", 2, 3, D("33.33")) is None
    assert find_plan_for_installment(f.ledger, uuid4(), "GELADEIRA", 2, 3, D("33.33")) is None


# ── alerts ─────────────────────────────────────────


@pytest.mark.parametrize(
    ("due", "expected"),
    [
        (date(2026, 3, 10), "vence hoje"),
        (date(2026, 3, 11), "vence amanhã"),
        (date(2026, 3, 15), "vence em 5 dias (15/03)"),
        (date(2026, 3, 2), "venceu em 02/03"),
    ],
)
def test_due_phrases(due: date, expected: str) -> None:
    assert _when(due, date(2026, 3, 10)) == expected


def test_paid_bills_and_expected_income_alerts() -> None:
    f = family()
    f.ledger.record_card_purchase(f.card, f.groceries, "50.00", date(2026, 1, 2), "Mercado")
    # Card closes on day 3 and is due on day 10: the bill of January is paid early and in full.
    f.ledger.record_card_payment(f.card, f.bank, "50.00", date(2026, 1, 5))
    assert card_alerts(f.ledger, date(2026, 1, 8)) == []
    # A purchase after the closing day goes to February's bill: too far ahead to alert on January 6.
    f.ledger.record_card_purchase(f.card, f.groceries, "20.00", date(2026, 1, 5), "Padaria")
    assert card_alerts(f.ledger, date(2026, 1, 6)) == []
    (soon,) = card_alerts(f.ledger, date(2026, 2, 4))
    assert soon.severity is Severity.SOON and soon.detail == "vence em 6 dias (10/02) · falta pagar R$ 20,00"
    add_rule(f.ledger, _rule(f, counterpart_id=f.salary, description="Salário", day=12))
    (alert,) = recurrence_alerts(f.ledger, date(2026, 1, 8))
    assert alert.severity is Severity.SOON and alert.target is Target.RECURRENCES
    assert alert.title == "Previsto: Salário" and alert.detail == "vence em 4 dias (12/01) · R$ 100,00"


# ── onboarding ─────────────────────────────────────


@pytest.mark.parametrize(
    ("plan", "message"),
    [
        (SetupPlan(members=("Ana", " ")), "Há um integrante sem nome."),
        (SetupPlan(members=("Caio", "caio")), "Há integrantes com o mesmo nome."),
        (SetupPlan(members=("ANA",)), "Há integrantes com o mesmo nome."),
        (SetupPlan(accounts=(AccountPlan(" ", AccountSubtype.CHECKING),)), "Há uma conta sem nome."),
        (SetupPlan(accounts=(AccountPlan("banco a", AccountSubtype.CHECKING),)), "Conta repetida: banco a."),
        (SetupPlan(accounts=(AccountPlan("Cartão", AccountSubtype.CREDIT_CARD),)), "Tipo de conta inválido."),
        (
            SetupPlan(accounts=(AccountPlan("Nova", AccountSubtype.CHECKING, holders=("Zeca",)),)),
            "Titular desconhecido na conta Nova.",
        ),
        (
            SetupPlan(accounts=(AccountPlan("Nova", AccountSubtype.CHECKING, opening_balance=D("1")),)),
            "Informe a data do saldo de abertura de Nova.",
        ),
        (SetupPlan(cards=(CardPlan(" ", "Ana", "1234", 1, 10),)), "Há um cartão sem nome."),
        (SetupPlan(cards=(CardPlan("Banco A", "Ana", "1234", 1, 10),)), "Nome repetido: Banco A."),
        (SetupPlan(cards=(CardPlan("Novo", "Zeca", "1234", 1, 10),)), "Escolha o portador do cartão Novo."),
        (SetupPlan(cards=(CardPlan("Novo", "Ana", "12a4", 1, 10),)), "Informe os 4 últimos dígitos do cartão Novo."),
        (SetupPlan(cards=(CardPlan("Novo", "Ana", "1234", 0, 10),)), "Dias de fechamento e vencimento vão de 1 a 31."),
        (SetupPlan(cards=(CardPlan("Novo", "Ana", "1234", 1, 32),)), "Dias de fechamento e vencimento vão de 1 a 31."),
        (
            SetupPlan(cards=(CardPlan("Novo", "Ana", "1234", 1, 10, settlement_account="Inexistente"),)),
            "Conta de pagamento desconhecida no cartão Novo.",
        ),
    ],
)
def test_check_plan_reports_the_first_problem(plan: SetupPlan, message: str) -> None:
    f = family()
    with pytest.raises(DomainError, match=exact(message)):
        check_plan(f.ledger, plan)


def test_setup_with_an_invalid_settlement_account_fails_before_changing_anything() -> None:
    f = family()
    before = snapshot(f.ledger), len(f.ledger.members)
    # "Moradia" exists (an expense category), so the checks pass; the dry run catches it.
    plan = SetupPlan(members=("Caio",), cards=(CardPlan("Novo", "Caio", "1234", 1, 10, settlement_account="Moradia"),))
    with pytest.raises(DomainError, match=exact("Conta de pagamento da fatura inválida.")):
        apply_setup(f.ledger, plan)
    assert (snapshot(f.ledger), len(f.ledger.members)) == before


def test_setup_counts_only_informed_non_zero_opening_balances() -> None:
    f = family()
    plan = SetupPlan(
        accounts=(
            AccountPlan("Zerada", AccountSubtype.CHECKING, opening_balance=D("0"), opening_date=date(2026, 1, 1)),
            AccountPlan("Sem saldo", AccountSubtype.SAVINGS),
            AccountPlan("Financiamento", AccountSubtype.LOAN, opening_balance=D("800"), opening_date=date(2026, 1, 1)),
        ),
        cards=(CardPlan("Novo", "ana", "4321", 5, 12, settlement_account="banco a", institution="  "),),
    )
    result = apply_setup(f.ledger, plan)
    assert (result.accounts, result.cards, result.opening_balances) == (3, 1, 1)
    loan = next(a for a in f.ledger.accounts.values() if a.name == "Financiamento")
    assert loan.type is AccountType.LIABILITY and queries.balance(f.ledger, loan.id) == D("800")
    card = next(c for c in f.ledger.cards.values() if c.name == "Novo")
    assert card.settlement_account_id == f.bank and card.holder_id == f.ana
    assert f.ledger.accounts[card.liability_account_id].institution is None


# ── plain strings at the entry points (Qt combos return StrEnum values as str) ──


def test_domain_entry_points_accept_plain_string_enums() -> None:
    f = family()
    assert [a.id for a in f.ledger.categories("income")] == [  # type: ignore[arg-type]
        a.id for a in f.ledger.categories(AccountType.INCOME)
    ]
    plan = record_installment_purchase(
        f.ledger,
        f.card,
        f.groceries,
        "90.00",
        date(2026, 1, 2),
        "Sofá",
        3,
        "spread",  # type: ignore[arg-type]
    )
    assert plan.policy is CompetencePolicy.SPREAD and len(plan.operation_ids) == 3
    kid = f.ledger.add_member("Caio", "dependent")  # type: ignore[arg-type]
    assert kid.role is MemberRole.DEPENDENT


def test_card_payment_keeps_a_typed_description_or_names_the_card() -> None:
    f = family()
    f.ledger.record_opening_balance(f.bank, "1000.00", date(2025, 12, 31))
    named = f.ledger.record_card_payment(f.card, f.bank, "10.00", date(2026, 1, 5))
    typed = f.ledger.record_card_payment(f.card, f.bank, "10.00", date(2026, 1, 6), "Fatura de dezembro")
    assert named.description.startswith("Pagamento de fatura — ")
    assert typed.description == "Fatura de dezembro"


def test_setup_holders_typed_with_spaces_match_the_members() -> None:
    f = family()
    plan = SetupPlan(
        accounts=(AccountPlan("Conjunta 2", AccountSubtype.CHECKING, holders=(" Ana ",)),),
        cards=(CardPlan("Outro", "ana  ", "4321", 5, 12),),
    )
    check_plan(f.ledger, plan)
    apply_setup(f.ledger, plan)
    account = next(a for a in f.ledger.accounts.values() if a.name == "Conjunta 2")
    card = next(c for c in f.ledger.cards.values() if c.name == "Outro")
    assert account.holders == (f.ana,) and card.holder_id == f.ana
