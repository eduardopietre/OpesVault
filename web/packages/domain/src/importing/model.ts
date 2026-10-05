/**
 * Import entities: batches, evidence and extracted items (docs/04 §1, docs/05).
 * Port of `importing/model.py`.
 *
 * Extracted data is not approved data (docs/00 §4.1): items live here until the user approves
 * them, and only then become ledger operations.
 */
import { z } from "zod";

import type { Dec } from "../lib/dec.ts";
import { zDate, zDec, zId, zInstant } from "../lib/schema.ts";
import { Ledger } from "../domain/ledger.ts";
import { zEntityId } from "../domain/model.ts";

export const DocFormat = { PDF: "pdf", CSV: "csv", OFX: "ofx" } as const;
export type DocFormat = (typeof DocFormat)[keyof typeof DocFormat];

export const DocType = {
  CARD_STATEMENT: "card_statement",
  BANK_STATEMENT: "bank_statement",
  BROKERAGE_NOTE: "brokerage_note",
  INVESTMENT_STATEMENT: "investment_statement",
} as const;
export type DocType = (typeof DocType)[keyof typeof DocType];

export const BatchStatus = {
  UNSUPPORTED: "unsupported", // scanned, corrupt, unknown layout
  AMBIGUOUS: "ambiguous", // several layouts match; user must choose
  IN_REVIEW: "in_review",
  PARTIAL: "partial", // some items approved, others pending, by explicit choice
  APPROVED: "approved",
  REJECTED: "rejected",
} as const;
export type BatchStatus = (typeof BatchStatus)[keyof typeof BatchStatus];

export const ItemKind = {
  PURCHASE: "purchase", // card purchase
  CARD_CREDIT: "card_credit", // refund/credit on the card
  CARD_PAYMENT: "card_payment", // payment received by the card
  CARD_CHARGE: "card_charge", // interest, fees, IOF
  DEBIT: "debit", // bank account outflow
  CREDIT: "credit", // bank account inflow
  TRADE: "trade", // brokerage note line
  FEE: "fee", // brokerage note fee
} as const;
export type ItemKind = (typeof ItemKind)[keyof typeof ItemKind];

export const ItemStatus = {
  NEEDS_REVIEW: "needs_review",
  READY: "ready", // validated, waiting for approval
  APPROVED: "approved",
  REJECTED: "rejected",
  DUPLICATE: "duplicate", // already in the ledger; approval links evidence only
} as const;
export type ItemStatus = (typeof ItemStatus)[keyof typeof ItemStatus];

const vals = <T extends Record<string, string>>(o: T) => Object.values(o) as [T[keyof T], ...T[keyof T][]];

export const EvidenceSchema = z.strictObject({
  id: zEntityId,
  document_id: zId,
  page: z.number().int().nullable().default(null), // 1-based; null for structured files
  bbox: z.tuple([z.number(), z.number(), z.number(), z.number()]).nullable().default(null), // x0, top, x1, bottom in PDF points
  line: z.number().int().nullable().default(null), // 1-based line/record for CSV and OFX
  text: z.string().max(2000),
});
export type Evidence = Readonly<z.output<typeof EvidenceSchema>>;

export const CorrectionSchema = z.strictObject({
  field: z.string(),
  before: z.string().nullable(),
  after: z.string().nullable(),
  operator: z.string().nullable(),
  reason: z.string().nullable(),
  at: zInstant,
});
export type Correction = Readonly<z.output<typeof CorrectionSchema>>;

export const ExtractedItemSchema = z.strictObject({
  id: zEntityId,
  batch_id: zId,
  kind: z.enum(vals(ItemKind)),
  occurred_on: zDate.nullable(),
  description: z.string().max(500),
  amount: zDec.nullable(), // always positive; direction comes from `kind`
  evidence_ids: z.array(zId).readonly().default([]),
  installment: z.tuple([z.number().int(), z.number().int()]).nullable().default(null), // (number, total)
  card_last4: z.string().nullable().default(null),
  bank_id: z.string().nullable().default(null), // FITID or bank's own identifier when available
  foreign_amount: zDec.nullable().default(null),
  foreign_currency: z.string().nullable().default(null),
  quantity: zDec.nullable().default(null), // brokerage trades
  unit_price: zDec.nullable().default(null),
  ticker: z.string().nullable().default(null),
  credit: z.boolean().default(false),
  status: z.enum(vals(ItemStatus)).default(ItemStatus.NEEDS_REVIEW),
  warnings: z.array(z.string()).readonly().default([]),
  target_account_id: zId.nullable().default(null), // category, counterpart account or card chosen in review
  member_id: zId.nullable().default(null),
  duplicate_of: zId.nullable().default(null), // operation already holding this fact
  operation_id: zId.nullable().default(null), // operation created/linked on approval
  corrections: z.array(CorrectionSchema).readonly().default([]),
  suggestion_source: z.string().nullable().default(null), // "history", "rule", "ollama:<model>"; never documentary
});
export type ExtractedItem = Readonly<z.output<typeof ExtractedItemSchema>>;

/** Document-level facts used for reconciliation (docs/05 §2). */
export const StatementHeaderSchema = z.strictObject({
  institution: z.string().nullable().default(null),
  holder: z.string().nullable().default(null),
  account_hint: z.string().nullable().default(null),
  period_start: zDate.nullable().default(null),
  period_end: zDate.nullable().default(null),
  due_on: zDate.nullable().default(null),
  closing_on: zDate.nullable().default(null),
  total: zDec.nullable().default(null), // card bill total
  previous_balance: zDec.nullable().default(null),
  opening_balance: zDec.nullable().default(null),
  closing_balance: zDec.nullable().default(null),
  note_number: z.string().nullable().default(null),
  trade_date: zDate.nullable().default(null),
  settlement_date: zDate.nullable().default(null),
  net_amount: zDec.nullable().default(null), // brokerage note net (positive = credit to client)
});
export type StatementHeader = Readonly<z.output<typeof StatementHeaderSchema>>;

export const ReconciliationSchema = z.strictObject({
  label: z.string(),
  expected: zDec.nullable(),
  computed: zDec.nullable(),
  ok: z.boolean().nullable(), // null when not comparable
});
export type Reconciliation = Readonly<z.output<typeof ReconciliationSchema>>;

export function difference(r: Reconciliation): Dec | null {
  if (r.expected === null || r.computed === null) return null;
  return r.computed.sub(r.expected);
}

export const ImportBatchSchema = z.strictObject({
  id: zEntityId,
  document_id: zId,
  parser_id: z.string().nullable(),
  parser_version: z.string().nullable(),
  doc_format: z.enum(vals(DocFormat)),
  doc_type: z.enum(vals(DocType)).nullable().default(null),
  status: z.enum(vals(BatchStatus)),
  created_at: zInstant,
  account_id: zId.nullable().default(null), // bank account or card liability this document belongs to
  card_id: zId.nullable().default(null),
  header: StatementHeaderSchema.default(() => StatementHeaderSchema.parse({})),
  reconciliations: z.array(ReconciliationSchema).readonly().default([]),
  warnings: z.array(z.string()).readonly().default([]),
  candidates: z.array(z.string()).readonly().default([]), // parser ids when AMBIGUOUS
  unmapped_lines: z.number().int().default(0),
  partial_reason: z.string().nullable().default(null),
});
export type ImportBatch = Readonly<z.output<typeof ImportBatchSchema>>;

Ledger.registerKind("import_batch", ImportBatchSchema);
Ledger.registerKind("evidence", EvidenceSchema);
Ledger.registerKind("extracted_item", ExtractedItemSchema);
