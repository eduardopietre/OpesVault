"""Subscriptions and fixed bills: what they cost per year and when their price changed
(docs/09 §1.3 E).

Registered recurrences give the yearly cost; the operations linked to them show the
price actually charged. Charges that repeat month after month with the same description
and no recurrence are offered as candidates: the user decides whether to register them.
"""

from collections import defaultdict
from dataclasses import dataclass
from datetime import date
from decimal import Decimal
from itertools import pairwise
from statistics import median
from uuid import UUID

from opesvault.domain.ledger import Ledger
from opesvault.domain.model import AccountType, Operation, OperationKind, YearMonth
from opesvault.domain.money import ZERO, round_money
from opesvault.domain.recurrence import ForecastDecision, Frequency, RecurrenceRule, links, rules

PER_YEAR = {Frequency.MONTHLY: 12, Frequency.WEEKLY: 52, Frequency.YEARLY: 1}
CANDIDATE_MONTHS = 3  # months in a row with the same charge before suggesting it
CANDIDATE_SPREAD = Decimal("0.15")  # charges may vary 15% around the typical value


@dataclass(frozen=True)
class Commitment:
    rule: RecurrenceRule
    per_year: Decimal
    last_paid: Decimal | None  # the latest realized value, or None when never linked
    last_paid_on: date | None
    previous_paid: Decimal | None

    @property
    def price_changed(self) -> bool:
        """The latest charge differs from the expected value (beyond the tolerance) or from the one before."""
        if self.last_paid is None:
            return False
        if abs(self.last_paid - self.rule.amount) > self.rule.tolerance:
            return True
        return self.previous_paid is not None and self.previous_paid != self.last_paid


def _paid_value(ledger: Ledger, rule: RecurrenceRule, op: Operation) -> Decimal:
    value = sum((p.amount for p in op.postings if p.account_id == rule.counterpart_id), ZERO)
    return abs(value)


def commitments(ledger: Ledger) -> list[Commitment]:
    """Active expense recurrences, most expensive per year first."""
    paid: dict[UUID, list[tuple[date, Decimal]]] = defaultdict(list)
    all_rules = rules(ledger)
    for link in links(ledger).values():
        if link.decision is not ForecastDecision.REALIZED or link.operation_id is None:
            continue
        rule = all_rules.get(link.rule_id)
        op = ledger.operations.get(link.operation_id)
        if rule is None or op is None or not op.active:
            continue
        paid[rule.id].append((link.due_on, _paid_value(ledger, rule, op)))
    out = []
    for rule in all_rules.values():
        counterpart = ledger.accounts.get(rule.counterpart_id)
        if rule.paused or counterpart is None or counterpart.type is not AccountType.EXPENSE:
            continue
        history = sorted(paid.get(rule.id, []))
        last = history[-1] if history else None
        previous = history[-2] if len(history) > 1 else None
        out.append(
            Commitment(
                rule,
                rule.amount * PER_YEAR[rule.frequency],
                last[1] if last else None,
                last[0] if last else None,
                previous[1] if previous else None,
            )
        )
    return sorted(out, key=lambda c: c.per_year, reverse=True)


def yearly_total(ledger: Ledger) -> Decimal:
    return sum((c.per_year for c in commitments(ledger)), ZERO)


@dataclass(frozen=True)
class Candidate:
    description: str  # as it appears in the latest charge
    amount: Decimal  # the latest charge
    day: int
    account_id: UUID  # bank account or card liability it is charged to
    category_id: UUID
    months: int  # consecutive months found
    last_on: date


def _expense(ledger: Ledger, op: Operation) -> tuple[UUID, UUID, Decimal] | None:
    """(charged account, category, value) for a single-category expense or card purchase."""
    if op.kind not in (OperationKind.EXPENSE, OperationKind.CARD_PURCHASE) or op.installment is not None:
        return None
    categories = [p for p in op.postings if ledger.account(p.account_id).type is AccountType.EXPENSE]
    sources = [p for p in op.postings if p.amount < 0]
    if len(categories) != 1 or len(sources) != 1:
        return None
    return sources[0].account_id, categories[0].account_id, categories[0].amount


def candidates(ledger: Ledger, today: date | None = None) -> list[Candidate]:
    """Charges that look recurring (same description, similar value, consecutive months) and have no recurrence."""
    from opesvault.importing.rules import normalize

    today = today or date.today()
    oldest = YearMonth.of(today).add(-12)
    groups: dict[str, list[tuple[date, Operation, tuple[UUID, UUID, Decimal]]]] = defaultdict(list)
    for op in ledger.active_operations():
        when = op.occurred_on or op.cash_date
        if when is None or YearMonth.of(when) < oldest or when > today or op.forecast_id is not None:
            continue
        found = _expense(ledger, op)
        if found is not None:
            groups[normalize(op.description)].append((when, op, found))
    registered = {normalize(r.description) for r in rules(ledger).values()}
    out = []
    for key, entries in groups.items():
        if not key or key in registered or any(key in r or r in key for r in registered if r):
            continue
        entries.sort(key=lambda e: e[0])
        months = [YearMonth(year=y, month=m) for y, m in sorted({(e[0].year, e[0].month) for e in entries})]
        run = best = 1
        for previous, current in pairwise(months):
            run = run + 1 if previous.add(1) == current else 1
            best = max(best, run)
        if best < CANDIDATE_MONTHS or months[-1] < YearMonth.of(today).add(-1):
            continue  # not repeating, or stopped
        values = [e[2][2] for e in entries]
        typical = Decimal(str(median(values)))
        if any(abs(v - typical) > typical * CANDIDATE_SPREAD for v in values[-CANDIDATE_MONTHS:]):
            continue
        last_on, last_op, (account_id, category_id, value) = entries[-1]
        days = [e[0].day for e in entries[-CANDIDATE_MONTHS:]]
        out.append(
            Candidate(
                last_op.description, round_money(value), int(median(days)), account_id, category_id, best, last_on
            )
        )
    return sorted(out, key=lambda c: c.amount, reverse=True)
