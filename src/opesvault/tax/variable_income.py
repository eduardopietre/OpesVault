"""Month by month result of stock, ETF and real estate fund sales (renda variável).

Rates and the monthly exemption limit come from the user (`VariableIncomeRules`); without a
rate the tax stays unknown, never zero. What the app does on its own is arithmetic over the
recorded trades: the result of each sale (gross − cost − fees), the day-trade share (bought
and sold on the same day, same position), losses carried to later months, separately for
common operations, day trade and real estate funds, and the DARF due date (last weekday of
the following month; holidays are not known, so the due date is to be confirmed).
"""

from collections import defaultdict
from dataclasses import dataclass, field
from datetime import date, timedelta
from decimal import Decimal
from uuid import UUID

from opesvault.domain.ledger import Ledger
from opesvault.domain.model import YearMonth
from opesvault.domain.money import ZERO, round_money
from opesvault.investments.model import AssetClass, EventKind, InvestmentEvent
from opesvault.tax import records
from opesvault.tax.model import Bucket, PaymentPurpose

CLASSES = frozenset({AssetClass.STOCK, AssetClass.ETF, AssetClass.REIT})


@dataclass
class Trade:
    """One sale's share in a bucket."""

    on: date
    position_id: UUID
    asset_class: AssetClass
    bucket: Bucket
    gross: Decimal
    cost: Decimal
    fees: Decimal
    withheld: Decimal
    approximate: bool = False

    @property
    def result(self) -> Decimal:
        return self.gross - self.cost - self.fees


@dataclass
class MonthResult:
    month: YearMonth
    bucket: Bucket
    sales: Decimal = ZERO
    stock_sales: Decimal = ZERO  # what the exemption limit looks at
    result: Decimal = ZERO  # all sales of the month in this bucket
    exempt_gain: Decimal = ZERO
    compensated: Decimal = ZERO  # earlier losses used this month
    loss_carried: Decimal = ZERO  # losses still to compensate after this month
    base: Decimal = ZERO
    rate: Decimal | None = None
    tax: Decimal | None = None
    withheld: Decimal = ZERO
    due: Decimal | None = None
    due_date: date | None = None
    paid: Decimal = ZERO
    approximate: bool = False
    trades: list[Trade] = field(default_factory=list)

    @property
    def missing_rate(self) -> bool:
        return self.base > 0 and self.rate is None


def due_date(month: YearMonth) -> date:
    """Last weekday of the following month (holidays not considered)."""
    day = month.add(1).last_day()
    while day.weekday() >= 5:
        day -= timedelta(days=1)
    return day


def trades(ledger: Ledger, people: set[UUID] | None = None) -> list[Trade]:
    from opesvault.investments.service import assets, events, positions

    by_position_day: dict[tuple[UUID, date], list[InvestmentEvent]] = defaultdict(list)
    for event in events(ledger).values():
        by_position_day[(event.position_id, event.on)].append(event)
    out: list[Trade] = []
    for (position_id, on), day_events in by_position_day.items():
        pos = positions(ledger).get(position_id)
        if pos is None or (people is not None and pos.holder_id not in people):
            continue
        asset_class = assets(ledger)[pos.asset_id].asset_class
        if asset_class not in CLASSES:
            continue
        sells = [e for e in day_events if e.kind is EventKind.SELL]
        withdrawals = [e for e in day_events if e.kind is EventKind.WITHDRAWAL]
        buys = [e for e in day_events if e.kind is EventKind.BUY]
        bought = sum((e.quantity or ZERO for e in buys), ZERO)
        bought_cost = sum(((e.gross or ZERO) + e.fees for e in buys), ZERO)
        sold = sum((e.quantity or ZERO for e in sells), ZERO)
        day_trade_qty = min(bought, sold)
        normal = Bucket.REIT if asset_class is AssetClass.REIT else Bucket.COMMON
        for sell in sells:
            qty = sell.quantity or ZERO
            gross, cost, fees = sell.gross or ZERO, sell.cost_attributed or ZERO, sell.fees
            share = qty / sold * day_trade_qty if sold and day_trade_qty else ZERO
            if share and asset_class is not AssetClass.REIT:
                ratio = share / qty
                dt_gross, dt_fees = round_money(gross * ratio), round_money(fees * ratio)
                dt_cost = round_money(bought_cost / bought * share)
                dt_withheld = round_money(sell.tax_withheld * ratio)
                out.append(
                    Trade(on, position_id, asset_class, Bucket.DAY_TRADE, dt_gross, dt_cost, dt_fees, dt_withheld, True)
                )
                if share < qty:
                    out.append(
                        Trade(
                            on,
                            position_id,
                            asset_class,
                            normal,
                            gross - dt_gross,
                            round_money(cost * (1 - ratio)),
                            fees - dt_fees,
                            sell.tax_withheld - dt_withheld,
                            True,
                        )
                    )
                continue
            out.append(Trade(on, position_id, asset_class, normal, gross, cost, fees, sell.tax_withheld))
        for item in withdrawals:  # value-mode positions: no quantity, no day trade
            if item.gross is None or item.cost_attributed is None:
                continue
            out.append(
                Trade(
                    on, position_id, asset_class, normal, item.gross, item.cost_attributed, item.fees, item.tax_withheld
                )
            )
    return sorted(out, key=lambda t: t.on)


def months(ledger: Ledger, year: int, people: set[UUID] | None = None) -> list[MonthResult]:
    """The year's months with sales, per bucket. Losses come from the whole history before them."""
    grouped: dict[tuple[YearMonth, Bucket], MonthResult] = {}
    for trade in trades(ledger, people):
        key = (YearMonth.of(trade.on), trade.bucket)
        row = grouped.setdefault(key, MonthResult(key[0], key[1]))
        row.trades.append(trade)
        row.sales += trade.gross
        if trade.asset_class is AssetClass.STOCK and trade.bucket is Bucket.COMMON:
            row.stock_sales += trade.gross
        row.result += trade.result
        row.withheld += trade.withheld
        row.approximate = row.approximate or trade.approximate
    pools: dict[Bucket, Decimal] = defaultdict(lambda: ZERO)
    out = []
    for (month, bucket), row in sorted(grouped.items(), key=lambda kv: (kv[0][0].year, kv[0][0].month, kv[0][1])):
        rules = records.variable_rules(ledger, month.last_day())
        rule = rules.rule(bucket) if rules else None
        row.rate = rule.rate if rule else None
        taxable = row.result
        limit = rule.exempt_sales_limit if rule else None
        if bucket is Bucket.COMMON and limit is not None and row.stock_sales and row.stock_sales <= limit:
            stock_result = sum((t.result for t in row.trades if t.asset_class is AssetClass.STOCK), ZERO)
            if stock_result > 0:
                row.exempt_gain = stock_result
                taxable -= stock_result
        if taxable < 0:
            pools[bucket] += -taxable
            row.base = ZERO
        else:
            row.compensated = min(pools[bucket], taxable)
            pools[bucket] -= row.compensated
            row.base = taxable - row.compensated
        row.loss_carried = pools[bucket]
        if row.base == 0:
            row.tax = ZERO
        elif row.rate is not None:
            row.tax = round_money(row.base * row.rate)
        if row.tax is not None:
            row.due = max(row.tax - row.withheld, ZERO)
        row.due_date = due_date(month)
        if month.year == year:
            out.append(row)
    for row in out:
        row.paid = records.paid(ledger, PaymentPurpose.VARIABLE_INCOME, row.month)
    return out


def carried_loss(ledger: Ledger, year: int, people: set[UUID] | None = None) -> dict[Bucket, Decimal]:
    """Losses still to compensate at the end of the year, per bucket (they go to the next return)."""
    rows = months(ledger, year, people)
    out: dict[Bucket, Decimal] = {}
    for bucket in Bucket:
        last = [r for r in rows if r.bucket is bucket]
        if last:
            out[bucket] = last[-1].loss_carried
    return out


def exempt_total(rows: list[MonthResult]) -> Decimal:
    return sum((r.exempt_gain for r in rows), ZERO)


def due_by_month(rows: list[MonthResult]) -> dict[YearMonth, tuple[Decimal, Decimal, date]]:
    """DARF per month (all buckets add to one DARF): (due, paid, due date)."""
    out: dict[YearMonth, tuple[Decimal, Decimal, date]] = {}
    for row in rows:
        if row.due is None or row.due_date is None:
            continue
        due, _, when = out.get(row.month, (ZERO, ZERO, row.due_date))
        out[row.month] = (due + row.due, row.paid, when)  # the payment is per month, not per bucket
    return {m: v for m, v in out.items() if v[0] > 0}
