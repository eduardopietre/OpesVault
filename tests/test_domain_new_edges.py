"""Edges of the newer domain modules: guards with their messages, branches the main tests skip,
and hand-computed values (investment profile, bank accounts, goals, sharing, merchants,
attachments, loans, projection and the printable exports)."""

import json
from datetime import date
from decimal import Decimal
from pathlib import Path
from uuid import UUID, uuid4

import pytest

from opesvault.domain import attachments, banking, goals, loans, merchants, projection, queries, recurrence, sharing
from opesvault.domain.ledger import DomainError
from opesvault.domain.model import (
    AccountSubtype,
    AccountType,
    LedgerAccount,
    Operation,
    OperationKind,
    Posting,
    YearMonth,
)
from opesvault.investments import profile as prof
from opesvault.investments import service as inv
from opesvault.investments.model import AssetClass, Position
from opesvault.session import Session

from .domain_fixtures import Family, category, family

D = Decimal
PDF = b"%PDF-1.4\n%recibo sintetico\n"


def _position(f: Family, name: str = "CDB X", holder: UUID | None = None) -> Position:
    return inv.create_position(
        f.ledger,
        name,
        AssetClass.FIXED_INCOME,
        date(2025, 2, 1),
        initial_cost="1000",
        from_account=f.bank,
        holder_id=holder,
    )


def _bank(f: Family, **extra: object) -> banking.BankAccount:
    fields: dict[str, object] = {
        "name": "Itaú da Ana",
        "bank_code": "341",
        "bank_name": None,
        "branch": "0123",
        "number": "45678-X",
        "holder_id": f.ana,
    }
    fields.update(extra)
    return banking.build(**fields)  # type: ignore[arg-type]


# ── investment profile ───────────────────────────────────


def test_profile_guards_name_the_field_to_fix() -> None:
    f = family()
    pos = _position(f)
    cases = [
        ({"position_id": uuid4()}, "Investimento inexistente."),
        ({"irpf_group": "04"}, "Escolha o tipo na tabela de Bens e Direitos do IRPF."),  # group without code
        ({"income_code": "exclusivo:99"}, "Escolha o código do rendimento na lista do IRPF."),
        ({"bank_account_id": uuid4()}, "Escolha a conta bancária onde o investimento está."),
        ({"rate": D("-100")}, "Taxa fora do esperado: use o percentual, como 110 ou 6,5."),
        ({"rate": D("10000")}, "Taxa fora do esperado: use o percentual, como 110 ou 6,5."),
        (
            {"applied_on": date(2025, 3, 1), "maturity": date(2025, 2, 28)},
            "O vencimento não pode ser antes da aplicação.",
        ),
        ({"issuer_tax_id": "11222333000182"}, "CNPJ do emissor inválido: confira os dígitos."),
    ]
    for fields, message in cases:
        data: dict[str, object] = {"position_id": pos.id, **fields}
        with pytest.raises(DomainError) as caught:
            prof.save_profile(f.ledger, prof.InvestmentProfile(**data))  # type: ignore[arg-type]
        assert str(caught.value) == message
    assert prof.profile_of(f.ledger, pos.id) is None  # nothing was written by a rejected profile
    edge = prof.save_profile(f.ledger, prof.InvestmentProfile(position_id=pos.id, rate=D("9999.99")))
    assert edge.rate == D("9999.99")
    same_day = prof.InvestmentProfile(position_id=pos.id, applied_on=date(2025, 3, 1), maturity=date(2025, 3, 1))
    assert prof.save_profile(f.ledger, same_day).maturity == date(2025, 3, 1)


def test_saving_a_profile_keeps_one_per_position_and_skips_unchanged() -> None:
    f = family()
    pos = _position(f)
    first = prof.save_profile(f.ledger, prof.InvestmentProfile(position_id=pos.id, issuer="Banco X"))
    again = prof.save_profile(f.ledger, prof.InvestmentProfile(position_id=pos.id, issuer="Banco X"))
    assert again is first  # same content under a fresh id: nothing is written
    changed = prof.save_profile(f.ledger, prof.InvestmentProfile(position_id=pos.id, issuer="Banco Y"))
    assert changed.id == first.id and changed.issuer == "Banco Y"
    assert list(prof.profiles(f.ledger)) == [first.id]


@pytest.mark.parametrize(
    ("group", "code", "expected"),
    [
        ("03", "01", AssetClass.STOCK),
        ("07", "02", AssetClass.REIT),
        ("07", "03", AssetClass.REIT),
        ("07", "08", AssetClass.ETF),
        ("07", "09", AssetClass.ETF),
        ("07", "01", AssetClass.FUND),
        ("08", "01", AssetClass.CRYPTO),
        ("99", "06", AssetClass.PENSION),
        ("99", "01", AssetClass.OTHER),
        ("04", "02", AssetClass.FIXED_INCOME),
        ("04", "03", AssetClass.FIXED_INCOME),
        ("04", "01", AssetClass.OTHER),  # savings is a bank account part, not an investment class
    ],
)
def test_asset_class_for_each_irpf_type(group: str, code: str, expected: AssetClass) -> None:
    assert prof.class_for(group, code) is expected


def test_tax_suggestion_only_for_known_types() -> None:
    assert prof.tax_for("04", "02") is prof.TaxTreatment.WITHHELD
    assert prof.tax_for("04", "03") is prof.TaxTreatment.EXEMPT
    assert prof.tax_for("07", "01") is prof.TaxTreatment.COME_COTAS
    assert prof.tax_for("99", "06") is prof.TaxTreatment.PENSION
    assert prof.tax_for("08", "01") is None  # no guess: the user chooses


@pytest.mark.parametrize(
    ("indexer", "rate", "text"),
    [
        (None, D("10"), "—"),
        (prof.Indexer.CDI, None, "CDI"),
        (prof.Indexer.CDI, D("110"), "110% do CDI"),
        (prof.Indexer.SELIC, D("100.5"), "100,5% do Selic"),
        (prof.Indexer.IPCA, D("6.5"), "IPCA + 6,5% a.a."),
        (prof.Indexer.IGPM, D("4"), "IGP-M + 4% a.a."),
        (prof.Indexer.FIXED, D("12.40"), "12,40% a.a."),
        (prof.Indexer.SAVINGS, D("0.5"), "Rendimento da poupança (0,5%)"),
        (prof.Indexer.VARIABLE, None, "Renda variável (sem indexador)"),
    ],
)
def test_yield_text(indexer: prof.Indexer | None, rate: Decimal | None, text: str) -> None:
    assert prof.yield_text(prof.InvestmentProfile(position_id=uuid4(), indexer=indexer, rate=rate)) == text


def test_yield_text_without_profile_and_income_code_labels() -> None:
    assert prof.yield_text(None) == "—"
    assert prof.income_code_label(None) == "—" and prof.income_code_label("") == "—"
    assert prof.income_code_label("isento:09") == "Isentos 09 — Lucros e dividendos recebidos"
    assert prof.income_code_label("exclusivo:06") == "Tributação exclusiva 06 — Rendimentos de aplicações financeiras"
    assert prof.income_code_label("exclusivo:98") == "Tributação exclusiva 98 — ?"


def test_description_uses_only_what_is_known() -> None:
    f = family()
    pos = _position(f, "Tesouro IPCA")
    assert prof.description(f.ledger, pos.id) is None  # no characteristics: nothing invented
    prof.save_profile(f.ledger, prof.InvestmentProfile(position_id=pos.id, issuer="Tesouro Nacional"))
    assert prof.description(f.ledger, pos.id) == "Tesouro IPCA; emitido por Tesouro Nacional"
    prof.save_profile(
        f.ledger,
        prof.InvestmentProfile(
            position_id=pos.id,
            issuer="Banco X",
            issuer_tax_id="11222333000181",
            indexer=prof.Indexer.IPCA,
            rate=D("6.5"),
            applied_on=date(2025, 2, 1),
            maturity=date(2029, 5, 15),
        ),
    )
    assert prof.description(f.ledger, pos.id) == (
        "Tesouro IPCA; emitido por Banco X, CNPJ 11.222.333/0001-81; IPCA + 6,5% a.a.; "
        "aplicado em 01/02/2025; vencimento em 15/05/2029"
    )


# ── bank accounts ────────────────────────────────────────


def test_where_shows_only_what_is_filled() -> None:
    f = family()
    item = banking.build(
        name="Caixa da casa",
        bank_code=None,
        bank_name="  Cooperativa   Local ",
        branch=" ",
        number=None,
        holder_id=f.ana,
    )
    assert item.branch is None and item.number is None  # blank tokens are absent, not empty
    assert item.where == "Cooperativa Local" and item.name == "Caixa da casa"
    assert banking.build(name="", bank_code=None, bank_name="Coop", branch=None, number="9", holder_id=f.ana).where == (
        "Coop, conta 9"
    )
    assert not item.joint and item.holders == (f.ana,) and item.components() == []
    assert banking._masked(item) is None


def test_bank_account_guards() -> None:
    f = family()
    with pytest.raises(DomainError, match=r"^Escolha o banco ou informe o nome da instituição\.$"):
        banking.build(name="x", bank_code=None, bank_name="   ", branch=None, number=None, holder_id=f.ana)
    with pytest.raises(DomainError, match=r"^Agência: use letras, números e símbolos, sem espaços \(até 30\)\.$"):
        _bank(f, branch="01 23")
    with pytest.raises(DomainError, match=r"^Conta: use letras"):
        _bank(f, number="x" * 31)
    cases = [
        (_bank(f, holder_id=uuid4()), {}, "Escolha o titular da conta."),
        (_bank(f, co_holder_id=uuid4()), {}, "Escolha o segundo titular."),
        (_bank(f, co_holder_id=f.ana), {}, "O segundo titular precisa ser outra pessoa."),
        (_bank(f).model_copy(update={"bank_code": "000"}), {}, "Banco fora da lista de códigos COMPE."),
        (_bank(f), {"checking": f.savings}, "A conta corrente escolhida não é do tipo certo."),
        (_bank(f), {"savings": f.bank}, "A poupança escolhida não é do tipo certo."),
        (_bank(f), {"checking": uuid4()}, "A conta corrente escolhida não é do tipo certo."),
    ]
    for item, parts, message in cases:
        with pytest.raises(DomainError) as caught:
            banking.create(f.ledger, item, **parts)  # type: ignore[arg-type]
        assert str(caught.value) == message
    assert banking.bank_accounts(f.ledger) == {}
    saved = banking.create(f.ledger, _bank(f), checking=True)
    with pytest.raises(DomainError, match=r"^Conta bancária já cadastrada\.$"):
        banking.create(f.ledger, saved)
    with pytest.raises(DomainError, match=r"^Conta bancária inexistente\.$"):
        banking.update(f.ledger, _bank(f))


def test_existing_accounts_join_and_opening_skips_zero_and_missing_parts() -> None:
    f = family()
    item = banking.build(
        name="Coop", bank_code=None, bank_name="Cooperativa Local", branch="1", number="2", holder_id=f.ana
    )
    saved = banking.create(
        f.ledger,
        item,
        checking=f.bank,
        opening={
            banking.Part.CHECKING: (D("0"), date(2025, 1, 2)),  # zero: no operation
            banking.Part.SAVINGS: (D("50.00"), date(2025, 1, 2)),  # part absent: ignored
        },
    )
    assert saved.checking_id == f.bank and saved.savings_id is None
    assert list(f.ledger.active_operations()) == []
    assert banking.of_account(f.ledger, f.bank) == saved
    account = f.ledger.account(f.bank)
    assert account.institution == "Cooperativa Local" and account.masked_number == "ag 1 c 2"
    from opesvault.tax import records
    from opesvault.tax.model import TaxSubject

    assert records.identity(f.ledger, TaxSubject.ACCOUNT, f.bank) is None  # no COMPE code: no CNPJ guessed


def test_update_adds_only_missing_parts_and_unchanged_is_not_written() -> None:
    f = family()
    saved = banking.create(f.ledger, _bank(f), checking=True)
    accounts_before = len(f.ledger.accounts)
    same = banking.update(f.ledger, saved, add=(banking.Part.CHECKING,))  # already there: nothing new
    assert same == saved and len(f.ledger.accounts) == accounts_before
    grown = banking.update(f.ledger, saved, add=(banking.Part.SAVINGS,))
    assert grown.checking_id == saved.checking_id and grown.savings_id is not None
    savings = f.ledger.account(grown.savings_id)
    assert savings.subtype is AccountSubtype.SAVINGS and savings.name == "Itaú da Ana — poupança"


def test_archive_once_and_ignore_unknown() -> None:
    f = family()
    saved = banking.create(f.ledger, _bank(f), checking=True)
    banking.archive(f.ledger, uuid4())  # unknown: nothing happens
    banking.archive(f.ledger, saved.id)
    archived = banking.bank_accounts(f.ledger)[saved.id]
    assert archived.archived
    banking.archive(f.ledger, saved.id)
    assert banking.bank_accounts(f.ledger)[saved.id] is archived  # second time: not written again


def test_investments_held_at_the_bank_follow_its_first_holder() -> None:
    f = family()
    saved = banking.create(f.ledger, _bank(f), checking=True)
    pos = _position(f, holder=f.bruno)
    hers = _position(f, "CDB da Ana", holder=f.ana)  # already hers: untouched
    relabeled = _position(f, "CDB conta da Ana", holder=f.bruno)
    account = f.ledger.account(relabeled.account_id)
    f.ledger.update_account(account.model_copy(update={"holders": (f.ana,)}), "teste")  # account already hers
    for held in (pos, hers, relabeled):
        prof.save_profile(f.ledger, prof.InvestmentProfile(position_id=held.id, bank_account_id=saved.id))
    banking.update(f.ledger, saved)
    assert inv.positions(f.ledger)[hers.id] == hers
    assert inv.positions(f.ledger)[relabeled.id].holder_id == f.ana
    moved = inv.positions(f.ledger)[pos.id]
    assert moved.holder_id == f.ana
    assert f.ledger.account(moved.account_id).holders == (f.ana,)
    assert prof.description(f.ledger, pos.id) == (
        "CDB X; custodiado em ITAÚ UNIBANCO S.A. (341), ag. 0123, conta 45678-X"
    )


def test_record_values_guards() -> None:
    f = family()
    f.ledger.record_opening_balance(f.bank, "100000.00", date(2024, 12, 1))
    saved = banking.create(f.ledger, _bank(f), checking=True)
    pos = _position(f)
    prof.save_profile(f.ledger, prof.InvestmentProfile(position_id=pos.id, bank_account_id=saved.id))
    on = date(2025, 6, 30)
    cases = [
        (uuid4(), {saved.checking_id: "1.00"}, "Conta bancária inexistente."),
        (saved.id, {saved.checking_id: "1.001"}, "Use valores em reais e centavos."),
        (saved.id, {pos.id: "-0.01"}, "O valor de um investimento não pode ser negativo."),
        (saved.id, {f.bank: "1.00"}, "Esse item não pertence a esta conta bancária."),
    ]
    for bank_id, values, message in cases:
        with pytest.raises(DomainError) as caught:
            banking.record_values(f.ledger, bank_id, on, values)  # type: ignore[arg-type]
        assert str(caught.value) == message
    first = banking.record_values(f.ledger, saved.id, on, {pos.id: D("1050.00")})
    count = len(inv.valuations_of(f.ledger, pos.id))
    again = banking.record_values(f.ledger, saved.id, on, {pos.id: "1050.00"})  # same value: no correction
    assert first.valuations == again.valuations == 1 and len(inv.valuations_of(f.ledger, pos.id)) == count
    assert banking.total(banking.values_at(f.ledger, saved.id, on)) == D("1050.00")  # checking 0 + 1050


def test_total_of_unknown_values_is_unknown() -> None:
    ref = uuid4()
    assert banking.total([]) is None
    assert banking.total([banking.Value("CDB", "investment", ref, None)]) is None
    values = [banking.Value("CDB", "investment", ref, None), banking.Value("Conta", "checking", ref, D("-10.50"))]
    assert banking.total(values) == D("-10.50")


def test_adjust_balance_rules_and_descriptions() -> None:
    f = family()
    with pytest.raises(DomainError, match=r"^Só contas de dinheiro recebem ajuste de saldo\.$"):
        banking.adjust_balance(f.ledger, f.card_account, date(2025, 1, 31), D("10.00"))
    assert banking.adjust_balance(f.ledger, f.bank, date(2025, 1, 31), D("0")) is None  # already equal
    first = banking.adjust_balance(f.ledger, f.bank, date(2025, 1, 31), D("250.00"))
    assert first is not None and first.description == "Saldo de abertura — Banco A"
    second = banking.adjust_balance(f.ledger, f.bank, date(2025, 2, 28), D("200.00"))
    assert second is not None and second.description == "Ajuste ao saldo informado em 28/02/2025 — Banco A"
    assert [p.amount for p in second.postings] == [D("-50.00"), D("50.00")]
    assert queries.balance(f.ledger, f.bank, date(2025, 2, 28)) == D("200.00")
    f.ledger.meta = f.ledger.meta.model_copy(update={"opening_equity_id": None})
    with pytest.raises(DomainError, match=r"^Cofre sem conta de patrimônio de abertura\.$"):
        banking.adjust_balance(f.ledger, f.bank, date(2025, 3, 31), D("1.00"))


# ── goals ────────────────────────────────────────────────


def _goal(f: Family, **extra: object) -> goals.Goal:
    fields: dict[str, object] = {
        "name": "Reserva",
        "kind": goals.GoalKind.ACCOUNTS,
        "target": D("3000.00"),
        "account_ids": (f.savings,),
        "created_on": date(2026, 1, 1),
    }
    fields.update(extra)
    return goals.Goal(**fields)  # type: ignore[arg-type]


def test_goal_guards() -> None:
    f = family()
    cases = [
        ({"name": "   "}, "Dê um nome à meta."),
        ({"target": D("0")}, "Informe o valor da meta em reais e centavos."),
        ({"target": D("10.001")}, "Informe o valor da meta em reais e centavos."),
        ({"account_ids": ()}, "Escolha as contas que formam a meta."),
        ({"account_ids": (f.groceries,)}, "Metas somam contas de ativo (conta, poupança, investimento)."),
        ({"account_ids": (uuid4(),)}, "Metas somam contas de ativo (conta, poupança, investimento)."),
        ({"target_date": date(2026, 1, 1)}, "A data da meta precisa ser futura."),
    ]
    for fields, message in cases:
        with pytest.raises(DomainError) as caught:
            goals.add_goal(f.ledger, _goal(f, **fields))
        assert str(caught.value) == message
    with pytest.raises(DomainError, match=r"^Meta inexistente\.$"):
        goals.update_goal(f.ledger, _goal(f), "nova")
    saved = goals.add_goal(f.ledger, _goal(f))
    renamed = goals.update_goal(f.ledger, saved.model_copy(update={"name": "Reserva de emergência"}), "renomeada")
    assert renamed.version == 2 and goals.goals(f.ledger) == [renamed]


def test_goal_progress_by_hand() -> None:
    f = family()
    f.ledger.record_opening_balance(f.savings, "1000.00", date(2026, 1, 5))
    f.ledger.record_income(f.bank, f.salary, "5000.00", date(2026, 1, 5), "Salário")  # first activity: January
    f.ledger.record_transfer(f.bank, f.savings, "500.00", date(2026, 2, 5))
    f.ledger.record_transfer(f.bank, f.savings, "500.00", date(2026, 3, 5))
    goal = goals.add_goal(f.ledger, _goal(f, target_date=date(2026, 7, 15)))
    found = goals.progress(f.ledger, goal, date(2026, 3, 20))
    assert found.current == D("2000.00") and found.missing == D("1000.00")
    assert found.share == D("0.6667")  # 2000 / 3000
    assert found.months_left == 4 and found.needed_per_month == D("250.00")  # 1000 / 4
    assert found.pace == D("500.00")  # (2000 − 1000 at 31/01) / 2 months
    assert found.reached_on_pace == YearMonth(year=2026, month=5)  # ceil(1000 / 500) = 2 months
    assert not found.reached


def test_goal_due_this_month_or_reached() -> None:
    f = family()
    f.ledger.record_opening_balance(f.savings, "1000.00", date(2026, 1, 5))
    f.ledger.record_income(f.bank, f.salary, "100.00", date(2026, 3, 2), "Bico")  # activity only this month
    goal = goals.add_goal(f.ledger, _goal(f, target_date=date(2026, 3, 31), created_on=date(2026, 3, 1)))
    due = goals.progress(f.ledger, goal, date(2026, 3, 20))
    assert due.months_left == 0 and due.needed_per_month == D("2000.00")  # all of it, this month
    assert due.pace is None and due.reached_on_pace is None  # one month of records: no pace
    small = goals.add_goal(f.ledger, _goal(f, name="Pouco", target=D("800.00"), target_date=date(2026, 9, 1)))
    done = goals.progress(f.ledger, small, date(2026, 3, 20))
    assert done.reached and done.missing == 0 and done.share == D("1.0000") and done.needed_per_month is None


def test_goal_without_any_activity_has_no_pace() -> None:
    f = family()
    goal = goals.add_goal(f.ledger, _goal(f, kind=goals.GoalKind.NET_WORTH, account_ids=()))
    found = goals.progress(f.ledger, goal, date(2026, 3, 20))
    assert found.current == 0 and found.share == 0 and found.pace is None and found.months_left is None


# ── reimbursements and settling up ───────────────────────


def test_reimbursement_request_guards() -> None:
    f = family()
    expense = f.ledger.record_expense(f.bank, f.groceries, "100.00", date(2026, 3, 2), "Consulta")
    income = f.ledger.record_income(f.bank, f.salary, "100.00", date(2026, 3, 2), "Salário")
    cancelled = f.ledger.record_expense(f.bank, f.groceries, "10.00", date(2026, 3, 2), "Erro")
    f.ledger.cancel_operation(cancelled.id, "lançado por engano")
    cases = [
        (uuid4(), "Plano", "10.00", "Escolha um lançamento ativo."),
        (cancelled.id, "Plano", "10.00", "Escolha um lançamento ativo."),
        (income.id, "Plano", "10.00", "Só despesas podem ter reembolso."),
        (expense.id, "Plano", "0", "Informe o valor esperado em reais e centavos."),
        (expense.id, "Plano", "10.005", "Informe o valor esperado em reais e centavos."),
        (expense.id, "Plano", "100.01", "O reembolso esperado passa do valor da despesa."),
        (expense.id, "   ", "10.00", "Informe quem reembolsa."),
    ]
    for op_id, payer, value, message in cases:
        with pytest.raises(DomainError) as caught:
            sharing.request(f.ledger, op_id, payer, value)
        assert str(caught.value) == message
    assert sharing.request(f.ledger, expense.id, " Plano ", "100.00").payer == "Plano"


def test_receiving_guards_and_a_cancelled_receipt_reopens_the_item() -> None:
    f = family()
    expense = f.ledger.record_expense(f.bank, f.groceries, "100.00", date(2026, 3, 2), "Consulta")
    item = sharing.request(f.ledger, expense.id, "Plano", "60.00")
    with pytest.raises(DomainError, match=r"^Reembolso inexistente\.$"):
        sharing.receive(f.ledger, uuid4(), f.bank, "10.00", date(2026, 3, 10))
    with pytest.raises(DomainError, match=r"^Escolha a conta que recebeu o reembolso\.$"):
        sharing.receive(f.ledger, item.id, f.card_account, "10.00", date(2026, 3, 10))
    with pytest.raises(DomainError, match=r"^Informe um valor positivo em reais e centavos\.$"):
        sharing.receive(f.ledger, item.id, f.bank, "-1", date(2026, 3, 10))
    receipt = sharing.receive(f.ledger, item.id, f.bank, "60.00", date(2026, 3, 10))
    item = sharing.reimbursements(f.ledger)[item.id]
    assert sharing.state(f.ledger, item) is sharing.ReimbursementState.RECEIVED
    f.ledger.cancel_operation(receipt.id, "estorno do banco")
    assert sharing.received(f.ledger, item) == 0
    assert sharing.state(f.ledger, item) is sharing.ReimbursementState.PENDING
    assert sharing.open_items(f.ledger) == [item]
    orphan = f.ledger.put(
        "reimbursement", sharing.Reimbursement(operation_id=uuid4(), payer="Empresa", expected=D("5.00"))
    )
    with pytest.raises(DomainError, match=r"^O lançamento reembolsado não existe mais\.$"):
        sharing.receive(f.ledger, orphan.id, f.bank, "5.00", date(2026, 3, 10))


def test_deny_guards_and_denied_items_accept_no_money() -> None:
    f = family()
    expense = f.ledger.record_expense(f.bank, f.groceries, "100.00", date(2026, 3, 2), "Consulta")
    item = sharing.request(f.ledger, expense.id, "Plano", "60.00")
    with pytest.raises(DomainError, match=r"^Reembolso inexistente\.$"):
        sharing.deny(f.ledger, uuid4(), "fora da cobertura")
    with pytest.raises(DomainError, match=r"^Informe o motivo\.$"):
        sharing.deny(f.ledger, item.id, "  ")
    denied = sharing.deny(f.ledger, item.id, "fora da cobertura")
    assert denied.version == 2 and sharing.state(f.ledger, denied) is sharing.ReimbursementState.DENIED
    with pytest.raises(DomainError, match=r"^Reembolso negado não recebe valores\.$"):
        sharing.receive(f.ledger, item.id, f.bank, "10.00", date(2026, 3, 10))
    assert sharing.open_items(f.ledger) == []
    assert sharing.request(f.ledger, expense.id, "Empresa", "50.00").payer == "Empresa"  # denied: may ask again


def test_shares_filter_by_date_and_skip_undated_and_cancelled_out_members() -> None:
    f = family()
    ledger = f.ledger
    early = ledger.record_expense(f.bank, f.groceries, "40.00", date(2026, 1, 10), "Feira", member_id=f.bruno)
    ledger.record_expense(f.bank, f.groceries, "70.00", date(2026, 3, 10), "Mercado", member_id=f.bruno)
    health = category(ledger, "Saúde")
    ledger.add_operation(  # undated: never inside a period
        Operation(
            kind=OperationKind.EXPENSE,
            description="Sem data",
            postings=(
                Posting(account_id=health, amount=D("15.00"), member_id=f.bruno),
                Posting(account_id=f.bank, amount=D("-15.00")),
            ),
        )
    )
    ledger.add_operation(  # Bruno's part moves between categories: nets to zero, no share
        Operation(
            kind=OperationKind.EXPENSE,
            description="Reclassificação",
            postings=(
                Posting(account_id=f.groceries, amount=D("25.00"), member_id=f.bruno),
                Posting(account_id=health, amount=D("-25.00"), member_id=f.bruno),
                Posting(account_id=health, amount=D("5.00"), member_id=f.ana),
                Posting(account_id=f.bank, amount=D("-5.00")),
            ),
            occurred_on=date(2026, 2, 1),
            settled_on=date(2026, 2, 1),
        )
    )
    every = sharing.shares(ledger)
    assert [(s.description, s.amount) for s in every] == [
        ("Sem data", D("15.00")),
        ("Feira", D("40.00")),
        ("Mercado", D("70.00")),
    ]
    assert all(s.payer_id == f.ana and s.beneficiary_id == f.bruno for s in every)
    window = sharing.shares(ledger, date(2026, 2, 1), date(2026, 2, 28))
    assert window == []
    assert [s.operation_id for s in sharing.shares(ledger, end=date(2026, 1, 31))] == [early.id]
    assert [s.description for s in sharing.shares(ledger, start=date(2026, 3, 1))] == ["Mercado"]


def test_balances_net_out_settlements_in_the_period() -> None:
    f = family()
    f.ledger.record_expense(f.bank, f.groceries, "120.00", date(2026, 3, 10), "Mercado", member_id=f.bruno)
    sharing.settle(f.ledger, f.bruno, f.ana, "120.00", date(2026, 3, 20))
    assert sharing.balances(f.ledger) == []  # paid back in full: the pair disappears
    sharing.settle(f.ledger, f.bruno, f.ana, "20.00", date(2026, 5, 2))
    march = sharing.balances(f.ledger, date(2026, 3, 1), date(2026, 3, 31))
    assert march == []  # May's settlement is outside March
    [over] = sharing.balances(f.ledger)
    assert (over.debtor_id, over.creditor_id, over.amount) == (f.ana, f.bruno, D("20.00"))  # Bruno paid 20 too much
    assert over.settled == 0 and over.shares == []


def test_settle_guards() -> None:
    f = family()
    cases = [
        (f.ana, f.ana, "10.00", "Escolha dois integrantes diferentes."),
        (f.ana, uuid4(), "10.00", "Integrante inexistente."),
        (f.ana, f.bruno, "0", "Informe um valor positivo em reais e centavos."),
        (f.ana, f.bruno, "1.234", "Informe um valor positivo em reais e centavos."),
    ]
    for debtor, creditor, value, message in cases:
        with pytest.raises(DomainError) as caught:
            sharing.settle(f.ledger, debtor, creditor, value, date(2026, 3, 1))
        assert str(caught.value) == message
    saved = sharing.settle(f.ledger, f.ana, f.bruno, "10.00", date(2026, 3, 1), note="")
    assert saved.note is None and saved.amount == D("10.00")


# ── merchants ────────────────────────────────────────────


def test_naming_a_merchant_guards_rename_and_remove() -> None:
    f = family()
    with pytest.raises(DomainError, match=r"^Informe o nome do estabelecimento\.$"):
        merchants.name_merchant(f.ledger, "IFD*IFOOD.COM AGENCIA", "   ")
    with pytest.raises(DomainError, match=r"^Use até 60 caracteres\.$"):
        merchants.name_merchant(f.ledger, "IFD*IFOOD.COM AGENCIA", "x" * 61)
    first = merchants.name_merchant(f.ledger, "IFD*IFOOD.COM AGENCIA", "  i  Food ")
    assert first.name == "i Food"
    assert merchants.name_merchant(f.ledger, "IFD*IFOOD AGENCIA", "i Food") is first  # same key, same name
    renamed = merchants.name_merchant(f.ledger, "IFD*IFOOD.COM AGENCIA", "iFood")
    assert renamed.id == first.id and merchants.merchant_of(f.ledger, "IFD*IFOOD.COM AGENCIA") == "iFood"
    merchants.remove_alias(f.ledger, uuid4())  # unknown: nothing happens
    merchants.remove_alias(f.ledger, first.id)
    assert merchants.aliases(f.ledger) == {} and merchants.merchant_of(f.ledger, "IFD*IFOOD.COM AGENCIA") == "Ifood"


def test_merchant_totals_count_only_expenses_in_the_period() -> None:
    f = family()
    f.ledger.record_expense(f.bank, f.groceries, "30.00", date(2026, 3, 2), "IFD*IFOOD.COM AGENCIA")
    f.ledger.record_expense(f.bank, f.groceries, "12.50", date(2026, 3, 9), "IFD*IFOOD AGENCIA")
    f.ledger.record_expense(f.bank, f.groceries, "99.00", date(2026, 4, 1), "IFD*IFOOD.COM AGENCIA")  # April
    f.ledger.record_income(f.bank, f.salary, "5000.00", date(2026, 3, 5), "PAG*EMPRESA")  # not an expense
    f.ledger.record_transfer(f.bank, f.savings, "100.00", date(2026, 3, 6), "Guardar")  # not an expense
    merchants.name_merchant(f.ledger, "IFD*IFOOD AGENCIA", "iFood")
    [total] = merchants.totals(f.ledger, date(2026, 3, 1), date(2026, 3, 31))
    assert total == merchants.MerchantTotal("iFood", D("42.50"), 2, True)


def test_merchant_cleaning_falls_back_to_the_description() -> None:
    assert merchants.clean("  123 456  ") == "123 456"  # only numbers: keep what the bank wrote
    assert merchants.clean("   ") == "?"


# ── attachments ──────────────────────────────────────────


def test_attachment_guards_and_nothing_plain_on_disk(tmp_path: Path) -> None:
    f = family()
    session = Session.new(tmp_path / "x.opesvault")
    session.ledger = f.ledger
    op = f.ledger.record_expense(f.bank, f.groceries, "80.00", date(2026, 1, 5), "Dentista")
    with pytest.raises(DomainError, match=r"^Operação inexistente\.$"):
        attachments.attach(session, uuid4(), "recibo.pdf", PDF)
    with pytest.raises(DomainError, match=r"^O arquivo passa de 25 MB\.$"):
        attachments.attach(session, op.id, "grande.pdf", PDF + b"\0" * attachments.MAX_BYTES)
    assert session.documents == []
    assert attachments.kind_of(b"\xff\xd8\xff\xe0") == "jpeg" and attachments.kind_of(b"") is None
    link = attachments.attach(session, op.id, "recibo.pdf", PDF)
    attachments.detach(session, uuid4())  # unknown link: nothing happens
    assert attachments.of_operation(f.ledger, op.id) == [link]
    on_disk = [p.read_bytes() for p in tmp_path.rglob("*") if p.is_file()]
    assert not any(b"recibo sintetico" in data for data in on_disk)  # the receipt lives only in memory


# ── loans ────────────────────────────────────────────────


def _loan(f: Family, **extra: object) -> loans.LoanPlan:
    debt = f.ledger.add_account(LedgerAccount(name="Carro", type=AccountType.LIABILITY, subtype=AccountSubtype.LOAN))
    fields: dict[str, object] = {
        "name": "Carro",
        "liability_account_id": debt.id,
        "payment_account_id": f.bank,
        "interest_category_id": category(f.ledger, "Juros e encargos"),
        "principal": D("1000.00"),
        "monthly_rate": D("0.01"),
        "term": 12,
        "system": loans.AmortizationSystem.PRICE,
        "first_due": date(2026, 2, 10),
    }
    fields.update(extra)
    return loans.LoanPlan(**fields)  # type: ignore[arg-type]


def test_loan_guards() -> None:
    f = family()
    investment = f.ledger.add_account(
        LedgerAccount(name="Corretora", type=AccountType.ASSET, subtype=AccountSubtype.INVESTMENT)
    ).id
    cases = [
        ({"liability_account_id": f.card_account}, "Escolha uma conta de empréstimo ou financiamento."),
        ({"payment_account_id": f.card_account}, "Escolha a conta de onde saem as parcelas."),
        ({"interest_category_id": f.salary}, "Juros e encargos são categorias de despesa."),
        ({"fees_category_id": investment}, "Juros e encargos são categorias de despesa."),
        ({"principal": D("0")}, "Informe o saldo devedor em reais e centavos."),
        ({"principal": D("10.005")}, "Informe o saldo devedor em reais e centavos."),
        ({"fees_per_installment": D("-1.00")}, "Encargos por parcela inválidos."),
        ({"fees_per_installment": D("1.001")}, "Encargos por parcela inválidos."),
        ({"fees_per_installment": D("5.00")}, "Escolha a categoria dos encargos."),
        (  # 0,01 at 100% a.m.: the rounded installment (0,01) never covers the interest (0,01)
            {"principal": D("0.01"), "monthly_rate": D("1")},
            "A parcela não cobre os juros: revise taxa, prazo e saldo.",
        ),
    ]
    for fields, message in cases:
        with pytest.raises(DomainError) as caught:
            loans.create_loan(f.ledger, _loan(f, **fields))
        assert str(caught.value) == message
    with pytest.raises(DomainError, match=r"^Escolha a conta que recebeu o dinheiro\.$"):
        loans.create_loan(f.ledger, _loan(f), loans.Opening.DEPOSIT)
    assert loans.plans(f.ledger) == {}


def test_update_loan_and_payment_guards() -> None:
    f = family()
    with pytest.raises(DomainError, match=r"^Financiamento inexistente\.$"):
        loans.update_loan(f.ledger, _loan(f), "taxa")
    plan = loans.create_loan(f.ledger, _loan(f), loans.Opening.OPENING_BALANCE)
    assert queries.balance(f.ledger, plan.liability_account_id) == D("1000.00")  # owed
    updated = loans.update_loan(f.ledger, plan.model_copy(update={"name": "Carro novo"}), "nome")
    assert updated.version == 2
    with pytest.raises(DomainError, match=r"^Financiamento inexistente\.$"):
        loans.pay_installment(f.ledger, uuid4(), 1, date(2026, 2, 10))
    with pytest.raises(DomainError, match=r"^Parcela inexistente\.$"):
        loans.pay_installment(f.ledger, plan.id, 13, date(2026, 2, 10))
    with pytest.raises(DomainError, match=r"^O valor pago é menor que a parcela\."):
        loans.pay_installment(f.ledger, plan.id, 1, date(2026, 2, 10), "88.84")
    with pytest.raises(DomainError, match=r"^Financiamento inexistente\.$"):
        loans.prepay(f.ledger, uuid4(), "10.00", date(2026, 2, 1), loans.PrepaymentMode.REDUCE_TERM)
    for value in ("0", "10.001"):
        with pytest.raises(DomainError, match=r"^Informe um valor positivo em reais e centavos\.$"):
            loans.prepay(f.ledger, plan.id, value, date(2026, 2, 1), loans.PrepaymentMode.REDUCE_TERM)
    with pytest.raises(DomainError, match=r"^O valor passa do saldo devedor\.$"):
        loans.prepay(f.ledger, plan.id, "1000.01", date(2026, 2, 1), loans.PrepaymentMode.REDUCE_TERM)
    with pytest.raises(DomainError, match=r"^Informe um valor positivo\.$"):
        loans.simulate_prepayment(f.ledger, plan.id, "0", loans.PrepaymentMode.REDUCE_TERM)


def test_interest_free_installment_has_no_interest_posting() -> None:
    f = family()
    plan = loans.create_loan(f.ledger, _loan(f, monthly_rate=D("0"), principal=D("1200.00")))
    op = loans.pay_installment(f.ledger, plan.id, 1, date(2026, 2, 10))
    assert [(p.account_id, p.amount) for p in op.postings] == [
        (plan.liability_account_id, D("100.00")),
        (f.bank, D("-100.00")),
    ]


def test_prepayment_before_the_first_installment_reduces_the_term() -> None:
    """Bug: an upfront prepayment ignored its mode and always lowered the installment."""
    f = family()
    plan = _loan(f)
    items = loans.schedule(plan, [(0, D("400.00"), loans.PrepaymentMode.REDUCE_TERM)])
    # 600 left, the contract's 88,85 kept: 6,00 / 5,17 / 4,33 / 3,49 / 2,64 / 1,77 / 0,90 / 0,02 of interest.
    assert [i.payment for i in items[:-1]] == [D("88.85")] * 7
    assert len(items) == 8 and items[-1].payment == D("2.37") and items[-1].amortization == D("2.35")
    assert sum((i.interest for i in items), D(0)) == D("24.32")
    assert sum((i.amortization for i in items), D(0)) == D("600.00") and items[-1].balance_after == 0


def test_prepayment_before_the_first_installment_can_lower_the_installment() -> None:
    f = family()
    items = loans.schedule(_loan(f), [(0, D("400.00"), loans.PrepaymentMode.REDUCE_PAYMENT)])
    assert len(items) == 12 and items[0].payment == D("53.31")  # 88,8488 × 0,6 = 53,309 → 53,31
    assert items[0].interest == D("6.00") and items[-1].balance_after == 0
    sac = loans.schedule(
        _loan(f, system=loans.AmortizationSystem.SAC), [(0, D("400.00"), loans.PrepaymentMode.REDUCE_TERM)]
    )
    assert [i.amortization for i in sac[:7]] == [D("83.33")] * 7 and sac[-1].amortization == D("16.69")
    assert len(sac) == 8  # 600 = 7 × 83,33 + 16,69


def test_recorded_upfront_prepayment_and_simulation_agree() -> None:
    f = family()
    plan = loans.create_loan(f.ledger, _loan(f), loans.Opening.OPENING_BALANCE)
    simulated = loans.simulate_prepayment(f.ledger, plan.id, "400.00", loans.PrepaymentMode.REDUCE_TERM)
    assert (simulated.installments_before, simulated.installments_after) == (12, 8)
    assert simulated.next_payment_after == D("88.85")
    assert simulated.interest_before == D("66.19") and simulated.interest_saved == D("41.87")
    loans.prepay(f.ledger, plan.id, "400.00", date(2026, 1, 20), loans.PrepaymentMode.REDUCE_TERM)
    status = loans.status(f.ledger, plan.id, date(2026, 1, 20))
    assert status.outstanding == D("600.00") and len(status.installments) == 8
    assert status.ledger_balance == D("600.00") and status.interest_to_come == D("24.32")
    assert status.end == date(2026, 9, 10)


# ── projection ───────────────────────────────────────────


def test_daily_balance_lowest_and_first_negative() -> None:
    account = uuid4()
    start = date(2026, 3, 1)
    events = [
        projection.ProjectedEvent(date(2026, 3, 4), account, D("-100.00"), "Aluguel", "recorrência"),
        projection.ProjectedEvent(date(2026, 3, 2), account, D("-30.00"), "Fatura", "fatura"),
        projection.ProjectedEvent(date(2026, 3, 2), account, D("5.00"), "Pix", "recorrência"),
    ]
    found = projection.AccountProjection(account, start, D("100.00"), events)
    assert found.daily(date(2026, 3, 5)) == [
        (date(2026, 3, 1), D("100.00")),
        (date(2026, 3, 2), D("75.00")),
        (date(2026, 3, 3), D("75.00")),
        (date(2026, 3, 4), D("-25.00")),
        (date(2026, 3, 5), D("-25.00")),
    ]
    assert found.lowest == (date(2026, 3, 4), D("-25.00")) and found.first_negative == date(2026, 3, 4)
    assert found.balance_on(date(2026, 3, 3)) == D("75.00")
    already = projection.AccountProjection(account, start, D("-1.00"), [])
    assert already.first_negative == start and already.lowest == (start, D("-1.00"))
    assert projection.AccountProjection(account, start, D("1.00"), events[2:]).first_negative is None


def test_card_recurrence_joins_its_bill_and_other_rules_are_left_out() -> None:
    f = family()
    ledger = f.ledger
    today = date(2026, 3, 1)
    streaming = f.groceries
    recurrence.add_rule(
        ledger,
        recurrence.RecurrenceRule(
            description="Streaming",
            account_id=f.card_account,
            counterpart_id=streaming,
            amount=D("40"),
            day=5,
            start=date(2026, 2, 1),
        ),
    )  # 05/02 already late (stays on the card), 05/03 enters the bill due 10/04, 05/04 the one due 10/05
    broker = ledger.add_account(
        LedgerAccount(name="Corretora", type=AccountType.ASSET, subtype=AccountSubtype.INVESTMENT)
    ).id
    recurrence.add_rule(
        ledger,
        recurrence.RecurrenceRule(
            description="Aporte",
            account_id=broker,
            counterpart_id=f.groceries,
            amount=D("100"),
            day=10,
            start=date(2026, 3, 1),
        ),
    )  # not a liquid account: not projected
    rent = recurrence.add_rule(
        ledger,
        recurrence.RecurrenceRule(
            description="Aluguel",
            account_id=f.bank,
            counterpart_id=f.groceries,
            amount=D("500"),
            day=15,
            start=date(2026, 3, 1),
        ),
    )
    recurrence.skip(ledger, rent.id, date(2026, 3, 15))  # skipped: not projected
    ledger.put(  # a rule whose account no longer exists
        "recurrence_rule",
        recurrence.RecurrenceRule(
            description="Órfã",
            account_id=uuid4(),
            counterpart_id=f.groceries,
            amount=D("1"),
            day=1,
            start=date(2026, 3, 1),
        ),
    )
    loans.create_loan(ledger, _loan(f, payment_account_id=broker, first_due=date(2026, 3, 20)))
    found, notes = projection.events(ledger, today, date(2026, 4, 30))
    assert [(e.on, e.account_id, e.amount, e.description, e.source) for e in found] == [
        (date(2026, 4, 10), f.bank, D("-40"), "Fatura Cartão X", "fatura"),
        (date(2026, 4, 15), f.bank, D("-500"), "Aluguel", "recorrência"),
    ]
    assert notes == []
    [bank] = projection.project(ledger, today, 60, [f.bank])
    assert bank.balance_on(date(2026, 4, 30)) == D("-540")
    assert [p.account_id for p in projection.negative_ahead(ledger, today, 60)] == [f.bank]  # zero today, then −40
    assert projection.negative_ahead(ledger, today, 30) == []  # the bill is due after 30 days


# ── exports ──────────────────────────────────────────────


def test_ledger_csv_rows_rebalance_and_name_only_members() -> None:
    from opesvault.exports import LEDGER_COLUMNS, ledger_csv
    from opesvault.tax import records

    f = family()
    records.set_member_info(f.ledger, f.ana, cpf="529.982.247-25", birth_date=None, declared_by=None)
    f.ledger.record_expense(
        f.bank, [(f.groceries, "30.00"), (category(f.ledger, "Saúde"), "12.34")], "42.34", date(2026, 3, 2), "Feira"
    )
    rateio = f.ledger.add_operation(
        Operation(
            kind=OperationKind.EXPENSE,
            description="Mercado; dividido",
            postings=(
                Posting(account_id=f.groceries, amount=D("10.00"), member_id=f.bruno),
                Posting(account_id=f.bank, amount=D("-10.00")),
            ),
            occurred_on=date(2026, 3, 3),
            settled_on=date(2026, 3, 3),
        )
    )
    f.ledger.cancel_operation(rateio.id, "duplicado")
    data = ledger_csv(f.ledger)
    assert data.startswith("﻿".encode())
    text = data.decode("utf-8-sig")
    lines = text.splitlines()
    assert lines[0] == ";".join(LEDGER_COLUMNS)
    import csv

    rows = list(csv.DictReader(lines, delimiter=";"))
    assert len(rows) == 5 and sum((D(r["valor"]) for r in rows), D(0)) == 0  # debits and credits cancel
    shared = [r for r in rows if r["integrante_rateio"]]
    assert [(r["integrante_rateio"], r["descricao"], r["valor"]) for r in shared] == [
        ("Bruno", "Mercado; dividido", "10.00")
    ]
    assert {r["situacao"] for r in rows if r["descricao"] == "Mercado; dividido"} != {"active"}
    assert "52998224725" not in text and "529.982.247-25" not in text  # tax ids are not ledger rows


def test_interchange_json_keeps_decimals_as_text_and_leaves_documents_out(tmp_path: Path) -> None:
    from opesvault.exports import INTERCHANGE_FORMAT, interchange_json

    f = family()
    session = Session.new(tmp_path / "x.opesvault")
    session.ledger = f.ledger
    op = f.ledger.record_expense(f.bank, f.groceries, "80.10", date(2026, 1, 5), "Dentista")
    attachments.attach(session, op.id, "recibo.pdf", PDF)
    raw = interchange_json(f.ledger)
    payload = json.loads(raw)
    assert payload["formato"] == INTERCHANGE_FORMAT and payload["versao_formato"] == 1
    assert payload["aviso"] == "Arquivo sem criptografia; contém dados financeiros."
    assert payload["exportado_em"].endswith("+00:00")
    kinds = {e["tipo"] for e in payload["entidades"]}
    assert "attachment" in kinds
    [saved] = [e for e in payload["entidades"] if e["id"] == str(op.id)]
    assert "80.10" in json.dumps(saved["dados"]) and "80.1," not in json.dumps(saved["dados"])
    assert b"recibo sintetico" not in raw and b"%PDF" not in raw  # the receipt's bytes stay in the vault


def test_monthly_report_shows_unknown_indicators_as_a_dash() -> None:
    from opesvault.exports import monthly_report_html

    f = family()
    html = monthly_report_html(f.ledger, YearMonth(year=2026, month=3))
    assert '<td align="right">—</td><td align="left">Sem receitas no mês.</td>' in html
    assert "Nada no período." in html  # empty tables say so instead of showing zeros


def test_annual_report_lists_deductibles_and_incomplete_redemptions() -> None:
    from opesvault.domain.deductibles import DeductibleKind, mark
    from opesvault.exports import annual_report_html

    f = family()
    health = category(f.ledger, "Saúde")
    mark(f.ledger, health, DeductibleKind.HEALTH)
    f.ledger.record_expense(f.bank, health, "350.00", date(2026, 4, 2), "Clínica <Sorriso>", member_id=f.bruno)
    f.ledger.record_expense(f.bank, health, "50.00", date(2026, 5, 2), "Farmácia")
    pos = _position(f)
    inv.redeem_net_only(f.ledger, pos.id, date(2026, 9, 1), "500.00", f.bank)  # gross unknown
    html = annual_report_html(f.ledger, 2026)
    assert "1 resgate(s) sem valor bruto ou custo ficaram fora dos ganhos." in html
    assert "Saúde — Bruno: R$ 350,00" in html and "Saúde — Sem integrante: R$ 50,00" in html
    assert "02/04/2026" in html and "Clínica &lt;Sorriso&gt;" in html and "<Sorriso>" not in html


def test_tax_report_with_every_sheet() -> None:
    from opesvault.domain.deductibles import DeductibleKind, mark
    from opesvault.exports import tax_report_html
    from opesvault.investments import trades
    from opesvault.investments.model import TrackingMode
    from opesvault.tax import records
    from opesvault.tax.model import Bracket, Bucket, BucketRule, IncomeNature, NatureSubject, TaxParameters, TaxSubject

    year = 2025
    f = family()
    ledger = f.ledger
    ledger.record_opening_balance(f.bank, "100000.00", date(year - 1, 12, 1))
    records.set_member_info(ledger, f.ana, cpf="529.982.247-25", birth_date=date(1985, 1, 1), declared_by=None)
    records.set_member_info(
        ledger, f.bruno, cpf="111.444.777-35", birth_date=date(2015, 6, 1), declared_by=f.ana, relation="Filho(a)"
    )
    records.classify(ledger, NatureSubject.CATEGORY, f.salary, IncomeNature.TAXABLE_PJ)
    records.set_identity(ledger, TaxSubject.CATEGORY, f.salary, "11.222.333/0001-81", "Empresa Exemplo Ltda")
    ledger.record_income(f.bank, f.salary, "8000.00", date(year, 1, 5), "Salário", member_id=f.ana)
    rent = ledger.add_account(
        LedgerAccount(name="Aluguel recebido", type=AccountType.INCOME, subtype=AccountSubtype.CATEGORY)
    )
    records.classify(ledger, NatureSubject.CATEGORY, rent.id, IncomeNature.CARNE_LEAO)
    ledger.record_income(f.bank, rent.id, "1500.00", date(year, 3, 1), "Aluguel", member_id=f.ana)
    health = category(ledger, "Saúde")
    mark(ledger, health, DeductibleKind.HEALTH)
    ledger.record_expense(f.bank, health, "300.00", date(year, 5, 2), "CLINICA SORRISO LTDA", member_id=f.bruno)
    debt = ledger.add_account(
        LedgerAccount(name="Financiamento", type=AccountType.LIABILITY, subtype=AccountSubtype.LOAN, holders=(f.ana,))
    )
    ledger.record_opening_balance(debt.id, "-20000.00", date(year, 3, 1))
    pos = inv.create_position(
        ledger, "PETR4", AssetClass.STOCK, date(year, 1, 2), mode=TrackingMode.QUANTITY, holder_id=f.ana
    )
    trades.buy(ledger, pos.id, date(year, 1, 2), "100", "20.00", f.bank)
    records.set_variable_rules(
        ledger,
        date(2000, 1, 1),
        [BucketRule(bucket=Bucket.COMMON, rate=D("0.15"), exempt_sales_limit=D("20000.00"))],
        "teste",
    )
    trades.sell(ledger, pos.id, date(year, 2, 10), "100", "25.00", f.bank)
    records.set_parameters(
        ledger,
        TaxParameters(
            year=year,
            brackets=(
                Bracket(up_to=D("5000.00"), rate=D("0"), deduction=D("0")),
                Bracket(up_to=None, rate=D("0.10"), deduction=D("500.00")),
            ),
            simplified_rate=D("0.20"),
            simplified_cap=D("1000.00"),
            dependent_deduction=D("2000.00"),
        ),
    )
    html = tax_report_html(ledger, year, f.ana)
    assert "Declarante: <b>Ana</b>" in html and "CPF: 529.982.247-25" in html
    assert "<h2>Dependentes</h2>" in html and "111.444.777-35" in html and "01/06/2015" in html
    assert "Filho(a)" in html
    assert "Empresa Exemplo Ltda" in html and "R$ 8.000,00" in html
    assert "Aluguel recebido" in html and "R$ 1.500,00" in html
    assert "<h2>Pagamentos efetuados</h2>" in html and "R$ 300,00" in html
    assert "<h2>Dívidas e ônus reais</h2>" in html and "R$ 20.000,00" in html
    assert "<h2>Renda variável</h2>" in html and "02/2025" in html
    assert "Falta informar" not in html and "Imposto devido" in html
    # taxable 9500; simplified: 9500 − 1000 (cap) = 8500 → 350,00; itemized: 9500 − 300 − 2000 = 7200 → 220,00
    assert "R$ 350,00" in html and "R$ 220,00" in html


def test_tax_report_for_the_whole_family_asks_for_the_table() -> None:
    from opesvault.exports import WARNING, tax_report_html

    f = family()
    html = tax_report_html(f.ledger, 2025)
    assert "Declarante: <b>todo o projeto</b>" in html and WARNING in html
    assert "Falta informar: a tabela anual de 2025." in html
    assert "CPF:" not in html and "<h2>Dependentes</h2>" not in html


def test_tax_report_of_a_declarant_without_dependents_or_pending_items() -> None:
    from opesvault.exports import tax_report_html
    from opesvault.tax import records
    from opesvault.tax.model import Bracket, TaxParameters

    f = family()
    records.set_member_info(f.ledger, f.ana, cpf="529.982.247-25", birth_date=date(1985, 1, 1), declared_by=None)
    records.set_parameters(
        f.ledger,
        TaxParameters(
            year=2025,
            brackets=(Bracket(up_to=None, rate=D("0.10"), deduction=D("0")),),
            simplified_rate=D("0.20"),
            simplified_cap=D("1000.00"),
        ),
    )
    html = tax_report_html(f.ledger, 2025, f.ana)
    assert "CPF: 529.982.247-25" in html and "<h2>Dependentes</h2>" not in html
    assert "Pendências" not in html and "Falta informar" not in html
