/**
 * Quantity-and-price tracking: lots, buys, sells and corporate events (docs/06 §1, §6).
 * Port of `investments/trades.py`.
 *
 * Cost method depends on the class and is always recorded: average cost for
 * homogeneous positions (stocks, REITs, ETFs, funds) and per-acquisition lots
 * (FIFO) for fixed income and treasury bonds. Neither is presented as tax law.
 */
import { z } from "zod";

import { DomainError, Ledger } from "../domain/ledger.ts";
import { AccountType, zEntityId, operation, type Posting, OperationKind } from "../domain/model.ts";
import { allocate, roundMoney, toDecimal, ZERO } from "../domain/money.ts";
import type { IsoDate } from "../lib/dates.ts";
import { Dec } from "../lib/dec.ts";
import type { Id } from "../lib/ids.ts";
import { sortedGroupsBy } from "../lib/collections.ts";
import { getOrKeyError } from "../lib/py.ts";
import { zDate, zDec, zId } from "../lib/schema.ts";
import { AssetClass, EventKind, type InvestmentEvent, investmentEvent, TrackingMode } from "./model.ts";
import {
  assets,
  category,
  eventsOf,
  FEE_CATEGORY,
  INCOME_CATEGORY,
  LOSS_CATEGORY,
  position,
  requireCash,
  TAX_CATEGORY,
} from "./service.ts";

export const CostMethod = { AVERAGE: "average", FIFO: "fifo" } as const;
export type CostMethod = (typeof CostMethod)[keyof typeof CostMethod];

export const AVERAGE_CLASSES: ReadonlySet<AssetClass> = new Set([
  AssetClass.STOCK,
  AssetClass.REIT,
  AssetClass.ETF,
  AssetClass.FUND,
  AssetClass.CRYPTO,
]);

function defaultMethod(assetClass: AssetClass): CostMethod {
  return AVERAGE_CLASSES.has(assetClass) ? CostMethod.AVERAGE : CostMethod.FIFO;
}

export const METHOD_LABELS: Readonly<Record<CostMethod, string>> = {
  average: "custo médio ponderado (gestão; não é regra fiscal universal)",
  fifo: "por lote de aquisição, mais antigo primeiro",
};

export const LotSchema = z.strictObject({
  id: zEntityId,
  position_id: zId,
  acquired_on: zDate,
  quantity: zDec,
  cost: zDec, // includes allocated buy costs
  remaining_quantity: zDec,
  remaining_cost: zDec,
  source: z.string().default("compra"),
});
export type Lot = Readonly<z.output<typeof LotSchema>>;

Ledger.registerKind("lot", LotSchema);

export function lots(ledger: Ledger) {
  return ledger.entities<Lot>("lot");
}

/** A position's lots by acquisition date (ties in collection order); a fresh array. */
export function lotsOf(ledger: Ledger, positionId: Id, openOnly = false): Lot[] {
  const byPosition = ledger.cachedFor("investments.lotsOf", ["lot"], () =>
    sortedGroupsBy(
      lots(ledger).values(),
      (lot) => lot.position_id,
      (lot) => lot.acquired_on,
    ),
  );
  const out = [...(byPosition.get(positionId) ?? [])];
  return openOnly ? out.filter((lot) => lot.remaining_quantity.isPositive()) : out;
}

export interface Holding {
  readonly quantity: Dec;
  readonly cost: Dec;
}

/** Python's `Holding.average_price` property. */
export function averagePrice(h: Holding): Dec | null {
  return !h.quantity.isZero() ? h.cost.div(h.quantity) : null;
}

export function holding(ledger: Ledger, positionId: Id): Holding {
  const open = lotsOf(ledger, positionId, true);
  return {
    quantity: Dec.sum(
      open.map((lot) => lot.remaining_quantity),
      ZERO,
    ),
    cost: Dec.sum(
      open.map((lot) => lot.remaining_cost),
      ZERO,
    ),
  };
}

function requireQuantityMode(ledger: Ledger, positionId: Id): void {
  if (position(ledger, positionId).mode !== TrackingMode.QUANTITY) {
    throw new DomainError(
      "Esta posição é acompanhada por valor; converta-a para quantidade com reconciliação de custo.",
    );
  }
}

function posting(account_id: Id, amount: Dec): Posting {
  return { account_id, amount, member_id: null };
}

export interface TradeOptions {
  readonly fees?: unknown;
  readonly settled_on?: IsoDate | null;
  readonly note?: string | null;
}

export function buy(
  ledger: Ledger,
  positionId: Id,
  on: IsoDate,
  quantity: unknown,
  unitPrice: unknown,
  fromAccount: Id,
  options: TradeOptions = {},
): InvestmentEvent {
  requireQuantityMode(ledger, positionId);
  requireCash(ledger, fromAccount);
  const pos = position(ledger, positionId);
  const qty = toDecimal(quantity);
  const price = toDecimal(unitPrice);
  const fee = toDecimal(options.fees ?? "0");
  const note = options.note ?? null;
  if (!qty.isPositive() || price.isNegative() || fee.isNegative()) {
    throw new DomainError("Quantidade, preço ou custos inválidos.");
  }
  const gross = roundMoney(qty.mul(price));
  const cost = gross.add(fee);
  const op = ledger.addOperation(
    operation({
      kind: OperationKind.INVESTMENT_CONTRIBUTION,
      description: `Compra ${qty.toFixed()} ${getOrKeyError(assets(ledger), pos.asset_id).name}`,
      postings: [posting(pos.account_id, cost), posting(fromAccount, cost.negate())],
      occurred_on: on,
      settled_on: options.settled_on || on,
      notes: note,
    }),
  );
  const lot = ledger.put(
    "lot",
    LotSchema.parse({
      position_id: positionId,
      acquired_on: on,
      quantity: qty,
      cost,
      remaining_quantity: qty,
      remaining_cost: cost,
    }),
  );
  return ledger.put(
    "investment_event",
    investmentEvent({
      position_id: positionId,
      kind: EventKind.BUY,
      on,
      gross: cost,
      quantity: qty,
      unit_price: price,
      fees: fee,
      net: cost,
      cash_account_id: fromAccount,
      operation_ids: [op.id],
      lot_id: lot.id,
      note,
    }),
  );
}

/** Removes `qty` from open lots and returns the cost attributed to it. */
function consume(ledger: Ledger, positionId: Id, qty: Dec, method: CostMethod): Dec {
  const open = lotsOf(ledger, positionId, true);
  const held = Dec.sum(
    open.map((lot) => lot.remaining_quantity),
    ZERO,
  );
  if (qty.gt(held)) {
    throw new DomainError("Venda maior que a quantidade em carteira (venda a descoberto não suportada).");
  }
  if (method === CostMethod.AVERAGE) {
    const totalCost = Dec.sum(
      open.map((lot) => lot.remaining_cost),
      ZERO,
    );
    const attributed = qty.eq(held) ? totalCost : roundMoney(totalCost.mul(qty).div(held));
    // Average cost: every lot shrinks proportionally, keeping one average price.
    const remainingQtyRatio = held.sub(qty).div(held);
    const left = totalCost.sub(attributed);
    const newCosts = !left.isZero()
      ? allocate(
          left,
          open.map((lot) => lot.remaining_cost),
        )
      : open.map(() => ZERO);
    open.forEach((lot, i) => {
      ledger.put(
        "lot",
        { ...lot, remaining_quantity: lot.remaining_quantity.mul(remainingQtyRatio), remaining_cost: newCosts[i]! },
        { reason: "venda (custo médio)" },
      );
    });
    return attributed;
  }
  let attributed = ZERO;
  let left = qty;
  for (const lot of open) {
    if (left.isZero()) break;
    const take = Dec.min(left, lot.remaining_quantity);
    const cost = take.eq(lot.remaining_quantity)
      ? lot.remaining_cost
      : roundMoney(lot.remaining_cost.mul(take).div(lot.remaining_quantity));
    attributed = attributed.add(cost);
    ledger.put(
      "lot",
      { ...lot, remaining_quantity: lot.remaining_quantity.sub(take), remaining_cost: lot.remaining_cost.sub(cost) },
      { reason: "venda (por lote)" },
    );
    left = left.sub(take);
  }
  return attributed;
}

export interface SellOptions extends TradeOptions {
  readonly tax_withheld?: unknown;
  readonly method?: CostMethod | null;
}

export function sell(
  ledger: Ledger,
  positionId: Id,
  on: IsoDate,
  quantity: unknown,
  unitPrice: unknown,
  toAccount: Id,
  options: SellOptions = {},
): InvestmentEvent {
  requireQuantityMode(ledger, positionId);
  requireCash(ledger, toAccount);
  const pos = position(ledger, positionId);
  const asset = getOrKeyError(assets(ledger), pos.asset_id);
  const qty = toDecimal(quantity);
  const price = toDecimal(unitPrice);
  const fee = toDecimal(options.fees ?? "0");
  const tax = toDecimal(options.tax_withheld ?? "0");
  const note = options.note ?? null;
  if (!qty.isPositive() || price.isNegative() || fee.isNegative() || tax.isNegative()) {
    throw new DomainError("Quantidade, preço ou custos inválidos.");
  }
  const chosen = options.method || defaultMethod(asset.asset_class);
  const gross = roundMoney(qty.mul(price));
  const net = gross.sub(fee).sub(tax);
  // Validate quantity before touching lots.
  if (qty.gt(holding(ledger, positionId).quantity)) {
    throw new DomainError("Venda maior que a quantidade em carteira (venda a descoberto não suportada).");
  }
  const cost = consume(ledger, positionId, qty, chosen);
  const gain = gross.sub(cost);
  const postings: Posting[] = [posting(toAccount, net), posting(pos.account_id, cost.negate())];
  if (gain.isPositive()) {
    postings.push(posting(category(ledger, AccountType.INCOME, INCOME_CATEGORY), gain.negate()));
  } else if (gain.isNegative()) {
    postings.push(posting(category(ledger, AccountType.EXPENSE, LOSS_CATEGORY), gain.negate()));
  }
  if (!fee.isZero()) postings.push(posting(category(ledger, AccountType.EXPENSE, FEE_CATEGORY), fee));
  if (!tax.isZero()) postings.push(posting(category(ledger, AccountType.EXPENSE, TAX_CATEGORY), tax));
  const op = ledger.addOperation(
    operation({
      kind: OperationKind.INVESTMENT_WITHDRAWAL,
      description: `Venda ${qty.toFixed()} ${asset.name}`,
      postings: postings.filter((p) => !p.amount.isZero()),
      occurred_on: on,
      settled_on: options.settled_on || on,
      notes: note,
    }),
  );
  return ledger.put(
    "investment_event",
    investmentEvent({
      position_id: positionId,
      kind: EventKind.SELL,
      on,
      gross,
      quantity: qty,
      unit_price: price,
      cost_attributed: cost,
      cost_method: METHOD_LABELS[chosen],
      tax_withheld: tax,
      fees: fee,
      net,
      cash_account_id: toAccount,
      operation_ids: [op.id],
      note,
    }),
  );
}

/** Desdobramento (factor > 1) or grupamento (factor < 1): quantity changes, cost does not. */
export function split(ledger: Ledger, positionId: Id, on: IsoDate, factor: unknown): InvestmentEvent {
  requireQuantityMode(ledger, positionId);
  const ratio = toDecimal(factor);
  if (!ratio.isPositive()) throw new DomainError("Fator inválido.");
  for (const lot of lotsOf(ledger, positionId)) {
    ledger.put(
      "lot",
      { ...lot, quantity: lot.quantity.mul(ratio), remaining_quantity: lot.remaining_quantity.mul(ratio) },
      { reason: `desdobramento/grupamento fator ${ratio.toString()}` },
    );
  }
  return ledger.put(
    "investment_event",
    investmentEvent({ position_id: positionId, kind: EventKind.SPLIT, on, factor: ratio }),
  );
}

/** Bonificação: new shares; their cost is the value informed by the company (possibly zero). */
export function bonus(
  ledger: Ledger,
  positionId: Id,
  on: IsoDate,
  quantity: unknown,
  informedCost: unknown = "0",
): InvestmentEvent {
  requireQuantityMode(ledger, positionId);
  const pos = position(ledger, positionId);
  const qty = toDecimal(quantity);
  const cost = toDecimal(informedCost);
  if (!qty.isPositive() || cost.isNegative()) throw new DomainError("Quantidade ou custo inválidos.");
  let operationIds: Id[] = [];
  if (!cost.isZero()) {
    const op = ledger.addOperation(
      operation({
        kind: OperationKind.INVESTMENT_INCOME,
        description: `Bonificação — ${getOrKeyError(assets(ledger), pos.asset_id).name} (custo informado pela empresa)`,
        postings: [
          posting(pos.account_id, cost),
          posting(category(ledger, AccountType.INCOME, INCOME_CATEGORY), cost.negate()),
        ],
        occurred_on: on,
      }),
    );
    operationIds = [op.id];
  }
  const lot = ledger.put(
    "lot",
    LotSchema.parse({
      position_id: positionId,
      acquired_on: on,
      quantity: qty,
      cost,
      remaining_quantity: qty,
      remaining_cost: cost,
      source: "bonificação",
    }),
  );
  return ledger.put(
    "investment_event",
    investmentEvent({
      position_id: positionId,
      kind: EventKind.BONUS,
      on,
      quantity: qty,
      gross: cost,
      operation_ids: operationIds,
      lot_id: lot.id,
    }),
  );
}

/** Quantity held at the end of a date, replaying buys, sells, splits and bonuses. */
export function quantityOn(ledger: Ledger, positionId: Id, on: IsoDate): Dec {
  let qty = ZERO;
  for (const event of eventsOf(ledger, positionId)) {
    if (event.on > on) break;
    if (
      (event.kind === EventKind.BUY || event.kind === EventKind.BONUS) &&
      event.quantity &&
      !event.quantity.isZero()
    ) {
      qty = qty.add(event.quantity);
    } else if (event.kind === EventKind.SELL && event.quantity && !event.quantity.isZero()) {
      qty = qty.sub(event.quantity);
    } else if (event.kind === EventKind.SPLIT && event.factor && !event.factor.isZero()) {
      qty = qty.mul(event.factor);
    }
  }
  return qty;
}

/** Existing holdings when the vault starts: quantity and known cost, against opening equity. */
export function openingLot(ledger: Ledger, positionId: Id, on: IsoDate, quantity: unknown, cost: unknown): Lot {
  requireQuantityMode(ledger, positionId);
  const pos = position(ledger, positionId);
  const qty = toDecimal(quantity);
  const value = toDecimal(cost);
  if (!qty.isPositive() || value.isNegative()) throw new DomainError("Quantidade ou custo inválidos.");
  if (!value.isZero()) ledger.recordOpeningBalance(pos.account_id, value, on);
  const lot = ledger.put(
    "lot",
    LotSchema.parse({
      position_id: positionId,
      acquired_on: on,
      quantity: qty,
      cost: value,
      remaining_quantity: qty,
      remaining_cost: value,
      source: "posição inicial",
    }),
  );
  ledger.put(
    "investment_event",
    investmentEvent({
      position_id: positionId,
      kind: EventKind.BUY,
      on,
      gross: value,
      quantity: qty,
      lot_id: lot.id,
      note: "posição inicial",
    }),
  );
  return lot;
}
