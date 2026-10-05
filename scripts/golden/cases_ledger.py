"""domain/ledger.py, queries.py, search.py and edits.py over a seeded random ledger.

The TS side loads the dumped records, recomputes every query and replays the commands; ids
come from the records, so nothing depends on random ids.
"""

import random
from datetime import date, timedelta
from decimal import Decimal
from typing import Any
from uuid import UUID

from opesvault.domain import edits, queries
from opesvault.domain.ledger import DomainError, Ledger
from opesvault.domain.model import AccountSubtype, AccountType, Card, LedgerAccount, OriginKind, YearMonth
from opesvault.domain.search import OperationFilter, StatusFilter, find_operations
from scripts.golden.common import j

START = date(2025, 11, 1)


def _money(rng: random.Random, low: int = 100, high: int = 500_000) -> str:
    return str(Decimal(rng.randint(low, high)) / 100)


def build(seed: int) -> tuple[Ledger, dict[str, Any]]:
    rng = random.Random(seed)
    ledger = Ledger.new("Projeto Golden")
    ana = ledger.add_member("Ana").id
    bruno = ledger.add_member("Bruno").id
    acc = {
        "bank": ledger.add_account(
            LedgerAccount(name="Banco A", type=AccountType.ASSET, subtype=AccountSubtype.CHECKING, holders=(ana,))
        ).id,
        "savings": ledger.add_account(
            LedgerAccount(name="Poupança", type=AccountType.ASSET, subtype=AccountSubtype.SAVINGS, holders=(ana,))
        ).id,
        "joint": ledger.add_account(
            LedgerAccount(
                name="Conjunta", type=AccountType.ASSET, subtype=AccountSubtype.CHECKING, holders=(ana, bruno)
            )
        ).id,
        "cash": ledger.add_account(
            LedgerAccount(name="Carteira", type=AccountType.ASSET, subtype=AccountSubtype.CASH)
        ).id,
        "card_account": ledger.add_account(
            LedgerAccount(name="Cartão X", type=AccountType.LIABILITY, subtype=AccountSubtype.CREDIT_CARD)
        ).id,
        "loan": ledger.add_account(
            LedgerAccount(name="Empréstimo", type=AccountType.LIABILITY, subtype=AccountSubtype.LOAN)
        ).id,
    }
    card = ledger.add_card(
        Card(
            name="Cartão X",
            liability_account_id=acc["card_account"],
            holder_id=ana,
            last4="1234",
            closing_day=3,
            due_day=10,
            settlement_account_id=acc["bank"],
        )
    ).id
    parent = ledger.add_account(LedgerAccount(name="Casa", type=AccountType.EXPENSE, subtype=AccountSubtype.CATEGORY))
    ledger.add_account(
        LedgerAccount(
            name="Casa — reparos", type=AccountType.EXPENSE, subtype=AccountSubtype.CATEGORY, parent_id=parent.id
        )
    )
    expenses = [a.id for a in ledger.categories(AccountType.EXPENSE)]
    incomes = [a.id for a in ledger.categories(AccountType.INCOME)]
    liquid = [acc["bank"], acc["savings"], acc["joint"], acc["cash"]]
    ledger.record_opening_balance(acc["bank"], "8450.00", START)
    ledger.record_opening_balance(acc["joint"], "2300.00", START)
    ledger.record_opening_balance(acc["loan"], "15000.00", START)
    words = ["Mercado", "Farmácia", "Posto", "Restaurante", "Padaria", "Aluguel", "Escola", "Luz", "Água", "Cinema"]
    created = []
    for _ in range(260):
        on = START + timedelta(days=rng.randint(0, 150))
        roll = rng.random()
        desc = f"{rng.choice(words)} {rng.randint(1, 99)}"
        try:
            if roll < 0.35:
                op = ledger.record_expense(rng.choice(liquid), rng.choice(expenses), _money(rng), on, desc)
            elif roll < 0.45:
                cats = rng.sample(expenses, 2)
                a, b = _money(rng), _money(rng)
                op = ledger.record_expense(rng.choice(liquid), [(cats[0], a), (cats[1], b)], None, on, desc)
            elif roll < 0.55:
                extra = {}
                if rng.random() < 0.4:
                    extra["accrual_month"] = YearMonth.of(on).add(-1)
                op = ledger.record_income(
                    rng.choice(liquid), rng.choice(incomes), _money(rng, 100_000, 900_000), on, desc, **extra
                )
            elif roll < 0.65:
                src, dst = rng.sample(liquid, 2)
                op = ledger.record_transfer(src, dst, _money(rng), on)
            elif roll < 0.85:
                op = ledger.record_card_purchase(
                    card, rng.choice(expenses), _money(rng), on, desc, cardholder_id=rng.choice([None, bruno])
                )
            else:
                op = ledger.record_card_payment(card, acc["bank"], _money(rng), on)
            created.append(op.id)
        except DomainError:
            pass
    # corrections, cancellations and reversals keep history
    for op_id in rng.sample(created, 15):
        op = ledger.operations[op_id]
        ledger.update_operation(op.model_copy(update={"description": op.description + " (corrigido)"}), "ajuste")
    for op_id in rng.sample(created, 8):
        if ledger.operations[op_id].active:
            ledger.cancel_operation(op_id, "duplicado")
    for op_id in rng.sample(created, 8):
        if ledger.operations[op_id].active:
            ledger.reverse_operation(op_id, START + timedelta(days=160), "devolvido")
    names = {"ana": ana, "bruno": bruno, "card": card, **acc, "expenses": expenses, "incomes": incomes}
    return ledger, names


def _queries(ledger: Ledger, names: dict[str, Any]) -> dict[str, Any]:
    dates = [None, START, START + timedelta(days=30), START + timedelta(days=75), START + timedelta(days=200)]
    months = [YearMonth.of(START).add(i) for i in range(-1, 7)]
    first, last = months[0], months[-1]
    out: dict[str, Any] = {}
    out["balances"] = [{"at": j(d), "values": j(queries.balances(ledger, d))} for d in dates]
    out["balance"] = [
        {"at": j(d), "account": str(a), "value": j(queries.balance(ledger, a, d))}
        for d in dates
        for a in (names["bank"], names["card_account"], names["loan"], names["joint"])
    ]
    out["net_worth"] = [
        {
            "at": j(d),
            "assets": j(nw.assets),
            "liabilities": j(nw.liabilities),
            "net": j(nw.net),
            "by_account": j(nw.by_account),
        }
        for d in dates
        for nw in [queries.net_worth(ledger, d)]
    ]
    flows = queries.cash_flow(ledger, first, last)
    out["cash_flow"] = {str(m): {"in": j(f.inflow), "out": j(f.outflow), "net": j(f.net)} for m, f in flows.items()}
    only = queries.cash_flow(ledger, first, last, accounts=[names["bank"]])
    out["cash_flow_bank"] = {str(m): {"in": j(f.inflow), "out": j(f.outflow)} for m, f in only.items()}
    out["statements"] = []
    for m in months:
        for member in (None, names["ana"], names["bruno"]):
            s = queries.income_statement(ledger, m, member)
            out["statements"].append(
                {
                    "month": str(m),
                    "member": j(member),
                    "income": j(dict(s.income)),
                    "expense": j(dict(s.expense)),
                    "total_income": j(s.total_income),
                    "total_expense": j(s.total_expense),
                    "result": j(s.result),
                }
            )
    out["by_category"] = j(queries.expenses_by_category(ledger, first, last))
    filters = [
        OperationFilter(),
        OperationFilter(start=START + timedelta(days=20), end=START + timedelta(days=60)),
        OperationFilter(account_id=names["bank"], status=StatusFilter.ACTIVE),
        OperationFilter(member_id=names["bruno"]),
        OperationFilter(text="  MERCADO "),
        OperationFilter(text="corrigido", status=StatusFilter.CANCELLED),
        OperationFilter(origin=OriginKind.MANUAL, status=StatusFilter.ACTIVE, account_id=names["card_account"]),
    ]
    out["search"] = [
        {
            "filter": {
                "start": j(f.start),
                "end": j(f.end),
                "account_id": j(f.account_id),
                "member_id": j(f.member_id),
                "text": f.text,
                "status": f.status.value,
                "origin": j(f.origin),
            },
            "ids": [str(o.id) for o in find_operations(ledger, f)],
        }
        for f in filters
    ]
    return out


def _commands(names: dict[str, Any]) -> list[dict[str, Any]]:
    """Commands replayed in order on the loaded ledger; each expects ok or a DomainError message."""
    s = str
    on = "2026-02-15"
    e0, e1 = s(names["expenses"][0]), s(names["expenses"][1])
    return [
        {"cmd": "expense", "args": [s(names["bank"]), e0, "10.001", on, "x"]},
        {"cmd": "expense", "args": [s(names["bank"]), "00000000-0000-4000-8000-000000000000", "10", on, "x"]},
        {"cmd": "expense", "args": [s(names["bank"]), e0, "-5", on, "x"]},
        {"cmd": "expense_split", "args": [s(names["bank"]), [[e0, "10"], [e1, "5"]], "20", on, "x"]},
        {"cmd": "expense_split", "args": [s(names["bank"]), [[e0, "10"], [e1, "5"]], "15", on, "rateio"]},
        {"cmd": "expense", "args": [s(names["card_account"]), e0, "10", on, "x"]},
        {"cmd": "transfer", "args": [s(names["bank"]), s(names["bank"]), "10", on]},
        {"cmd": "transfer", "args": [s(names["bank"]), s(names["savings"]), "0", on]},
        {"cmd": "transfer", "args": [s(names["bank"]), s(names["loan"]), "100.00", on]},
        {"cmd": "income", "args": [s(names["bank"]), e0, "10", on, "x"]},
        {"cmd": "income", "args": [s(names["bank"]), s(names["incomes"][0]), "1000.50", on, "bônus"]},
        {"cmd": "card_purchase", "args": [s(names["card"]), e1, "99.99", on, "Loja"]},
        {"cmd": "card_purchase", "args": ["00000000-0000-4000-8000-000000000001", e1, "99.99", on, "Loja"]},
        {"cmd": "card_payment", "args": [s(names["card"]), s(names["card_account"]), "10", on]},
        {"cmd": "card_payment", "args": [s(names["card"]), s(names["bank"]), "250.00", on]},
        {"cmd": "opening", "args": [e0, "10", on]},
        {"cmd": "opening", "args": [s(names["cash"]), "50.00", on]},
        {"cmd": "member", "args": ["ana"]},
        {"cmd": "member", "args": ["  Carla "]},
        {"cmd": "reclassify", "args": ["first_active_expenses", e1, "mudança"]},
        {"cmd": "reclassify", "args": ["first_active_expenses", e1, " "]},
        {"cmd": "reclassify", "args": ["first_active_expenses", s(names["bank"]), "x"]},
        {"cmd": "cancel", "args": ["last", " "]},
        {"cmd": "cancel", "args": ["last", "erro"]},
        {"cmd": "cancel", "args": ["last", "erro"]},
        {"cmd": "reverse", "args": ["first_active", "2026-03-01", ""]},
        {"cmd": "reverse", "args": ["first_active", "2026-03-01", "devolução"]},
    ]


def run_commands(ledger: Ledger, commands: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Ids picked by rule come only from the loaded records: ids created here are random."""
    original = set(ledger.operations)
    results = []
    last: UUID | None = None
    for c in commands:
        a = c["args"]
        try:
            match c["cmd"]:
                case "expense":
                    op = ledger.record_expense(UUID(a[0]), UUID(a[1]), a[2], date.fromisoformat(a[3]), a[4])
                case "expense_split":
                    op = ledger.record_expense(
                        UUID(a[0]), [(UUID(x), v) for x, v in a[1]], a[2], date.fromisoformat(a[3]), a[4]
                    )
                case "transfer":
                    op = ledger.record_transfer(UUID(a[0]), UUID(a[1]), a[2], date.fromisoformat(a[3]))
                case "income":
                    op = ledger.record_income(UUID(a[0]), UUID(a[1]), a[2], date.fromisoformat(a[3]), a[4])
                case "card_purchase":
                    op = ledger.record_card_purchase(UUID(a[0]), UUID(a[1]), a[2], date.fromisoformat(a[3]), a[4])
                case "card_payment":
                    op = ledger.record_card_payment(UUID(a[0]), UUID(a[1]), a[2], date.fromisoformat(a[3]))
                case "opening":
                    op = ledger.record_opening_balance(UUID(a[0]), a[1], date.fromisoformat(a[2]))
                case "member":
                    member = ledger.add_member(a[0])
                    results.append({"ok": {"name": member.name, "role": member.role.value, "active": member.active}})
                    continue
                case "reclassify":
                    ids = sorted(
                        (
                            o.id
                            for o in ledger.operations.values()
                            if o.active and o.kind.value == "expense" and o.id in original
                        ),
                        key=lambda i: i.int,
                    )[:12]
                    r = edits.reclassify(ledger, ids, UUID(a[1]), a[2])
                    results.append({"ok": {"changed": r.changed, "skipped": r.skipped, "errors": list(r.errors)}})
                    continue
                case "cancel":
                    assert last is not None
                    op = ledger.cancel_operation(last, a[1])
                case "reverse":
                    target = min(
                        (o.id for o in ledger.operations.values() if o.active and o.id in original), key=lambda i: i.int
                    )
                    op = ledger.reverse_operation(target, date.fromisoformat(a[1]), a[2])
                case _:
                    raise AssertionError(c["cmd"])
            last = op.id
            payload = op.model_dump(mode="json")
            payload.pop("id")
            results.append({"ok": payload})
        except DomainError as exc:
            results.append({"error": str(exc)})
    return results


def generate() -> dict[str, Any]:
    scenarios = []
    for seed in (1, 2):
        ledger, names = build(seed)
        records = [{"id": str(i), "kind": k, "payload": p} for i, k, p in ledger.to_records()]
        commands = _commands(names)
        after = Ledger.from_records(ledger.to_records())
        scenarios.append(
            {
                "seed": seed,
                "records": records,
                "queries": _queries(ledger, names),
                "commands": commands,
                "results": run_commands(after, commands),
                "row_counts": after.row_counts(),
            }
        )
    return {"scenarios": scenarios}
