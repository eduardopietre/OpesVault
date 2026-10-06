"""tests/demo_vault.py: the demo project, record by record, and the figures its queries give.

The TS `demoSession(today)` must build the same project: every persisted row (ids renamed by
first appearance, instants as "<instant>"), the stored document, and a set of summary queries
(balances by account name, statements by month, budget, net worth, tags, merchants, investments).
`today` is recorded: two expenses and the budget of the current month use it.
"""

import json
import re
from datetime import date
from pathlib import Path
from typing import Any
from uuid import UUID

from opesvault.domain import budget, merchants, queries, tags
from opesvault.domain.model import AccountType, YearMonth
from opesvault.investments import performance, service
from scripts.golden.common import j
from tests.demo_vault import demo_session

UUID_TEXT = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")
INSTANT = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}")


class Renamer:
    """Ids become "#<n>" in order of first appearance; keys are visited sorted so key order never matters."""

    def __init__(self) -> None:
        self.seen: dict[str, str] = {}

    def name(self, text: str) -> str:
        if INSTANT.match(text):
            return "<instant>"
        return UUID_TEXT.sub(lambda m: self.seen.setdefault(m.group(), f"#{len(self.seen)}"), text)

    def value(self, v: Any) -> Any:
        if isinstance(v, str):
            return self.name(v)
        if isinstance(v, list):
            return [self.value(x) for x in v]
        if isinstance(v, dict):
            # pdf.js and pdfplumber agree on boxes to ~1e-13 pt: compare them rounded, as the import golden does
            return {k: ([round(x, 6) for x in v[k]] if k == "bbox" and v[k] else self.value(v[k])) for k in sorted(v)}
        return v


def rows(ledger: Any, renamer: Renamer) -> list[Any]:
    out = []
    for eid, kind, payload in sorted(ledger.to_records(), key=lambda r: r[1]):  # kinds sorted; stable within a kind
        out.append({"kind": kind, "id": renamer.name(str(eid)), "payload": renamer.value(payload)})
    return out


def summary(session: Any, today: date) -> dict[str, Any]:
    ledger = session.ledger
    names = {a.id: a.name for a in ledger.accounts.values()}

    def by_name(values: dict[UUID, Any]) -> dict[str, Any]:
        return {names[k]: j(v) for k, v in values.items()}

    months = [YearMonth(year=2026, month=m) for m in (1, 2, 3)] + [YearMonth.of(today)]
    statements = {}
    for m in months:
        s = queries.income_statement(ledger, m)
        statements[str(m)] = {
            "income": by_name(s.income),
            "expense": by_name(s.expense),
            "total_income": j(s.total_income),
            "total_expense": j(s.total_expense),
            "result": j(s.result),
        }
    worth = queries.net_worth(ledger)
    status = budget.status(ledger, YearMonth(year=2026, month=3))
    current = budget.status(ledger, YearMonth.of(today))
    positions = []
    for pos in service.positions(ledger).values():
        positions.append(
            {
                "name": service.assets(ledger)[pos.asset_id].name,
                "remaining_cost": j(service.remaining_cost(ledger, pos.id)),
                "unrealized": j(performance.unrealized(ledger, pos.id, date(2026, 3, 31))),
                "value": j(
                    performance.value_at(ledger, pos.id, date(2026, 3, 31))
                    and performance.value_at(ledger, pos.id, date(2026, 3, 31)).valuation.value  # type: ignore[union-attr]
                ),
            }
        )
    return {
        "balances": [[a.name, j(queries.balance(ledger, a.id))] for a in ledger.accounts.values()],
        "balances_at_march": by_name(queries.balances(ledger, date(2026, 3, 31))),
        "net_worth": {"assets": j(worth.assets), "liabilities": j(worth.liabilities), "net": j(worth.net)},
        "statements": statements,
        "expenses_by_category": by_name(queries.expenses_by_category(ledger, months[0], months[2])),
        "budget": [
            {
                "month": str(s.month),
                "rows": [[r.name, j(r.planned), j(r.actual), j(r.remaining), r.state.value, j(r.used)] for r in s.rows],
                "planned": j(s.total_planned),
                "actual": j(s.total_actual),
                "unbudgeted": j(s.unbudgeted),
            }
            for s in (status, current)
        ],
        "tags": [[s.tag, len(s.operations), j(s.expense)] for s in tags.summaries(ledger)],
        "merchants": [
            [m.name, j(m.expense), m.count, m.approved] for m in merchants.totals(ledger, date(2026, 1, 1), today)
        ],
        "positions": positions,
        "categories": {
            kind.value: sorted(a.name for a in ledger.categories(kind))
            for kind in (AccountType.EXPENSE, AccountType.INCOME)
        },
        "row_counts": ledger.row_counts(),
        "members": [[m.name, m.role.value, m.active] for m in ledger.members.values()],
        "meta": {"family_name": ledger.meta.family_name},
        "documents": [[d.meta.original_name, d.meta.sha256, d.meta.size] for d in session.documents],
        "operations": len(ledger.operations),
    }


def generate() -> dict[str, Any]:
    today = date.today()
    session = demo_session(Path("/nonexistent/demo.opesvault"))
    renamer = Renamer()
    return {
        "today": today.isoformat(),
        "records": rows(session.ledger, renamer),
        "summary": json.loads(json.dumps(summary(session, today), default=str)),
    }
