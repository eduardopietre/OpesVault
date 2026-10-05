"""domain/onboarding.py: first-use setup plans applied to fresh ledgers (docs/18 §4, phase W4).

Ids are random in a fresh ledger, so the result is described by names: accounts, cards and
opening balances as the setup left them, or the DomainError message (and no change at all).
"""

from datetime import date
from decimal import Decimal
from typing import Any

from opesvault.domain import queries
from opesvault.domain.ledger import DomainError, Ledger
from opesvault.domain.model import AccountSubtype
from opesvault.domain.onboarding import AccountPlan, CardPlan, SetupPlan, apply_setup

JAN = date(2026, 1, 1)


def _plans() -> list[dict[str, Any]]:
    """Plans as JSON: the TS test builds the same plans from these."""
    base = {
        "members": ["Ana", "Bruno"],
        "accounts": [
            ["Banco A", "checking", ["Ana"], "Banco", "1500.00", "2026-01-01"],
            ["Conjunta", "checking", ["Ana", "bruno"], "  ", None, None],
            ["Financiamento", "loan", [], None, "90000.00", "2026-01-01"],
            ["Carteira", "cash", [], None, "0", "2026-01-01"],
            ["Corretora", "brokerage_cash", ["Bruno"], " XP ", "-10.50", "2025-12-31"],
        ],
        "cards": [
            ["Cartão Ana", "Ana", "1234", 3, 10, "Banco A", None],
            ["Cartão B", "bruno", "0001", 31, 31, None, "Nu"],
        ],
    }

    def change(**kw: Any) -> dict[str, Any]:
        return {**base, **kw}

    return [
        {"existing": [], "plan": base},
        {"existing": ["Carla"], "plan": change(members=["Ana"], accounts=[["X", "savings", ["carla", "ANA"]]])},
        {"existing": [], "plan": {"members": [], "accounts": [], "cards": []}},
        {"existing": [], "plan": change(members=["Ana", "ana"])},
        {"existing": [], "plan": change(members=["Ana", " "])},
        {"existing": ["Ana"], "plan": change(members=["ANA"])},
        {"existing": [], "plan": change(accounts=[["X", "checking", ["Carla"]]])},
        {"existing": [], "plan": change(accounts=[["X", "checking", [], None, "1", None]])},
        {"existing": [], "plan": change(accounts=[["X", "checking"], ["x", "savings"]])},
        {"existing": [], "plan": change(accounts=[["  ", "checking"]])},
        {"existing": [], "plan": change(accounts=[["X", "credit_card"]])},
        {"existing": [], "plan": change(accounts=[["Alimentação", "checking"]])},
        {"existing": [], "plan": change(cards=[["C", "Ana", "12a4", 3, 10]])},
        {"existing": [], "plan": change(cards=[["C", "Ana", "123", 3, 10]])},
        {"existing": [], "plan": change(cards=[["C", "Ana", "1234", 0, 10]])},
        {"existing": [], "plan": change(cards=[["C", "Ana", "1234", 3, 32]])},
        {"existing": [], "plan": change(cards=[["C", "Zé", "1234", 3, 10]])},
        {"existing": [], "plan": change(cards=[["C", "Ana", "1234", 3, 10, "Inexistente"]])},
        {"existing": [], "plan": change(cards=[["C", "Ana", "1234", 3, 10, "Financiamento"]])},
        {"existing": [], "plan": change(cards=[["Banco A", "Ana", "1234", 3, 10]])},
        {"existing": [], "plan": change(cards=[[" ", "Ana", "1234", 3, 10]])},
        {"existing": [], "plan": change(cards=[["C", "Ana", "1234", 3, 10, "Patrimônio de abertura"]])},
        {"existing": [], "plan": change(cards=[["C", "Ana", "1234", 3, 10, "carteira"]])},
    ]


def _account(row: list[Any]) -> AccountPlan:
    name, subtype, *rest = row
    holders = tuple(rest[0]) if len(rest) > 0 else ()
    institution = rest[1] if len(rest) > 1 else None
    balance = Decimal(rest[2]) if len(rest) > 2 and rest[2] is not None else None
    on = date.fromisoformat(rest[3]) if len(rest) > 3 and rest[3] is not None else None
    return AccountPlan(name, AccountSubtype(subtype), holders, institution, balance, on)


def _card(row: list[Any]) -> CardPlan:
    name, holder, last4, closing, due, *rest = row
    return CardPlan(name, holder, last4, closing, due, rest[0] if rest else None, rest[1] if len(rest) > 1 else None)


def describe(ledger: Ledger) -> dict[str, Any]:
    members = {m.id: m.name for m in ledger.members.values()}
    accounts = {a.id: a.name for a in ledger.accounts.values()}
    return {
        "accounts": [
            {
                "name": a.name,
                "type": a.type.value,
                "subtype": a.subtype.value,
                "institution": a.institution,
                "masked_number": a.masked_number,
                "holders": [members[h] for h in a.holders],
                "balance": format(queries.balance(ledger, a.id), "f"),
            }
            for a in ledger.accounts.values()
        ],
        "cards": [
            {
                "name": c.name,
                "liability": accounts[c.liability_account_id],
                "holder": members[c.holder_id],
                "last4": c.last4,
                "closing_day": c.closing_day,
                "due_day": c.due_day,
                "settlement": accounts[c.settlement_account_id] if c.settlement_account_id else None,
            }
            for c in ledger.cards.values()
        ],
        "operations": [
            {
                "kind": o.kind.value,
                "description": o.description,
                "occurred_on": str(o.occurred_on),
                "postings": [[accounts[p.account_id], format(p.amount, "f")] for p in o.postings],
            }
            for o in ledger.operations.values()
        ],
        "members": [[m.name, m.role.value] for m in ledger.members.values()],
        "history": len(ledger.history),
    }


def generate() -> dict[str, Any]:
    cases = []
    for case in _plans():
        ledger = Ledger.new("Projeto")
        for name in case["existing"]:
            ledger.add_member(name)
        before = ledger.change_count
        p = case["plan"]
        plan = SetupPlan(
            members=tuple(p["members"]),
            accounts=tuple(_account(r) for r in p["accounts"]),
            cards=tuple(_card(r) for r in p["cards"]),
        )
        try:
            r = apply_setup(ledger, plan)
            result: dict[str, Any] = {
                "ok": [r.members, r.accounts, r.cards, r.opening_balances],
                "state": describe(ledger),
            }
        except DomainError as exc:
            result = {"error": str(exc), "unchanged": ledger.change_count == before}
        cases.append({**case, "result": result})
    return {"cases": cases}
