/**
 * Investment entities (docs/04 §1, docs/06). Port of `investments/model.py`.
 *
 * Three families never mix: valuations (observed value at a date), money flows
 * (contributions, withdrawals, distributions) and taxes (effective or simulated).
 */
import { z } from "zod";

import { Ledger } from "../domain/ledger.ts";
import { zEntityId } from "../domain/model.ts";
import { Dec } from "../lib/dec.ts";
import { zDate, zDec, zId } from "../lib/schema.ts";

function values<T extends Record<string, string>>(o: T): [T[keyof T], ...T[keyof T][]] {
  return Object.values(o) as [T[keyof T], ...T[keyof T][]];
}

/** Decimal("0") default of an `Amount` field (zod defaults are output values). */
const decZero = () => Dec.from("0");

export const AssetClass = {
  FIXED_INCOME: "fixed_income",
  TREASURY: "treasury",
  STOCK: "stock",
  REIT: "reit", // FII
  FUND: "fund",
  ETF: "etf",
  PENSION: "pension",
  CRYPTO: "crypto",
  OTHER: "other",
} as const;
export type AssetClass = (typeof AssetClass)[keyof typeof AssetClass];

export const ASSET_CLASS_LABELS: Readonly<Record<AssetClass, string>> = {
  fixed_income: "Renda fixa",
  treasury: "Tesouro Direto",
  stock: "Ações",
  reit: "Fundos imobiliários",
  fund: "Fundos",
  etf: "ETF",
  pension: "Previdência",
  crypto: "Criptoativos",
  other: "Outros",
};

/** Classes where selling more than held makes no sense (no short selling, docs/04 §2). */
export const NO_SHORT: ReadonlySet<AssetClass> = new Set(Object.values(AssetClass));

export const AssetSchema = z.strictObject({
  id: zEntityId,
  name: z.string().min(1).max(200),
  asset_class: z.enum(values(AssetClass)),
  ticker: z.string().max(20).nullable().default(null),
  currency: z.string().default("BRL"),
});
export type Asset = Readonly<z.output<typeof AssetSchema>>;

export const TrackingMode = {
  VALUE: "value", // observed totals only (docs/06 §1)
  QUANTITY: "quantity", // trades with quantity and price
} as const;
export type TrackingMode = (typeof TrackingMode)[keyof typeof TrackingMode];

export const PositionSchema = z.strictObject({
  id: zEntityId,
  asset_id: zId,
  account_id: zId, // ledger asset account holding the cost basis
  holder_id: zId.nullable().default(null),
  mode: z.enum(values(TrackingMode)).default(TrackingMode.VALUE),
  opened_on: zDate,
  cost_known: z.boolean().default(true), // false: tracked from a reference value; gain since acquisition is unknown
  closed: z.boolean().default(false),
});
export type Position = Readonly<z.output<typeof PositionSchema>>;

export const ValueNature = {
  GROSS: "gross", // before exit taxes
  NET_INFORMED: "net_informed",
  NET_ESTIMATED: "net_estimated",
  UNSPECIFIED: "unspecified",
} as const;
export type ValueNature = (typeof ValueNature)[keyof typeof ValueNature];

export const NATURE_LABELS: Readonly<Record<ValueNature, string>> = {
  gross: "Bruto",
  net_informed: "Líquido informado",
  net_estimated: "Líquido estimado",
  unspecified: "Não especificado",
};

export const ValuationSchema = z.strictObject({
  id: zEntityId,
  position_id: zId,
  on: zDate,
  value: zDec,
  nature: z.enum(values(ValueNature)),
  source: z.string().max(120).default("manual"),
  quantity: zDec.nullable().default(null),
  unit_price: zDec.nullable().default(null),
  note: z.string().max(500).nullable().default(null),
  selected: z.boolean().default(true), // among sources disagreeing on the same date, exactly one is used
  evidence_id: zId.nullable().default(null),
});
export type Valuation = Readonly<z.output<typeof ValuationSchema>>;

export const EventKind = {
  CONTRIBUTION: "contribution", // aporte (cash into the position)
  WITHDRAWAL: "withdrawal", // resgate/venda (cash out)
  DISTRIBUTION: "distribution", // provento paid outside the position
  BUY: "buy",
  SELL: "sell",
  SPLIT: "split", // desdobramento/grupamento: factor on quantity, cost unchanged
  BONUS: "bonus", // bonificação: extra quantity with informed cost
  TAX_PAYMENT: "tax_payment",
} as const;
export type EventKind = (typeof EventKind)[keyof typeof EventKind];

export const EventQuality = {
  COMPLETE: "complete",
  INCOMPLETE: "incomplete", // e.g. only the net is known: deductions to be itemized
} as const;
export type EventQuality = (typeof EventQuality)[keyof typeof EventQuality];

export const InvestmentEventSchema = z.strictObject({
  id: zEntityId,
  position_id: zId,
  kind: z.enum(values(EventKind)),
  on: zDate,
  gross: zDec.nullable().default(null),
  quantity: zDec.nullable().default(null),
  unit_price: zDec.nullable().default(null),
  cost_attributed: zDec.nullable().default(null),
  cost_method: z.string().nullable().default(null),
  tax_withheld: zDec.default(decZero),
  tax_due_later: zDec.default(decZero),
  fees: zDec.default(decZero),
  net: zDec.nullable().default(null),
  cash_account_id: zId.nullable().default(null),
  operation_ids: z.array(zId).readonly().default([]),
  quality: z.enum(values(EventQuality)).default(EventQuality.COMPLETE),
  factor: zDec.nullable().default(null), // SPLIT
  lot_id: zId.nullable().default(null),
  note: z.string().max(500).nullable().default(null),
});
export type InvestmentEvent = Readonly<z.output<typeof InvestmentEventSchema>>;
export type InvestmentEventInput = z.input<typeof InvestmentEventSchema>;

/** Builds a validated event, like `InvestmentEvent(...)` in Python. */
export function investmentEvent(input: InvestmentEventInput): InvestmentEvent {
  return InvestmentEventSchema.parse(input);
}

/** Python's `InvestmentEvent.realized_gain` property. */
export function realizedGain(event: InvestmentEvent): Dec | null {
  if (
    (event.kind !== EventKind.WITHDRAWAL && event.kind !== EventKind.SELL) ||
    event.gross === null ||
    event.cost_attributed === null
  ) {
    return null;
  }
  return event.gross.sub(event.cost_attributed);
}

export const TaxRuleKind = {
  FIXED: "fixed",
  RATE_ON_POSITIVE_GAIN: "rate_on_positive_gain",
  RATE_ON_INFORMED_BASE: "rate_on_informed_base",
} as const;
export type TaxRuleKind = (typeof TaxRuleKind)[keyof typeof TaxRuleKind];

/**
 * User-parameterized rule (docs/06 §7). Never a legal default.
 * Its `version` is text ("1"): Python coerces it to the history's integer version when stored.
 */
export const TaxRuleSchema = z.strictObject({
  id: zEntityId,
  name: z.string().min(1).max(120),
  version: z.string().default("1"),
  kind: z.enum(values(TaxRuleKind)),
  rate: zDec.nullable().default(null), // e.g. 0.15
  fixed_amount: zDec.nullable().default(null),
  valid_from: zDate.nullable().default(null),
  valid_to: zDate.nullable().default(null),
  source: z.string().max(300).default("informado pelo usuário"),
  simulated: z.boolean().default(true),
});
export type TaxRule = Readonly<z.output<typeof TaxRuleSchema>>;

Ledger.registerKind("asset", AssetSchema);
Ledger.registerKind("position", PositionSchema);
Ledger.registerKind("valuation", ValuationSchema);
Ledger.registerKind("investment_event", InvestmentEventSchema);
Ledger.registerKind("tax_rule", TaxRuleSchema);
