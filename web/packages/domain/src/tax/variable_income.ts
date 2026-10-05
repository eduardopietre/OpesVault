/**
 * Month by month result of stock, ETF and real estate fund sales (renda variável).
 * Port of `tax/variable_income.py`.
 *
 * Rates and the monthly exemption limit come from the user (`VariableIncomeRules`); without a
 * rate the tax stays unknown, never zero. What the app does on its own is arithmetic over the
 * recorded trades: the result of each sale (gross − cost − fees), the day-trade share (bought
 * and sold on the same day, same position), losses carried to later months, separately for
 * common operations, day trade and real estate funds, and the DARF due date (last weekday of
 * the following month; holidays are not known, so the due date is to be confirmed).
 */
import type { Ledger } from "../domain/ledger.ts";
import { roundMoney, ZERO } from "../domain/money.ts";
import { addDays, type IsoDate, type YearMonth, weekday, ymAdd, ymLastDay, ymOf, ymStr } from "../lib/dates.ts";
import { Dec } from "../lib/dec.ts";
import type { Id } from "../lib/ids.ts";
import { sortedBy } from "../lib/text.ts";
import { AssetClass, EventKind, type InvestmentEvent } from "../investments/model.ts";
import { assets, events, positions } from "../investments/service.ts";
import { getOrKeyError } from "../lib/py.ts";
import { Bucket, PaymentPurpose, ruleOf } from "./model.ts";
import * as records from "./records.ts";

export const CLASSES: ReadonlySet<AssetClass> = new Set([AssetClass.STOCK, AssetClass.ETF, AssetClass.REIT]);

/** Python's `x or ZERO` on an optional Decimal: a zero (of any scale) becomes ZERO too. */
function orZero(value: Dec | null): Dec {
  return value === null || value.isZero() ? ZERO : value;
}

/** One sale's share in a bucket. */
export interface Trade {
  readonly on: IsoDate;
  readonly position_id: Id;
  readonly asset_class: AssetClass;
  readonly bucket: Bucket;
  readonly gross: Dec;
  readonly cost: Dec;
  readonly fees: Dec;
  readonly withheld: Dec;
  readonly approximate: boolean;
}

/** Python's `Trade.result` property. */
export function tradeResult(t: Trade): Dec {
  return t.gross.sub(t.cost).sub(t.fees);
}

export interface MonthResult {
  month: YearMonth;
  bucket: Bucket;
  sales: Dec;
  stock_sales: Dec; // what the exemption limit looks at
  result: Dec; // all sales of the month in this bucket
  exempt_gain: Dec;
  compensated: Dec; // earlier losses used this month
  loss_carried: Dec; // losses still to compensate after this month
  base: Dec;
  rate: Dec | null;
  tax: Dec | null;
  withheld: Dec;
  due: Dec | null;
  due_date: IsoDate | null;
  paid: Dec;
  approximate: boolean;
  trades: Trade[];
}

/** Python's `MonthResult.missing_rate` property. */
export function missingRate(row: MonthResult): boolean {
  return row.base.isPositive() && row.rate === null;
}

/** Last weekday of the following month (holidays not considered). */
export function dueDate(month: YearMonth): IsoDate {
  let day = ymLastDay(ymAdd(month, 1));
  while (weekday(day) >= 5) day = addDays(day, -1);
  return day;
}

function trade(
  on: IsoDate,
  position_id: Id,
  asset_class: AssetClass,
  bucket: Bucket,
  gross: Dec,
  cost: Dec,
  fees: Dec,
  withheld: Dec,
  approximate = false,
): Trade {
  return { on, position_id, asset_class, bucket, gross, cost, fees, withheld, approximate };
}

export function trades(ledger: Ledger, people: ReadonlySet<Id> | null = null): Trade[] {
  const byPositionDay = new Map<string, { position_id: Id; on: IsoDate; events: InvestmentEvent[] }>();
  for (const event of events(ledger).values()) {
    const key = `${event.position_id}|${event.on}`;
    const group = byPositionDay.get(key);
    if (group === undefined) byPositionDay.set(key, { position_id: event.position_id, on: event.on, events: [event] });
    else group.events.push(event);
  }
  const out: Trade[] = [];
  for (const { position_id: positionId, on, events: dayEvents } of byPositionDay.values()) {
    const pos = positions(ledger).get(positionId);
    if (pos === undefined || (people !== null && (pos.holder_id === null || !people.has(pos.holder_id)))) continue;
    const assetClass = getOrKeyError(assets(ledger), pos.asset_id).asset_class;
    if (!CLASSES.has(assetClass)) continue;
    const sells = dayEvents.filter((e) => e.kind === EventKind.SELL);
    const withdrawals = dayEvents.filter((e) => e.kind === EventKind.WITHDRAWAL);
    const buys = dayEvents.filter((e) => e.kind === EventKind.BUY);
    const bought = Dec.sum(
      buys.map((e) => orZero(e.quantity)),
      ZERO,
    );
    const boughtCost = Dec.sum(
      buys.map((e) => orZero(e.gross).add(e.fees)),
      ZERO,
    );
    const sold = Dec.sum(
      sells.map((e) => orZero(e.quantity)),
      ZERO,
    );
    const dayTradeQty = Dec.min(bought, sold);
    const normal = assetClass === AssetClass.REIT ? Bucket.REIT : Bucket.COMMON;
    for (const sell of sells) {
      const qty = orZero(sell.quantity);
      const gross = orZero(sell.gross);
      const cost = orZero(sell.cost_attributed);
      const fees = sell.fees;
      const share = !sold.isZero() && !dayTradeQty.isZero() ? qty.div(sold).mul(dayTradeQty) : ZERO;
      if (!share.isZero() && assetClass !== AssetClass.REIT) {
        const ratio = share.div(qty);
        const dtGross = roundMoney(gross.mul(ratio));
        const dtFees = roundMoney(fees.mul(ratio));
        const dtCost = roundMoney(boughtCost.div(bought).mul(share));
        const dtWithheld = roundMoney(sell.tax_withheld.mul(ratio));
        out.push(trade(on, positionId, assetClass, Bucket.DAY_TRADE, dtGross, dtCost, dtFees, dtWithheld, true));
        if (share.lt(qty)) {
          out.push(
            trade(
              on,
              positionId,
              assetClass,
              normal,
              gross.sub(dtGross),
              roundMoney(cost.mul(Dec.from(1).sub(ratio))),
              fees.sub(dtFees),
              sell.tax_withheld.sub(dtWithheld),
              true,
            ),
          );
        }
        continue;
      }
      out.push(trade(on, positionId, assetClass, normal, gross, cost, fees, sell.tax_withheld));
    }
    for (const item of withdrawals) {
      // value-mode positions: no quantity, no day trade
      if (item.gross === null || item.cost_attributed === null) continue;
      out.push(
        trade(on, positionId, assetClass, normal, item.gross, item.cost_attributed, item.fees, item.tax_withheld),
      );
    }
  }
  return sortedBy(out, (t) => t.on);
}

/** The year's months with sales, per bucket. Losses come from the whole history before them. */
export function months(ledger: Ledger, year: number, people: ReadonlySet<Id> | null = null): MonthResult[] {
  const grouped = new Map<string, MonthResult>();
  for (const t of trades(ledger, people)) {
    const month = ymOf(t.on);
    const key = `${ymStr(month)}|${t.bucket}`;
    let row = grouped.get(key);
    if (row === undefined) {
      row = {
        month,
        bucket: t.bucket,
        sales: ZERO,
        stock_sales: ZERO,
        result: ZERO,
        exempt_gain: ZERO,
        compensated: ZERO,
        loss_carried: ZERO,
        base: ZERO,
        rate: null,
        tax: null,
        withheld: ZERO,
        due: null,
        due_date: null,
        paid: ZERO,
        approximate: false,
        trades: [],
      };
      grouped.set(key, row);
    }
    row.trades.push(t);
    row.sales = row.sales.add(t.gross);
    if (t.asset_class === AssetClass.STOCK && t.bucket === Bucket.COMMON)
      row.stock_sales = row.stock_sales.add(t.gross);
    row.result = row.result.add(tradeResult(t));
    row.withheld = row.withheld.add(t.withheld);
    row.approximate = row.approximate || t.approximate;
  }
  const pools = new Map<Bucket, Dec>();
  const pool = (b: Bucket) => pools.get(b) ?? ZERO;
  const out: MonthResult[] = [];
  for (const row of sortedBy([...grouped.values()], (r) => [r.month.year, r.month.month, r.bucket])) {
    const { month, bucket } = row;
    const rules = records.variableRules(ledger, ymLastDay(month));
    const rule = rules ? ruleOf(rules, bucket) : null;
    row.rate = rule ? rule.rate : null;
    let taxable = row.result;
    const limit = rule ? rule.exempt_sales_limit : null;
    if (bucket === Bucket.COMMON && limit !== null && !row.stock_sales.isZero() && row.stock_sales.lte(limit)) {
      const stockResult = Dec.sum(row.trades.filter((t) => t.asset_class === AssetClass.STOCK).map(tradeResult), ZERO);
      if (stockResult.isPositive()) {
        row.exempt_gain = stockResult;
        taxable = taxable.sub(stockResult);
      }
    }
    if (taxable.isNegative()) {
      pools.set(bucket, pool(bucket).add(taxable.negate()));
      row.base = ZERO;
    } else {
      row.compensated = Dec.min(pool(bucket), taxable);
      pools.set(bucket, pool(bucket).sub(row.compensated));
      row.base = taxable.sub(row.compensated);
    }
    row.loss_carried = pool(bucket);
    if (row.base.isZero()) row.tax = ZERO;
    else if (row.rate !== null) row.tax = roundMoney(row.base.mul(row.rate));
    if (row.tax !== null) row.due = Dec.max(row.tax.sub(row.withheld), ZERO);
    row.due_date = dueDate(month);
    if (month.year === year) out.push(row);
  }
  for (const row of out) row.paid = records.paid(ledger, PaymentPurpose.VARIABLE_INCOME, row.month);
  return out;
}

/** Losses still to compensate at the end of the year, per bucket (they go to the next return). */
export function carriedLoss(ledger: Ledger, year: number, people: ReadonlySet<Id> | null = null): Map<Bucket, Dec> {
  const rows = months(ledger, year, people);
  const out = new Map<Bucket, Dec>();
  for (const bucket of Object.values(Bucket)) {
    const last = rows.filter((r) => r.bucket === bucket);
    if (last.length) out.set(bucket, last[last.length - 1]!.loss_carried);
  }
  return out;
}

export function exemptTotal(rows: readonly MonthResult[]): Dec {
  return Dec.sum(
    rows.map((r) => r.exempt_gain),
    ZERO,
  );
}

export interface MonthDue {
  readonly month: YearMonth;
  readonly due: Dec;
  readonly paid: Dec;
  readonly due_date: IsoDate;
}

/** DARF per month (all buckets add to one DARF), keyed by "YYYY-MM": (due, paid, due date). */
export function dueByMonth(rows: readonly MonthResult[]): Map<string, MonthDue> {
  const out = new Map<string, MonthDue>();
  for (const row of rows) {
    if (row.due === null || row.due_date === null) continue;
    const key = ymStr(row.month);
    const previous = out.get(key);
    const due = previous ? previous.due : ZERO;
    const when = previous ? previous.due_date : row.due_date;
    // the payment is per month, not per bucket
    out.set(key, { month: row.month, due: due.add(row.due), paid: row.paid, due_date: when });
  }
  return new Map([...out].filter(([, v]) => v.due.isPositive()));
}
