"""Read-only views over the ledger: balances, cash, competence and net worth (docs/04 §4-6).

The same facts produce every view; nothing here mutates the ledger.
"""

from bisect import bisect_right
from collections import defaultdict
from collections.abc import Iterable
from dataclasses import dataclass, field
from datetime import date
from decimal import Decimal
from uuid import UUID

from opesvault.domain.ledger import Ledger
from opesvault.domain.model import AccountType, LedgerAccount, Operation, OperationKind, YearMonth
from opesvault.domain.money import ZERO


def _natural_sign(account: LedgerAccount) -> int:
    """Assets and expenses grow with debits; the others with credits."""
    return 1 if account.type in (AccountType.ASSET, AccountType.EXPENSE) else -1


class _Index:
    """Per-ledger lookup tables, rebuilt only when the ledger changes.

    Balances use prefix sums per account (bisect by date) and month views read
    pre-grouped operations, so charts over many months stay linear.
    """

    def __init__(self, ledger: Ledger) -> None:
        self.dates: dict[UUID, list[date]] = defaultdict(list)
        self.prefix: dict[UUID, list[Decimal]] = defaultdict(list)
        self.undated: dict[UUID, Decimal] = defaultdict(lambda: ZERO)
        self.by_competence: dict[YearMonth, list[Operation]] = defaultdict(list)
        self.by_cash_month: dict[YearMonth, list[Operation]] = defaultdict(list)
        dated: dict[UUID, list[tuple[date, Decimal]]] = defaultdict(list)
        for op in ledger.active_operations():
            when = op.cash_date or op.occurred_on
            for p in op.postings:
                if when is None:
                    self.undated[p.account_id] += p.amount
                else:
                    dated[p.account_id].append((when, p.amount))
            if op.competence is not None:
                self.by_competence[op.competence].append(op)
            if op.cash_date is not None:
                self.by_cash_month[YearMonth.of(op.cash_date)].append(op)
        for account_id, entries in dated.items():
            entries.sort(key=lambda e: e[0])
            running = ZERO
            for when, amount in entries:
                running += amount
                self.dates[account_id].append(when)
                self.prefix[account_id].append(running)

    def raw_balance(self, account_id: UUID, at: date | None) -> Decimal:
        prefix = self.prefix.get(account_id)
        if at is None:
            dated = prefix[-1] if prefix else ZERO
            return dated + self.undated.get(account_id, ZERO)
        if not prefix:
            return ZERO
        position = bisect_right(self.dates[account_id], at)
        return prefix[position - 1] if position else ZERO

    def accounts(self) -> set[UUID]:
        return set(self.prefix) | set(self.undated)


def index(ledger: Ledger) -> _Index:
    cached = getattr(ledger, "_query_index", None)
    if cached is not None and cached[0] == ledger.change_count:
        return cached[1]
    built = _Index(ledger)
    ledger._query_index = (ledger.change_count, built)  # type: ignore[attr-defined]
    return built


def balance(ledger: Ledger, account_id: UUID, at: date | None = None) -> Decimal:
    """Balance in the account's natural sign, by cash date, up to `at` inclusive.

    Operations without any date count only in the undated (overall) balance.
    """
    account = ledger.account(account_id)
    return index(ledger).raw_balance(account_id, at) * _natural_sign(account)


def balances(ledger: Ledger, at: date | None = None) -> dict[UUID, Decimal]:
    idx = index(ledger)
    out = {}
    for aid in idx.accounts():
        raw = idx.raw_balance(aid, at)
        if raw != 0 or at is None or (idx.dates.get(aid) and idx.dates[aid][0] <= at):
            out[aid] = raw * _natural_sign(ledger.account(aid))
    return out


@dataclass
class NetWorth:
    assets: Decimal = ZERO
    liabilities: Decimal = ZERO
    by_account: dict[UUID, Decimal] = field(default_factory=dict)

    @property
    def net(self) -> Decimal:
        return self.assets - self.liabilities


def net_worth(ledger: Ledger, at: date | None = None) -> NetWorth:
    """Joint accounts enter once: the family is one perimeter (docs/04 §6)."""
    result = NetWorth()
    for aid, value in balances(ledger, at).items():
        account = ledger.account(aid)
        if account.type is AccountType.ASSET:
            result.assets += value
        elif account.type is AccountType.LIABILITY:
            result.liabilities += value
        else:
            continue
        result.by_account[aid] = value
    return result


@dataclass
class MonthFlow:
    inflow: Decimal = ZERO
    outflow: Decimal = ZERO

    @property
    def net(self) -> Decimal:
        return self.inflow - self.outflow


def is_internal(ledger: Ledger, op: Operation, perimeter: set[UUID] | None = None) -> bool:
    """Internal when money only moves between balance-sheet accounts inside the perimeter."""
    for p in op.postings:
        account = ledger.account(p.account_id)
        if not account.is_balance_sheet or account.type is AccountType.EQUITY:
            return False
        if perimeter is not None and p.account_id not in perimeter:
            return False
    return True


def cash_flow(
    ledger: Ledger, start: YearMonth, end: YearMonth, accounts: Iterable[UUID] | None = None
) -> dict[YearMonth, MonthFlow]:
    """Inflows/outflows of liquid accounts by cash date.

    Transfers among the selected liquid accounts are excluded (they are internal
    to the consolidated view). Paying a card bill is a real cash outflow; the
    purchase itself never touched cash.
    """
    selected = set(accounts) if accounts is not None else {a.id for a in ledger.accounts.values() if a.is_liquid}
    months: dict[YearMonth, MonthFlow] = {}
    cursor = start
    while cursor <= end:
        months[cursor] = MonthFlow()
        cursor = cursor.add(1)
    idx = index(ledger)
    for month in list(months):
        for op in idx.by_cash_month.get(month, ()):
            _add_flow(months[month], op, selected)
    return months


def _add_flow(flow: "MonthFlow", op: Operation, selected: set[UUID]) -> None:
    if op.kind is OperationKind.OPENING_BALANCE:
        return  # an opening balance is a starting point, not a flow
    inside = [p for p in op.postings if p.account_id in selected]
    if not inside:
        return
    if all(p.account_id in selected for p in op.postings):
        return  # internal transfer within the perimeter
    delta = sum((p.amount for p in inside), ZERO)
    if delta > 0:
        flow.inflow += delta
    elif delta < 0:
        flow.outflow += -delta


@dataclass
class Statement:
    income: dict[UUID, Decimal] = field(default_factory=lambda: defaultdict(lambda: ZERO))
    expense: dict[UUID, Decimal] = field(default_factory=lambda: defaultdict(lambda: ZERO))

    @property
    def total_income(self) -> Decimal:
        return sum(self.income.values(), ZERO)

    @property
    def total_expense(self) -> Decimal:
        return sum(self.expense.values(), ZERO)

    @property
    def result(self) -> Decimal:
        return self.total_income - self.total_expense


def income_statement(ledger: Ledger, month: YearMonth, member_id: UUID | None = None) -> Statement:
    """Revenues and expenses by competence. With `member_id`, only that member's rateio shares."""
    statement = Statement()
    for op in index(ledger).by_competence.get(month, ()):
        for p in op.postings:
            account = ledger.account(p.account_id)
            if member_id is not None and (p.member_id or op.member_id) != member_id:
                continue
            if account.type is AccountType.INCOME:
                statement.income[account.id] += -p.amount
            elif account.type is AccountType.EXPENSE:
                statement.expense[account.id] += p.amount
    return statement


def expenses_by_category(ledger: Ledger, start: YearMonth, end: YearMonth) -> dict[UUID, Decimal]:
    totals: dict[UUID, Decimal] = defaultdict(lambda: ZERO)
    idx = index(ledger)
    for comp, ops in idx.by_competence.items():
        if not (start <= comp <= end):
            continue
        for op in ops:
            for p in op.postings:
                if ledger.account(p.account_id).type is AccountType.EXPENSE:
                    totals[p.account_id] += p.amount
    return dict(totals)
