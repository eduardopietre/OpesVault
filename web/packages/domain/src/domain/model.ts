/**
 * Domain entities (docs/04). Port of `domain/model.py`.
 *
 * Entities are immutable plain objects in exactly their persisted JSON shape (snake_case
 * fields, decimals as Dec, dates as ISO strings); the Ledger owns every change.
 */
import { z } from "zod";

import { type IsoDate, type YearMonth, ymOf } from "../lib/dates.ts";
import { Dec } from "../lib/dec.ts";
import { newId } from "../lib/ids.ts";
import { zDate, zDec, zId, zInstant, zYearMonth } from "../lib/schema.ts";
import { BRL, toDecimal } from "./money.ts";

/** Field that gets a fresh id when absent, like Pydantic's `default_factory=new_id`. */
export const zEntityId = zId.optional().transform((v) => v ?? newId());

/** A Posting amount: like Python's validator, exact text, Dec or integer — never a float. */
const zAmount = z.union([zDec, z.number(), z.bigint()]).transform((v, ctx): Dec => {
  try {
    return v instanceof Dec ? v : toDecimal(v);
  } catch {
    ctx.addIssue({ code: "custom", message: "float or bool is not accepted for financial values" });
    return z.NEVER;
  }
});

function values<T extends Record<string, string>>(o: T): [T[keyof T], ...T[keyof T][]] {
  return Object.values(o) as [T[keyof T], ...T[keyof T][]];
}

// ── people and accounts ─────────────────────────────

/** Who answers for the family's money (holder) and who depends on it (dependent). Informative only. */
export const MemberRole = { HOLDER: "holder", DEPENDENT: "dependent" } as const;
export type MemberRole = (typeof MemberRole)[keyof typeof MemberRole];

export const MemberSchema = z.strictObject({
  id: zEntityId,
  name: z.string().min(1).max(120),
  active: z.boolean().default(true),
  role: z.enum(values(MemberRole)).default(MemberRole.HOLDER),
});
export type Member = Readonly<z.output<typeof MemberSchema>>;

export const AccountType = {
  ASSET: "asset",
  LIABILITY: "liability",
  EQUITY: "equity",
  INCOME: "income",
  EXPENSE: "expense",
} as const;
export type AccountType = (typeof AccountType)[keyof typeof AccountType];

export const AccountSubtype = {
  CHECKING: "checking",
  SAVINGS: "savings",
  CASH: "cash",
  BROKERAGE_CASH: "brokerage_cash",
  INVESTMENT: "investment",
  OTHER_ASSET: "other_asset",
  CREDIT_CARD: "credit_card",
  LOAN: "loan",
  OTHER_LIABILITY: "other_liability",
  OPENING_EQUITY: "opening_equity",
  CATEGORY: "category",
  TAX_PAYABLE: "tax_payable",
} as const;
export type AccountSubtype = (typeof AccountSubtype)[keyof typeof AccountSubtype];

export const LIQUID_SUBTYPES: ReadonlySet<AccountSubtype> = new Set([
  AccountSubtype.CHECKING,
  AccountSubtype.SAVINGS,
  AccountSubtype.CASH,
  AccountSubtype.BROKERAGE_CASH,
]);

/** Everything postings can hit: bank accounts, cards, equity and categories. */
export const LedgerAccountSchema = z.strictObject({
  id: zEntityId,
  name: z.string().min(1).max(120),
  type: z.enum(values(AccountType)),
  subtype: z.enum(values(AccountSubtype)),
  currency: z.string().default(BRL),
  institution: z.string().nullable().default(null),
  masked_number: z.string().max(32).nullable().default(null),
  holders: z.array(zId).readonly().default([]),
  parent_id: zId.nullable().default(null),
  archived: z.boolean().default(false),
});
export type LedgerAccount = Readonly<z.output<typeof LedgerAccountSchema>>;

export function isLiquid(account: LedgerAccount): boolean {
  return LIQUID_SUBTYPES.has(account.subtype);
}

export function isBalanceSheet(account: LedgerAccount): boolean {
  return (
    account.type === AccountType.ASSET || account.type === AccountType.LIABILITY || account.type === AccountType.EQUITY
  );
}

export const AdditionalCardSchema = z.strictObject({
  member_id: zId,
  last4: z.string().regex(/^\d{4}$/),
});
export type AdditionalCard = Readonly<z.output<typeof AdditionalCardSchema>>;

/** A credit card; its obligations live in `liability_account_id`. */
export const CardSchema = z.strictObject({
  id: zEntityId,
  name: z.string().min(1).max(120),
  liability_account_id: zId,
  holder_id: zId,
  last4: z.string().regex(/^\d{4}$/),
  closing_day: z.number().int().min(1).max(31),
  due_day: z.number().int().min(1).max(31),
  settlement_account_id: zId.nullable().default(null),
  additional: z.array(AdditionalCardSchema).readonly().default([]),
});
export type Card = Readonly<z.output<typeof CardSchema>>;

// ── operations ──────────────────────────────────────

export const OperationKind = {
  OPENING_BALANCE: "opening_balance",
  INCOME: "income",
  EXPENSE: "expense",
  TRANSFER: "transfer",
  CARD_PURCHASE: "card_purchase",
  CARD_PAYMENT: "card_payment",
  CARD_CHARGE: "card_charge",
  REFUND: "refund",
  INVESTMENT_CONTRIBUTION: "investment_contribution",
  INVESTMENT_WITHDRAWAL: "investment_withdrawal",
  INVESTMENT_INCOME: "investment_income",
  TAX_PAYMENT: "tax_payment",
  REVERSAL: "reversal",
  OTHER: "other",
} as const;
export type OperationKind = (typeof OperationKind)[keyof typeof OperationKind];

export const OriginKind = { MANUAL: "manual", IMPORT: "import", RECURRENCE: "recurrence", SYSTEM: "system" } as const;
export type OriginKind = (typeof OriginKind)[keyof typeof OriginKind];

export const OriginSchema = z.strictObject({
  kind: z.enum(values(OriginKind)).default(OriginKind.MANUAL),
  import_id: zId.nullable().default(null),
  evidence_ids: z.array(zId).readonly().default([]),
});
export type Origin = Readonly<z.output<typeof OriginSchema>>;

export function origin(input: z.input<typeof OriginSchema> = {}): Origin {
  return OriginSchema.parse(input);
}

/** Debit when amount > 0, credit when amount < 0. */
export const PostingSchema = z.strictObject({
  account_id: zId,
  amount: zAmount,
  member_id: zId.nullable().default(null),
});
export type Posting = Readonly<z.output<typeof PostingSchema>>;

export function posting(account_id: string, amount: Dec, member_id: string | null = null): Posting {
  return { account_id, amount, member_id };
}

export const InstallmentRefSchema = z.strictObject({
  plan_id: zId,
  number: z.number().int().min(1),
  total: z.number().int().min(1),
});
export type InstallmentRef = Readonly<z.output<typeof InstallmentRefSchema>>;

export const OperationStatus = { ACTIVE: "active", CANCELLED: "cancelled" } as const;
export type OperationStatus = (typeof OperationStatus)[keyof typeof OperationStatus];

export const OperationSchema = z.strictObject({
  id: zEntityId,
  kind: z.enum(values(OperationKind)),
  description: z.string().max(500),
  currency: z.string().default(BRL),
  postings: z.array(PostingSchema).readonly(),
  // Dates are separate on purpose (docs/02 §6, docs/04 §5); unknown stays null.
  occurred_on: zDate.nullable().default(null),
  booked_on: zDate.nullable().default(null),
  accrual_month: zYearMonth.nullable().default(null),
  due_on: zDate.nullable().default(null),
  settled_on: zDate.nullable().default(null),
  origin: OriginSchema.default(() => OriginSchema.parse({})),
  member_id: zId.nullable().default(null),
  card_id: zId.nullable().default(null),
  cardholder_id: zId.nullable().default(null),
  installment: InstallmentRefSchema.nullable().default(null),
  reversal_of: zId.nullable().default(null),
  forecast_id: zId.nullable().default(null),
  status: z.enum(values(OperationStatus)).default(OperationStatus.ACTIVE),
  notes: z.string().max(2000).nullable().default(null),
  version: z.number().int().default(1),
});
export type Operation = Readonly<z.output<typeof OperationSchema>>;
export type OperationInput = z.input<typeof OperationSchema>;

/** Builds a validated operation, like `Operation(...)` in Python. */
export function operation(input: OperationInput): Operation {
  return OperationSchema.parse(input);
}

export function cashDate(op: Operation): IsoDate | null {
  return op.settled_on ?? op.booked_on ?? op.occurred_on;
}

export function competence(op: Operation): YearMonth | null {
  if (op.accrual_month !== null) return op.accrual_month;
  const reference = op.occurred_on ?? op.booked_on ?? op.settled_on;
  return reference ? ymOf(reference) : null;
}

export function isActive(op: Operation): boolean {
  return op.status === OperationStatus.ACTIVE;
}

// ── history ─────────────────────────────────────────

export const HistoryAction = {
  CREATE: "create",
  UPDATE: "update",
  CANCEL: "cancel",
  ARCHIVE: "archive",
  CLOSE_PERIOD: "close_period",
  REOPEN_PERIOD: "reopen_period",
  APPROVE_IMPORT: "approve_import",
} as const;
export type HistoryAction = (typeof HistoryAction)[keyof typeof HistoryAction];

/** Traceability, not tamper-proof evidence (docs/03 §1). */
export const HistoryEntrySchema = z.strictObject({
  id: zEntityId,
  entity_kind: z.string(),
  entity_id: zId,
  action: z.enum(values(HistoryAction)),
  version: z.number().int(),
  before: z.record(z.string(), z.unknown()).nullable().default(null),
  after: z.record(z.string(), z.unknown()).nullable().default(null),
  operator: z.string().nullable().default(null),
  reason: z.string().nullable().default(null),
  at: zInstant,
});
export type HistoryEntry = Readonly<z.output<typeof HistoryEntrySchema>>;

/** The persisted JSON of an entity (Pydantic's `model_dump(mode="json")`). */
export function dump(entity: unknown): Record<string, unknown> {
  return JSON.parse(JSON.stringify(entity)) as Record<string, unknown>;
}
