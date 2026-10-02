"""Read-only views over the ledger: balances, cash, competence and net worth (docs/04 §4-6).

The same facts produce every view; nothing here mutates the ledger.
"""

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


def balance(ledger: Ledger, account_id: UUID, at: date | None = None) -> Decimal:
    """Balance in the account's natural sign, by cash date, up to `at` inclusive."""
    account = ledger.account(account_id)
    total = ZERO
    for op in ledger.active_operations():
        when = op.cash_date or op.occurred_on
        if at is not None and (when is None or when > at):
            continue
        total += sum((p.amount for p in op.postings if p.account_id == account_id), ZERO)
    return total * _natural_sign(account)


def balances(ledger: Ledger, at: date | None = None) -> dict[UUID, Decimal]:
    totals: dict[UUID, Decimal] = defaultdict(lambda: ZERO)
    for op in ledger.active_operations():
        when = op.cash_date or op.occurred_on
        if at is not None and (when is None or when > at):
            continue
        for p in op.postings:
            totals[p.account_id] += p.amount
    return {aid: total * _natural_sign(ledger.account(aid)) for aid, total in totals.items()}


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
    for op in ledger.active_operations():
        when = op.cash_date
        if when is None or op.kind is OperationKind.OPENING_BALANCE:
            continue  # an opening balance is a starting point, not a flow
        month = YearMonth.of(when)
        if month not in months:
            continue
        inside = [p for p in op.postings if p.account_id in selected]
        if not inside:
            continue
        if all(p.account_id in selected for p in op.postings):
            continue  # internal transfer within the perimeter
        delta = sum((p.amount for p in inside), ZERO)
        if delta > 0:
            months[month].inflow += delta
        elif delta < 0:
            months[month].outflow += -delta
    return months


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
    for op in ledger.active_operations():
        if op.competence != month:
            continue
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
    for op in ledger.active_operations():
        comp = op.competence
        if comp is None or not (start <= comp <= end):
            continue
        for p in op.postings:
            if ledger.account(p.account_id).type is AccountType.EXPENSE:
                totals[p.account_id] += p.amount
    return dict(totals)
