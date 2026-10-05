"""tax/{records,declaration,checklist,simulation,variable_income}.py, domain/banking.py and investments/profile.py.

Same replay scheme as cases_investments: a base ledger (records), commands through the public API
(classifications, CPF/CNPJ, payslips, filings, goods, informes, the user's tables, DARFs, marks,
bank accounts, investment characteristics, trades) and, after them, a snapshot of every sheet of
the year for the whole project and for each declarant. Nothing here is a real tax table: every
rate and limit is typed by the scenario (docs/00 §5).

Not covered: `declaration.payments` with deductible categories (`domain/deductibles` belongs to
another area; without it the TS side has no deductible source) and `banking.record_values` for
accounts (it records a conferência in `domain/balance_checks`).
"""

import random
from datetime import date, timedelta
from decimal import Decimal
from typing import Any
from uuid import UUID

from opesvault.catalogs.irpf import investment_codes
from opesvault.domain import banking, queries
from opesvault.domain.ledger import DomainError, Ledger
from opesvault.domain.model import AccountSubtype, AccountType, LedgerAccount, YearMonth
from opesvault.investments import profile as prof
from opesvault.investments.service import positions
from opesvault.tax import checklist, declaration, records, simulation, variable_income
from opesvault.tax.model import (
    BucketRule,
    DeclaredAsset,
    FilingSubject,
    IncomeKind,
    IncomeNature,
    NatureSubject,
    PaymentPurpose,
    ReportLine,
    ReportSource,
    TaxParameters,
    TaxSubject,
)
from scripts.golden.cases_investments import INVESTMENT_COMMANDS, dump, known_ids, norm, records_of, run_commands
from scripts.golden.common import j

Y = 2025
CNPJ_A = "11222333000181"
CNPJ_B = "11.444.777/0001-61"
CPF_ANA = "529.982.247-25"
CPF_BRUNO = "111.444.777-35"
CPF_CARLA = "12345678909"


def _d(text: str) -> date:
    return date.fromisoformat(text)


def _maybe_date(text: str | None) -> date | None:
    return date.fromisoformat(text) if text else None


def _ref(subject: str, ref: Any) -> Any:
    """Merchant refs are text keys; the others are ids."""
    return ref if subject == "merchant" else UUID(str(ref))


def _bank_create(led: Ledger, fields: dict[str, Any], checking: Any, savings: Any, opening: dict[str, Any]) -> Any:
    item = banking.build(**fields)
    parts = {banking.Part(k): (Decimal(v[0]), _d(v[1])) for k, v in opening.items()}
    return banking.create(led, item, checking=checking, savings=savings, opening=parts)


def _bank_update(led: Ledger, bank_id: UUID, changes: dict[str, Any], add: list[str]) -> Any:
    current = banking.bank_accounts(led).get(bank_id)
    if current is None:
        raise DomainError("Conta bancária inexistente.")
    return banking.update(led, current.model_copy(update=changes), add=tuple(banking.Part(p) for p in add))


def _asset_update(led: Ledger, asset_id: UUID, changes: dict[str, Any], reason: str | None) -> Any:
    current = records.declared_assets(led)[asset_id]
    update: dict[str, Any] = {k: (_maybe_date(v) if k in ("acquired_on", "sold_on") else v) for k, v in changes.items()}
    if "cost" in update:
        update["cost"] = Decimal(update["cost"])
    if update.get("sale_value") is not None:
        update["sale_value"] = Decimal(update["sale_value"])
    return records.save_declared_asset(led, current.model_copy(update=update), reason)


def _profile(led: Ledger, fields: dict[str, Any]) -> Any:
    return prof.save_profile(led, prof.InvestmentProfile(**fields))


def _rules(rules: list[dict[str, Any]]) -> list[BucketRule]:
    return [BucketRule(**r) for r in rules]


TAX_COMMANDS: dict[str, Any] = {
    **INVESTMENT_COMMANDS,
    "member": lambda led, name: led.add_member(name),
    "income": lambda led, acc, cat, amount, on, desc, member=None: led.record_income(
        acc, cat, amount, _d(on), desc, member_id=member
    ),
    "expense": lambda led, acc, cat, amount, on, desc, member=None: led.record_expense(
        acc, cat, amount, _d(on), desc, member_id=member
    ),
    "opening": lambda led, acc, amount, on: led.record_opening_balance(acc, amount, _d(on)),
    "classify": lambda led, subject, ref, nature: records.classify(
        led, NatureSubject(subject), ref, IncomeNature(nature) if nature else None
    ),
    "set_identity": lambda led, subject, ref, tax_id, name=None: records.set_identity(
        led, TaxSubject(subject), _ref(subject, ref), tax_id, name
    ),
    "clear_identity": lambda led, subject, ref: records.clear_identity(led, TaxSubject(subject), _ref(subject, ref)),
    "set_member_info": lambda led, member, cpf, birth, declared_by, relation=None: records.set_member_info(
        led, member, cpf=cpf, birth_date=_maybe_date(birth), declared_by=declared_by, relation=relation
    ),
    "set_income_detail": lambda led, op, kind, gross=None, withheld=None, ss=None: records.set_income_detail(
        led, op, IncomeKind(kind), gross, withheld, ss
    ),
    "set_filing": lambda led, subject, ref, group, code, text: records.set_filing(
        led, FilingSubject(subject), ref, group, code, text
    ),
    "save_declared_asset": lambda led, fields, reason=None: records.save_declared_asset(
        led, DeclaredAsset(**fields), reason
    ),
    "update_declared_asset": _asset_update,
    "remove_declared_asset": lambda led, asset_id: records.remove_declared_asset(led, asset_id),
    "save_report": lambda led, year, source, source_id, lines, **o: records.save_report(
        led, year, ReportSource(source), source_id, [ReportLine(**x) for x in lines], **o
    ),
    "remove_report": lambda led, report_id: records.remove_report(led, report_id),
    "set_parameters": lambda led, fields: records.set_parameters(led, TaxParameters(**fields)),
    "set_variable_rules": lambda led, valid_from, rules, source: records.set_variable_rules(
        led, _d(valid_from), _rules(rules), source
    ),
    "record_payment": lambda led, purpose, month, amount, on, src, member=None: records.record_payment(
        led, PaymentPurpose(purpose), YearMonth(**month), amount, _d(on), src, member
    ),
    "set_mark": lambda led, year, key, received, note=None: records.set_mark(led, year, key, received, note),
    "bank_create": _bank_create,
    "bank_update": _bank_update,
    "bank_archive": lambda led, bank_id: banking.archive(led, bank_id),
    "adjust_balance": lambda led, acc, on, value: banking.adjust_balance(led, acc, _d(on), Decimal(value)),
    "record_values": lambda led, bank_id, on, values, adjust=(), note=None: banking.record_values(
        led, bank_id, _d(on), {UUID(str(k)): v for k, v in values}, adjust=set(adjust), note=note
    ),
    "save_profile": _profile,
}


# ── snapshot ──────────


def _sorted_people(people: set[UUID] | None, known: set[str]) -> Any:
    return None if people is None else sorted(norm(str(p), known) for p in people)


def _year_sheets(ledger: Ledger, year: int, declarant: UUID | None, known: set[str]) -> dict[str, Any]:
    people = records.people_of(ledger, declarant)
    income = declaration.income(ledger, year, people)
    comparison = simulation.compare(ledger, year, declarant)
    rows = variable_income.months(ledger, year, people)
    return {
        "year": year,
        "declarant": norm(j(declarant), known),
        "people": _sorted_people(people, known),
        "income": norm(j(income), known),
        "unclassified": len(income.unclassified),
        "assets": norm(
            [{**j(r), "group_label": r.group_label} for r in declaration.assets(ledger, year, people)], known
        ),
        "debts": norm(j(declaration.debts(ledger, year, people)), known),
        "payments": norm(j(declaration.payments(ledger, year, people)), known),
        "dependents": norm(j(declaration.dependents(ledger, declarant)), known),
        "checklist": norm(j(checklist.expected(ledger, year, people)), known),
        "missing": len(checklist.missing(checklist.expected(ledger, year, people))),
        "comparison": {
            **norm(j(comparison), known),
            "best": comparison.best.name if comparison.best else None,
            "balance_simplified": j(comparison.balance(comparison.simplified)),
            "balance_itemized": j(comparison.balance(comparison.itemized)),
        },
        "carne_leao_paid": j(simulation.carne_leao_paid(ledger, year)),
        "trades": norm(j(variable_income.trades(ledger, people)), known),
        "months": norm([{**j(r), "missing_rate": r.missing_rate} for r in rows], known),
        "carried_loss": j({b.value: v for b, v in variable_income.carried_loss(ledger, year, people).items()}),
        "exempt_total": j(variable_income.exempt_total(rows)),
        "due_by_month": [[str(m), j(v[0]), j(v[1]), j(v[2])] for m, v in variable_income.due_by_month(rows).items()],
    }


def snapshot(ledger: Ledger, known: set[str]) -> dict[str, Any]:
    out: dict[str, Any] = {
        "accounts": [[a.name, j(queries.balance(ledger, a.id))] for a in ledger.accounts.values()],
        "account_payloads": [norm(dump(a), known) for a in ledger.accounts.values()],
        "operations": [
            {k: v for k, v in norm(dump(op), known).items() if k != "id"} for op in ledger.operations.values()
        ],
        "row_counts": ledger.row_counts(),
    }
    for kind in (
        "tax_identity",
        "member_tax_info",
        "income_classification",
        "income_detail",
        "asset_filing",
        "declared_asset",
        "income_report",
        "tax_parameters",
        "variable_income_rules",
        "tax_payment",
        "tax_checklist_mark",
        "bank_account",
        "investment_profile",
    ):
        out[kind] = [norm(dump(e), known) for e in ledger.entities(kind).values()]
    out["declarants"] = norm([str(m) for m in records.declarants(ledger)], known)
    natures = []
    for account in ledger.accounts.values():
        if account.type is AccountType.INCOME:
            natures.append([account.name, j(records.nature_of(ledger, NatureSubject.CATEGORY, account.id))])
    for pos in positions(ledger).values():
        natures.append(
            [
                norm(str(pos.id), known),
                j(records.nature_of(ledger, NatureSubject.POSITION, pos.id)),
                records.income_code_of(ledger, pos.id),
                prof.yield_text(prof.profile_of(ledger, pos.id)),
                prof.description(ledger, pos.id),
                prof.income_code_label(p.income_code if (p := prof.profile_of(ledger, pos.id)) else None),
            ]
        )
    out["natures"] = natures
    out["reports_of"] = {str(y): norm(j(records.reports_of(ledger, y)), known) for y in (Y - 1, Y, Y + 1)}
    out["variable_rules"] = [
        norm(j(records.variable_rules(ledger, d)), known)
        for d in (None, date(1999, 1, 1), date(2024, 6, 30), date(Y, 3, 31), date(Y, 12, 31))
    ]
    out["paid"] = [
        j(records.paid(ledger, purpose, YearMonth(year=Y, month=m), member))
        for purpose in PaymentPurpose
        for m in (3, 4, 8)
        for member in (None, *list(ledger.members)[:2])
    ]
    banks = []
    for item in banking.bank_accounts(ledger).values():
        on_dates = [date(Y, 1, 1), date(Y, 6, 30), date(Y, 12, 31)]
        values = [norm(j(banking.values_at(ledger, item.id, on)), known) for on in on_dates]
        banks.append(
            {
                "id": norm(str(item.id), known),
                "where": item.where,
                "holders": norm(j(item.holders), known),
                "joint": item.joint,
                "components": norm(j(item.components()), known),
                "positions": norm(j(banking.positions_of(ledger, item.id)), known),
                "values": values,
                "totals": [j(banking.total(banking.values_at(ledger, item.id, on))) for on in on_dates],
            }
        )
    out["banks"] = banks
    out["of_account"] = [
        norm(j(b.id) if (b := banking.of_account(ledger, a.id)) else None, known) for a in ledger.accounts.values()
    ]
    sheets = []
    members: list[UUID | None] = [None, *ledger.members]
    for year in (Y - 1, Y, Y + 1):
        for declarant in members:
            sheets.append(_year_sheets(ledger, year, declarant, known))
    out["sheets"] = sheets
    return out


# ── base and scenarios ──────────


def base() -> tuple[Ledger, dict[str, str]]:
    ledger = Ledger.new("Projeto IR")
    ana = ledger.add_member("Ana").id
    bruno = ledger.add_member("Bruno").id
    carla = ledger.add_member("Carla").id

    def asset(name: str, subtype: AccountSubtype, holders: tuple[UUID, ...] = (), **extra: Any) -> UUID:
        return ledger.add_account(
            LedgerAccount(name=name, type=AccountType.ASSET, subtype=subtype, holders=holders, **extra)
        ).id

    def category(name: str, kind: AccountType, parent: UUID | None = None) -> UUID:
        found = next((a for a in ledger.categories(kind) if a.name == name), None)
        if found is not None:
            return found.id
        return ledger.add_account(
            LedgerAccount(name=name, type=kind, subtype=AccountSubtype.CATEGORY, parent_id=parent)
        ).id

    names: dict[str, UUID] = {
        "ana": ana,
        "bruno": bruno,
        "carla": carla,
        "bank": asset("Banco A", AccountSubtype.CHECKING, (ana,), institution="Banco A S.A.", masked_number="1234-5"),
        "joint": asset("Conjunta", AccountSubtype.CHECKING, (ana, bruno)),
        "broker": asset("Corretora", AccountSubtype.BROKERAGE_CASH, (bruno,)),
        "savings": asset("Poupança", AccountSubtype.SAVINGS, (ana,)),
        "cash": asset("Carteira", AccountSubtype.CASH),
        "nobody": asset("Conta sem titular", AccountSubtype.CHECKING),
        "salary": category("Salário", AccountType.INCOME),
        "rent": category("Aluguel recebido", AccountType.INCOME),
        "freelance": category("Freelance", AccountType.INCOME),
        "other_income": category("Outras receitas", AccountType.INCOME),
        "health": category("Saúde", AccountType.EXPENSE),
        "food": category("Alimentação", AccountType.EXPENSE),
    }
    names["bonus"] = category("Salário — bônus", AccountType.INCOME, names["salary"])
    names["loan"] = ledger.add_account(
        LedgerAccount(name="Financiamento", type=AccountType.LIABILITY, subtype=AccountSubtype.LOAN, holders=(ana,))
    ).id
    names["debt"] = ledger.add_account(
        LedgerAccount(name="Dívida com parente", type=AccountType.LIABILITY, subtype=AccountSubtype.OTHER_LIABILITY)
    ).id
    ledger.record_opening_balance(names["bank"], "30000.00", date(Y - 1, 6, 1))
    ledger.record_opening_balance(names["joint"], "5000.00", date(Y - 1, 12, 31))
    ledger.record_opening_balance(names["broker"], "200000.00", date(Y - 1, 12, 1))
    ledger.record_opening_balance(names["cash"], "300.00", date(Y, 1, 1))
    ledger.record_opening_balance(names["loan"], "20000.00", date(Y, 3, 1))
    return Ledger.from_records(ledger.to_records()), {k: str(v) for k, v in names.items()}


def _salary() -> list[dict[str, Any]]:
    return [
        {"cmd": "classify", "args": ["category", "@salary", "taxable_pj"]},
        {"cmd": "set_identity", "args": ["category", "@salary", "11.222.333/0001-81", "  Empresa   Exemplo Ltda "]},
        {"cmd": "income", "args": ["@bank", "@salary", "4000.00", f"{Y}-01-05", "Salário", "@ana"]},
        {"cmd": "set_income_detail", "args": ["$2", "salary", "5000.00", "450.00", "550.00"]},
        {"cmd": "income", "args": ["@bank", "@salary", "2000.00", f"{Y}-12-20", "13º", "@ana"]},
        {"cmd": "set_income_detail", "args": ["$4", "thirteenth", "2400.00", "150.00", None]},
        {"cmd": "income", "args": ["@bank", "@salary", "4000.00", f"{Y}-02-05", "Salário", "@ana"]},
        {"cmd": "set_income_detail", "args": ["$2", "salary", "100.00"]},
        {"cmd": "set_income_detail", "args": ["$2", "salary", "5000.001"]},
        {"cmd": "set_income_detail", "args": ["$6", "salary", None, None, None]},
        {"cmd": "set_income_detail", "args": ["$6", "other", "", " ", None]},
        {"cmd": "income", "args": ["@joint", "@bonus", "1500.00", f"{Y}-07-10", "Bônus", "@bruno"]},
        {"cmd": "income", "args": ["@nobody", "@salary", "800.00", f"{Y}-08-05", "Sem dono"]},
        {"cmd": "set_member_info", "args": ["@ana", CPF_ANA, "1985-01-01", None]},
        {"cmd": "set_member_info", "args": ["@bruno", CPF_BRUNO, "2015-01-01", "@ana", " Filho(a) "]},
        {"cmd": "set_member_info", "args": ["@ana", CPF_BRUNO, None, None]},
        {"cmd": "set_member_info", "args": ["@ana", CPF_ANA, None, "@bruno"]},
        {"cmd": "set_member_info", "args": ["@carla", "123", None, None]},
        {"cmd": "set_member_info", "args": ["@carla", CPF_CARLA, "1990-02-03", "@carla"]},
        {"cmd": "set_member_info", "args": ["@carla", CPF_CARLA, "1990-02-03", "@bruno"]},
        {"cmd": "set_member_info", "args": ["@ana", CPF_ANA, "1985-01-01", None]},
        {"cmd": "set_member_info", "args": ["@ana", CPF_ANA, "1985-01-02", None, "Titular"]},
        {"cmd": "save_report", "args": [Y, "category", "@salary", [{"field": "taxable", "amount": "9000.00"}]]},
        {"cmd": "save_report", "args": [Y, "category", "@salary", []]},
        {"cmd": "save_report", "args": [Y, "account", "@salary", []]},
        {"cmd": "save_report", "args": [Y, "category", "@bank", []]},
        {"cmd": "save_report", "args": [1989, "account", "@bank", []]},
        {
            "cmd": "save_report",
            "args": [Y, "account", "@bank", [{"field": "balance_end", "amount": "2500.00", "label": "Saldo"}]],
            "opts": {"payer_tax_id": CNPJ_B, "payer_name": "  Banco A  ", "note": " conferido "},
        },
        {
            "cmd": "save_report",
            "args": [Y, "account", "@bank", [{"field": "withheld", "amount": "10.255"}]],
            "opts": {"report_id": "$27"},
        },
        {
            "cmd": "save_report",
            "args": [Y, "account", "@bank", [{"field": "withheld", "amount": "10.25"}]],
            "opts": {"report_id": "$27", "payer_tax_id": "123"},
        },
        {
            "cmd": "save_report",
            "args": [Y, "account", "@bank", [{"field": "withheld", "amount": "10.25"}]],
            "opts": {"report_id": "$27"},
        },
        {"cmd": "set_mark", "args": [Y, "informe:conta:@bank", True]},
        {"cmd": "set_mark", "args": [Y, "nada", False, "  ainda não chegou "]},
        {"cmd": "set_mark", "args": [Y, "nada", True]},
        {"cmd": "set_mark", "args": [Y, "nada", None]},
        {"cmd": "set_mark", "args": [Y, "nada", None]},
        {
            "cmd": "set_parameters",
            "args": [
                {
                    "year": Y,
                    "brackets": [
                        {"up_to": "5000.00", "rate": "0", "deduction": "0"},
                        {"up_to": None, "rate": "0.10", "deduction": "500.00"},
                    ],
                    "simplified_rate": "0.20",
                    "simplified_cap": "1000.00",
                }
            ],
        },
        {
            "cmd": "set_parameters",
            "args": [
                {
                    "year": Y,
                    "brackets": [
                        {"up_to": None, "rate": "0.1", "deduction": "0"},
                        {"up_to": "1", "rate": "0", "deduction": "0"},
                    ],
                }
            ],
        },
        {
            "cmd": "set_parameters",
            "args": [
                {
                    "year": Y,
                    "brackets": [
                        {"up_to": "2000.00", "rate": "0", "deduction": "0"},
                        {"up_to": "1000.00", "rate": "0.075", "deduction": "150.00"},
                    ],
                }
            ],
        },
        {
            "cmd": "set_parameters",
            "args": [{"year": Y, "brackets": [{"up_to": None, "rate": "1.5", "deduction": "0"}]}],
        },
        {
            "cmd": "set_parameters",
            "args": [{"year": Y, "brackets": [{"up_to": None, "rate": "0.1", "deduction": "1.001"}]}],
        },
        {
            "cmd": "set_parameters",
            "args": [
                {
                    "year": Y - 1,
                    "brackets": [
                        {"up_to": "2259.20", "rate": "0", "deduction": "0"},
                        {"up_to": "2826.65", "rate": "0.075", "deduction": "169.44"},
                        {"up_to": None, "rate": "0.275", "deduction": "896.00"},
                    ],
                    "dependent_deduction": "2275.08",
                    "education_cap": "3561.50",
                    "pension_cap_rate": "0.12",
                }
            ],
        },
    ]


def _salary_more() -> list[dict[str, Any]]:
    """Appended to the salary scenario: removals and members (no index shifts)."""
    return [
        {"cmd": "remove_report", "args": ["$22"]},
        {"cmd": "remove_report", "args": ["$22"]},
        {"cmd": "member", "args": ["  Davi "]},
        {"cmd": "member", "args": ["ana"]},
        {"cmd": "set_member_info", "args": ["@carla", None, None, "@ana", "Cônjuge"]},
        {"cmd": "set_income_detail", "args": ["$4", "salary", None, None, None]},
    ]


def _carne_leao() -> list[dict[str, Any]]:
    return [
        {"cmd": "income", "args": ["@bank", "@rent", "1500.00", f"{Y}-03-01", "Aluguel", "@ana"]},
        {"cmd": "income", "args": ["@joint", "@rent", "1500.00", f"{Y}-04-01", "Aluguel"]},
        {"cmd": "income", "args": ["@bank", "@freelance", "700.00", f"{Y}-04-15", "Projeto", "@bruno"]},
        {"cmd": "income", "args": ["@cash", "@other_income", "50.00", f"{Y}-05-15", "Venda"]},
        {"cmd": "classify", "args": ["category", "@rent", "carne_leao"]},
        {"cmd": "classify", "args": ["category", "@freelance", "exempt"]},
        {"cmd": "classify", "args": ["category", "@freelance", "exclusive"]},
        {"cmd": "classify", "args": ["category", "@freelance", "exclusive"]},
        {"cmd": "classify", "args": ["category", "@other_income", "ignored"]},
        {"cmd": "classify", "args": ["category", "@other_income", None]},
        {"cmd": "classify", "args": ["category", "@food", "exempt"]},
        {"cmd": "classify", "args": ["position", "@bank", "exempt"]},
        {"cmd": "set_identity", "args": ["merchant", "  ", CNPJ_A]},
        {"cmd": "set_identity", "args": ["merchant", "CLINICA SORRISO", CNPJ_A, "Clínica"]},
        {"cmd": "set_identity", "args": ["merchant", "CLINICA SORRISO", CPF_ANA, "Clínica"]},
        {"cmd": "set_identity", "args": ["account", "@bank", "00.000.000/0000-00"]},
        {"cmd": "set_identity", "args": ["account", "@loan", CNPJ_B, "Banco do Financiamento"]},
        {"cmd": "set_identity", "args": ["category", "@rent", CPF_CARLA, "Inquilina"]},
        {"cmd": "clear_identity", "args": ["merchant", "CLINICA SORRISO"]},
        {
            "cmd": "record_payment",
            "args": ["carne_leao", {"year": Y, "month": 3}, "100.00", f"{Y}-04-20", "@bank", "@ana"],
        },
        {"cmd": "record_payment", "args": ["carne_leao", {"year": Y, "month": 4}, "0", f"{Y}-05-20", "@bank"]},
        {"cmd": "record_payment", "args": ["carne_leao", {"year": Y, "month": 4}, "10.00", f"{Y}-05-20", "@loan"]},
        {"cmd": "record_payment", "args": ["carne_leao", {"year": Y, "month": 4}, "35.10", f"{Y}-05-20", "@joint"]},
    ]


def _goods() -> list[dict[str, Any]]:
    car = {
        "name": "Carro",
        "group": "02",
        "code": "01",
        "owner_id": "@ana",
        "acquired_on": f"{Y}-03-01",
        "cost": "60000.00",
    }
    return [
        {"cmd": "save_declared_asset", "args": [car]},
        {
            "cmd": "save_declared_asset",
            "args": [
                {
                    **car,
                    "name": "Casa",
                    "group": "01",
                    "code": "12",
                    "acquired_on": "2010-05-05",
                    "cost": "300000.00",
                    "owner_id": None,
                }
            ],
        },
        {"cmd": "save_declared_asset", "args": [{**car, "code": "77"}]},
        {"cmd": "save_declared_asset", "args": [{**car, "group": "55"}]},
        {"cmd": "save_declared_asset", "args": [{**car, "cost": "1.001"}]},
        {"cmd": "save_declared_asset", "args": [{**car, "sold_on": f"{Y - 1}-01-01"}]},
        {"cmd": "save_declared_asset", "args": [{**car, "owner_id": "@nobody"}]},
        {"cmd": "update_declared_asset", "args": ["$0", {"sold_on": f"{Y}-11-30", "sale_value": "55000.00"}, None]},
        {"cmd": "update_declared_asset", "args": ["$1", {"description": "Casa na praia"}, "descrição"]},
        {
            "cmd": "save_declared_asset",
            "args": [{**car, "name": "Moto", "acquired_on": f"{Y + 1}-01-10", "cost": "9000.00", "owner_id": "@bruno"}],
        },
        {"cmd": "remove_declared_asset", "args": ["$9"]},
        {"cmd": "set_filing", "args": ["account", "@bank", "06", "01", "  Conta   corrente no Banco A "]},
        {"cmd": "set_filing", "args": ["account", "@bank", "06", "01", "Conta corrente no Banco A"]},
        {"cmd": "set_filing", "args": ["account", "@bank", "06", "99", ""]},
        {"cmd": "set_filing", "args": ["account", "@bank", "66", "01", "x"]},
        {"cmd": "opening", "args": ["@debt", "750.00", f"{Y - 1}-01-01"]},
        {"cmd": "expense", "args": ["@nobody", "@food", "10.00", f"{Y}-01-01", "Mercado"]},
    ]


def _investments() -> list[dict[str, Any]]:
    return [
        {
            "cmd": "create_position",
            "args": ["CDB X", "fixed_income", f"{Y}-02-01"],
            "opts": {"initial_cost": "5000", "from_account": "@bank", "holder_id": "@ana"},
        },
        {"cmd": "add_valuation", "args": ["$0", f"{Y}-12-31", "5400", "gross"], "opts": {}},
        {
            "cmd": "create_position",
            "args": ["Fundo antigo", "fund", f"{Y - 1}-06-01"],
            "opts": {"reference_value": "8000.00", "holder_id": "@bruno"},
        },
        {"cmd": "set_filing", "args": ["position", "$0", "04", "02", "CDB do Banco X"]},
        {"cmd": "distribute", "args": ["$0", "40.00", f"{Y}-08-01", "@bank", "6.00"]},
        {
            "cmd": "redeem",
            "args": ["$0", f"{Y}-10-01", "1000.00", "@bank"],
            "opts": {"cost_attributed": "900.00", "tax_withheld": "15.00"},
        },
        {"cmd": "redeem", "args": ["$0", f"{Y}-11-01", "500.00", "@bank"], "opts": {"cost_attributed": "600.00"}},
        {"cmd": "classify", "args": ["position", "$0", "exclusive"]},
        {"cmd": "set_identity", "args": ["account", "@bank", CNPJ_A, "Banco A S.A."]},
        {
            "cmd": "save_profile",
            "args": [
                {
                    "position_id": "$2",
                    "irpf_group": "07",
                    "irpf_code": "01",
                    "issuer": "Gestora Y",
                    "issuer_tax_id": CNPJ_A,
                    "indexer": "other",
                    "rate": "1.5",
                    "tax": "come_cotas",
                    "applied_on": f"{Y - 1}-06-01",
                }
            ],
        },
        {"cmd": "save_profile", "args": [{"position_id": "$2", "irpf_group": "07"}]},
        {"cmd": "save_profile", "args": [{"position_id": "$2", "income_code": "exclusivo:99"}]},
        {"cmd": "save_profile", "args": [{"position_id": "$2", "rate": "-100"}]},
        {"cmd": "save_profile", "args": [{"position_id": "$2", "issuer_tax_id": "11222333000180"}]},
        {"cmd": "save_profile", "args": [{"position_id": "$2", "applied_on": "2025-01-02", "maturity": "2025-01-01"}]},
        {"cmd": "save_profile", "args": [{"position_id": "@bank"}]},
        {"cmd": "save_profile", "args": [{"position_id": "$2", "bank_account_id": "@bank"}]},
        {"cmd": "distribute", "args": ["$2", "120.00", f"{Y}-09-01", "@broker"]},
        {
            "cmd": "create_position",
            "args": ["PETR4", "stock", f"{Y}-01-02"],
            "opts": {"mode": "quantity", "holder_id": "@ana"},
        },
        {"cmd": "buy", "args": ["$18", f"{Y}-01-02", "1000", "20.00", "@bank"], "opts": {}},
        {
            "cmd": "set_variable_rules",
            "args": [
                "2000-01-01",
                [
                    {"bucket": "common", "rate": "0.15", "exempt_sales_limit": "20000.00"},
                    {"bucket": "day_trade", "rate": "0.20"},
                ],
                "teste",
            ],
        },
        {"cmd": "sell", "args": ["$18", f"{Y}-02-10", "100", "25.00", "@bank"], "opts": {}},
        {"cmd": "sell", "args": ["$18", f"{Y}-03-10", "500", "18.00", "@bank"], "opts": {}},
        {"cmd": "sell", "args": ["$18", f"{Y}-04-10", "400", "70.00", "@bank"], "opts": {"fees": "3.50"}},
        {"cmd": "buy", "args": ["$18", f"{Y}-05-05", "100", "10.00", "@bank"], "opts": {"fees": "1.10"}},
        {"cmd": "sell", "args": ["$18", f"{Y}-05-05", "60", "12.00", "@bank"], "opts": {"tax_withheld": "0.07"}},
        {"cmd": "sell", "args": ["$18", f"{Y}-05-05", "40", "12.50", "@bank"], "opts": {"fees": "0.33"}},
        {
            "cmd": "record_payment",
            "args": ["variable_income", {"year": Y, "month": 4}, "2850.00", f"{Y}-05-20", "@bank"],
        },
        {
            "cmd": "create_position",
            "args": ["HGLG11", "reit", f"{Y}-01-02"],
            "opts": {"mode": "quantity", "holder_id": "@bruno"},
        },
        {"cmd": "buy", "args": ["$28", f"{Y}-06-02", "100", "160.00", "@broker"], "opts": {}},
        {"cmd": "sell", "args": ["$28", f"{Y}-06-02", "30", "150.00", "@broker"], "opts": {}},
        {"cmd": "sell", "args": ["$28", f"{Y}-07-02", "50", "170.00", "@broker"], "opts": {"fees": "2.00"}},
        {
            "cmd": "set_variable_rules",
            "args": [f"{Y}-07-01", [{"bucket": "reit", "rate": "0.20"}, {"bucket": "common", "rate": "1.5"}], ""],
        },
        {"cmd": "set_variable_rules", "args": [f"{Y}-07-01", [{"bucket": "reit", "rate": "0.20"}], ""]},
        {"cmd": "set_variable_rules", "args": [f"{Y}-07-01", [{"bucket": "reit", "rate": "0.20"}], "  "]},
        {
            "cmd": "create_position",
            "args": ["ETF IVVB", "etf", f"{Y - 1}-03-02"],
            "opts": {"initial_cost": "10000", "from_account": "@broker", "holder_id": "@bruno"},
        },
        {"cmd": "add_valuation", "args": ["$35", f"{Y}-09-30", "12000", "gross"], "opts": {}},
        {"cmd": "redeem", "args": ["$35", f"{Y}-09-30", "3000", "@broker"], "opts": {"fees": "5.00"}},
        {"cmd": "sell", "args": ["$18", f"{Y + 1}-01-15", "200", "5.00", "@bank"], "opts": {}},
        {"cmd": "sell", "args": ["$18", f"{Y - 1}-12-15", "1", "5.00", "@bank"], "opts": {}},
    ]


def _banking() -> list[dict[str, Any]]:
    itau = {
        "name": "Itaú da Ana",
        "bank_code": "341",
        "bank_name": None,
        "branch": "0123",
        "number": "45678-X",
        "holder_id": "@ana",
        "co_holder_id": "@bruno",
    }
    return [
        {
            "cmd": "bank_create",
            "args": [itau, True, True, {"checking": ["1000.00", f"{Y}-01-02"], "savings": ["0", f"{Y}-01-02"]}],
        },
        {"cmd": "bank_create", "args": [{**itau, "branch": "01 23"}, True, False, {}]},
        {"cmd": "bank_create", "args": [{**itau, "bank_code": "000"}, True, False, {}]},
        {"cmd": "bank_create", "args": [{**itau, "co_holder_id": "@ana"}, True, False, {}]},
        {
            "cmd": "bank_create",
            "args": [
                {
                    **itau,
                    "name": "",
                    "bank_code": None,
                    "bank_name": "  Cooperativa   Local ",
                    "branch": "A1/b",
                    "number": "#9",
                    "co_holder_id": None,
                },
                "@savings",
                False,
                {},
            ],
        },
        {
            "cmd": "bank_create",
            "args": [{**itau, "name": "  ", "bank_code": "1", "co_holder_id": None}, False, "@savings", {}],
        },
        {
            "cmd": "bank_create",
            "args": [{**itau, "name": "Sem banco", "bank_code": None, "bank_name": " "}, False, False, {}],
        },
        {
            "cmd": "bank_create",
            "args": [
                {**itau, "name": "Nubank", "bank_code": "260", "branch": None, "number": None, "co_holder_id": None},
                True,
                False,
                {},
            ],
        },
        {"cmd": "bank_create", "args": [{**itau, "bank_code": "001"}, "@food", False, {}]},
        {"cmd": "bank_update", "args": ["$7", {"co_holder_id": "@carla", "number": "999-1"}, ["savings"]]},
        {"cmd": "bank_update", "args": ["$7", {}, []]},
        {"cmd": "bank_update", "args": ["$7", {"holder_id": "@bruno", "co_holder_id": None}, ["checking"]]},
        {"cmd": "bank_archive", "args": ["$4"]},
        {"cmd": "bank_archive", "args": ["$4"]},
        {
            "cmd": "create_position",
            "args": ["LCA Banco X", "fixed_income", f"{Y}-02-01"],
            "opts": {"initial_cost": "3000", "from_account": "@bank"},
        },
        {
            "cmd": "save_profile",
            "args": [
                {
                    "position_id": "$14",
                    "bank_account_id": "$0",
                    "irpf_group": "04",
                    "irpf_code": "03",
                    "issuer": "Banco X S.A.",
                    "issuer_tax_id": CNPJ_A,
                    "indexer": "cdi",
                    "rate": "95",
                    "applied_on": f"{Y}-02-01",
                    "maturity": f"{Y + 2}-02-01",
                    "liquidity": "at_maturity",
                    "tax": "exempt",
                    "income_code": "isento:12",
                    "fgc": True,
                }
            ],
        },
        {
            "cmd": "save_profile",
            "args": [
                {
                    "position_id": "$14",
                    "bank_account_id": "$0",
                    "irpf_group": "04",
                    "irpf_code": "03",
                    "issuer": "Banco X S.A.",
                    "issuer_tax_id": CNPJ_A,
                    "indexer": "cdi",
                    "rate": "95.0",
                    "applied_on": f"{Y}-02-01",
                    "maturity": f"{Y + 2}-02-01",
                    "liquidity": "at_maturity",
                    "tax": "exempt",
                    "income_code": "isento:12",
                    "fgc": True,
                }
            ],
        },
        {"cmd": "bank_update", "args": ["$0", {"holder_id": "@bruno", "co_holder_id": "@ana"}, []]},
        {"cmd": "distribute", "args": ["$14", "40.00", f"{Y}-08-01", "@bank"]},
        {"cmd": "record_values", "args": ["$0", f"{Y}-06-30", [["$14", "3100.00"]]], "opts": {"note": " extrato "}},
        {"cmd": "record_values", "args": ["$0", f"{Y}-06-30", [["$14", "3150.00"]]]},
        {"cmd": "record_values", "args": ["$0", f"{Y}-06-30", [["$14", "3150.00"]]]},
        {"cmd": "record_values", "args": ["$0", f"{Y}-06-30", [["$14", "-1.00"]]]},
        {"cmd": "record_values", "args": ["$0", f"{Y}-06-30", [["$14", "1.001"]]]},
        {"cmd": "record_values", "args": ["$0", f"{Y}-06-30", [["@food", "1.00"]]]},
        {"cmd": "record_values", "args": ["$0", "2999-01-01", [["$14", "1.00"]]]},
        {"cmd": "adjust_balance", "args": ["@savings", f"{Y}-06-30", "300.00"]},
        {"cmd": "adjust_balance", "args": ["@savings", f"{Y}-06-30", "300.00"]},
        {"cmd": "adjust_balance", "args": ["@savings", f"{Y}-07-30", "250.50"]},
        {"cmd": "adjust_balance", "args": ["@loan", f"{Y}-07-30", "250.50"]},
        {
            "cmd": "create_position",
            "args": ["Tesouro IPCA", "treasury", f"{Y}-03-01"],
            "opts": {"initial_cost": "2000", "from_account": "@joint"},
        },
        {
            "cmd": "save_profile",
            "args": [
                {
                    "position_id": "$30",
                    "bank_account_id": "$7",
                    "indexer": "ipca",
                    "rate": "6.5",
                    "irpf_group": "04",
                    "irpf_code": "02",
                }
            ],
        },
        {"cmd": "save_profile", "args": [{"position_id": "$30", "indexer": "fixed", "rate": "12.4"}]},
        {"cmd": "save_profile", "args": [{"position_id": "$30", "indexer": "savings"}]},
    ]


def _random(seed: int) -> list[dict[str, Any]]:
    """A seeded year of income, expenses, classifications and payslips."""
    rng = random.Random(seed)
    commands: list[dict[str, Any]] = []
    incomes: list[str] = []
    accounts = ["@bank", "@joint", "@broker", "@savings", "@cash", "@nobody"]
    categories = ["@salary", "@rent", "@freelance", "@other_income", "@bonus"]
    members = ["@ana", "@bruno", "@carla", None]
    natures = ["taxable_pj", "carne_leao", "exempt", "exclusive", "ignored", None]

    def add(cmd: str, *args: Any, **opts: Any) -> str:
        commands.append({"cmd": cmd, "args": list(args), "opts": opts})
        return f"${len(commands) - 1}"

    for category in categories:
        add("classify", "category", category, rng.choice(natures))
    if rng.random() < 0.8:
        add("set_member_info", "@carla", CPF_CARLA, "2010-01-01", rng.choice(["@ana", "@bruno"]), "Filho(a)")
    for _ in range(60):
        on = date(Y - 1, 10, 1) + timedelta(days=rng.randint(0, 520))
        amount = str(Decimal(rng.randint(1_000, 900_000)) / 100)
        roll = rng.random()
        if roll < 0.7:
            incomes.append(
                add(
                    "income",
                    rng.choice(accounts),
                    rng.choice(categories),
                    amount,
                    on.isoformat(),
                    "R",
                    rng.choice(members),
                )
            )
        elif roll < 0.8 and incomes:
            gross = str(Decimal(rng.randint(1_000, 1_200_000)) / 100)
            add(
                "set_income_detail",
                rng.choice(incomes),
                rng.choice(["salary", "thirteenth", "other"]),
                gross,
                rng.choice([None, "12.34", "0.00"]),
                rng.choice([None, "45.60"]),
            )
        elif roll < 0.9:
            add("classify", "category", rng.choice(categories), rng.choice(natures))
        else:
            month = {"year": on.year, "month": on.month}
            add(
                "record_payment",
                rng.choice(["carne_leao", "variable_income"]),
                month,
                amount,
                on.isoformat(),
                rng.choice(accounts),
                rng.choice(members),
            )
    add(
        "set_parameters",
        {
            "year": Y,
            "brackets": [
                {"up_to": "3000.00", "rate": "0", "deduction": "0"},
                {"up_to": "9000.00", "rate": "0.1", "deduction": "300.00"},
                {"up_to": None, "rate": "0.25", "deduction": "1650.00"},
            ],
            "simplified_rate": "0.2",
            "simplified_cap": rng.choice(["1500.00", "99999.00"]),
            "dependent_deduction": rng.choice([None, "1800.00"]),
        },
    )
    return commands


def _resolve_keys(commands: list[dict[str, Any]], names: dict[str, str]) -> list[dict[str, Any]]:
    """Mark keys that embed a base id ("informe:conta:@bank") get the id itself."""
    out = []
    for c in commands:
        if c["cmd"] == "set_mark" and isinstance(c["args"][1], str) and "@" in c["args"][1]:
            prefix, _, name = c["args"][1].partition("@")
            c = {**c, "args": [c["args"][0], prefix + names[name], *c["args"][2:]]}
        out.append(c)
    return out


def scenario(name: str, commands: list[dict[str, Any]]) -> dict[str, Any]:
    ledger, names = base()
    known = known_ids(ledger)
    commands = _resolve_keys(commands, names)
    return {
        "name": name,
        "records": records_of(ledger),
        "names": names,
        "commands": commands,
        "results": run_commands(ledger, commands, names, TAX_COMMANDS, known),
        "snapshot": snapshot(ledger, known),
    }


def generate() -> dict[str, Any]:
    everything = _salary() + _carne_leao()
    return {
        "investment_codes": [list(c) for c in investment_codes()],
        "scenarios": [
            scenario("salary", _salary() + _salary_more()),
            scenario("carne-leão and identities", _carne_leao()),
            scenario("goods, filings and debts", _goods()),
            scenario("investments and renda variável", _investments()),
            scenario("bank accounts", _banking()),
            scenario("random 21", _random(21)),
            scenario("random 22", _random(22)),
            scenario("together", everything),
        ],
    }
