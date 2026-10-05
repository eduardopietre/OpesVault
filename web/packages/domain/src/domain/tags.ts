/**
 * Tags (marcadores) that cut across categories: "Viagem 2026", "Reforma" (docs/09 §1.3 E).
 * Port of `domain/tags.py`.
 *
 * A tag classifies, it is not a financial fact: it never changes balances or results, so it lives
 * beside the operation instead of inside it, and tagging an operation of a closed month is
 * allowed. Tagging one part of an installment plan tags every part, so the total of a tag is the
 * whole purchase.
 */
import { z } from "zod";

import type { IsoDate } from "../lib/dates.ts";
import type { Dec } from "../lib/dec.ts";
import { type Id, uuid5 } from "../lib/ids.ts";
import { zId } from "../lib/schema.ts";
import { casefold, sortedBy } from "../lib/text.ts";
import { plans } from "./cards.ts";
import { DomainError, Ledger } from "./ledger.ts";
import { AccountType, cashDate, type Operation, zEntityId } from "./model.ts";
import { ZERO } from "./money.ts";

export const MAX_LENGTH = 40;
const NAMESPACE = "8f0c1f56-4c1b-4f61-9f1e-5d6c7a0b7a11";

/** Python's whitespace for `str.split()`/`str.strip()` (JavaScript's `\s` differs slightly). */
// eslint-disable-next-line no-control-regex -- Python counts \x1c-\x1f as whitespace
const PY_SPACE = /[\t\n\v\f\r\x1c-\x1f \x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+/u;

/** `" ".join(text.split())`: words separated by single spaces, no ends. */
export function collapseSpaces(text: string): string {
  return text
    .split(PY_SPACE)
    .filter((w) => w)
    .join(" ");
}

export const OperationTagsSchema = z.strictObject({
  id: zEntityId,
  operation_id: zId,
  tags: z.array(z.string()).min(1).readonly(),
  version: z.number().int().default(1),
});
export type OperationTags = Readonly<z.output<typeof OperationTagsSchema>>;

Ledger.registerKind("operation_tags", OperationTagsSchema);

function collection(ledger: Ledger) {
  return ledger.entities<OperationTags>("operation_tags");
}

/** One record per operation, with a stable id. */
export function recordId(operationId: Id): Id {
  return uuid5(NAMESPACE, operationId);
}

export function normalize(tag: string): string {
  const cleaned = collapseSpaces(tag);
  if (!cleaned) throw new DomainError("Informe o nome do marcador.");
  if ([...cleaned].length > MAX_LENGTH) throw new DomainError(`Marcadores têm até ${MAX_LENGTH} caracteres.`);
  return cleaned;
}

export function tagsOf(ledger: Ledger, operationId: Id): readonly string[] {
  const found = collection(ledger).get(recordId(operationId));
  return found !== undefined ? found.tags : [];
}

/** The operation and, for an installment plan, all of its parts. */
function related(ledger: Ledger, operationId: Id): Id[] {
  for (const plan of plans(ledger).values())
    if (plan.operation_ids.includes(operationId)) return [...plan.operation_ids];
  return [operationId];
}

/** Replaces the tags of one operation (and of its installment plan). Returns the tags kept. */
export function setTags(ledger: Ledger, operationId: Id, tags: readonly string[]): string[] {
  if (!ledger.operations.has(operationId)) throw new DomainError("Operação inexistente.");
  const clean: string[] = [];
  for (const tag of tags) {
    const name = normalize(tag);
    if (!clean.some((t) => casefold(t) === casefold(name))) clean.push(canonical(ledger, name));
  }
  for (const target of related(ledger, operationId)) store(ledger, target, clean);
  return clean;
}

/** Reuses the spelling already in use ("viagem 2026" → "Viagem 2026"). */
function canonical(ledger: Ledger, name: string): string {
  for (const existing of allTags(ledger)) if (casefold(existing) === casefold(name)) return existing;
  return name;
}

function store(ledger: Ledger, operationId: Id, tags: readonly string[]): void {
  const records = collection(ledger);
  const key = recordId(operationId);
  const current = records.get(key);
  if (!tags.length) {
    if (current !== undefined) records.delete(key);
    return;
  }
  if (current === undefined) {
    ledger.put("operation_tags", OperationTagsSchema.parse({ id: key, operation_id: operationId, tags }));
  } else if (current.tags.length !== tags.length || current.tags.some((t, i) => t !== tags[i])) {
    ledger.put(
      "operation_tags",
      { ...current, tags: [...tags], version: current.version + 1 },
      {
        reason: "marcadores alterados",
      },
    );
  }
}

/** Adds `tag` to each operation; returns how many operations changed. */
export function addTag(ledger: Ledger, operationIds: readonly Id[], tag: string): number {
  const name = canonical(ledger, normalize(tag));
  let changed = 0;
  for (const opId of operationIds) {
    const current = tagsOf(ledger, opId);
    if (current.some((t) => casefold(t) === casefold(name))) continue;
    setTags(ledger, opId, [...current, name]);
    changed += 1;
  }
  return changed;
}

export function removeTag(ledger: Ledger, operationIds: readonly Id[], tag: string): number {
  let changed = 0;
  for (const opId of operationIds) {
    const current = tagsOf(ledger, opId);
    const kept = current.filter((t) => casefold(t) !== casefold(tag));
    if (kept.length !== current.length) {
      setTags(ledger, opId, kept);
      changed += 1;
    }
  }
  return changed;
}

export function allTags(ledger: Ledger): string[] {
  const seen = new Map<string, string>();
  for (const record of collection(ledger).values()) {
    for (const tag of record.tags) if (!seen.has(casefold(tag))) seen.set(casefold(tag), tag);
  }
  return sortedBy(seen.values(), casefold);
}

/**
 * Operations with `tag`. Python returned a set, iterated in hash order; here the order is the
 * order of the tag records.
 */
export function operationsWith(ledger: Ledger, tag: string): Set<Id> {
  const key = casefold(tag);
  const out = new Set<Id>();
  for (const r of collection(ledger).values()) if (r.tags.some((t) => casefold(t) === key)) out.add(r.operation_id);
  return out;
}

export function renameTag(ledger: Ledger, old: string, newName: string): number {
  const name = normalize(newName);
  let changed = 0;
  for (const opId of operationsWith(ledger, old)) {
    const current = tagsOf(ledger, opId);
    const renamed: string[] = [];
    for (const tag of current) {
      const value = casefold(tag) === casefold(old) ? name : tag;
      if (!renamed.some((t) => casefold(t) === casefold(value))) renamed.push(value);
    }
    store(ledger, opId, renamed);
    changed += 1;
  }
  return changed;
}

export interface TagSummary {
  tag: string;
  /** Net of refunds. */
  expense: Dec;
  income: Dec;
  byCategory: Map<Id, Dec>;
  first: IsoDate | null;
  last: IsoDate | null;
  operations: Operation[];
}

/** What a tag cost: expense and income postings of its active operations, whatever the month. */
export function summary(ledger: Ledger, tag: string): TagSummary {
  const result: TagSummary = {
    tag,
    expense: ZERO,
    income: ZERO,
    byCategory: new Map(),
    first: null,
    last: null,
    operations: [],
  };
  for (const opId of operationsWith(ledger, tag)) {
    const op = ledger.operations.get(opId);
    if (op === undefined || op.status !== "active") continue;
    result.operations.push(op);
    const when = op.occurred_on ?? cashDate(op);
    if (when !== null) {
      result.first = result.first === null || when < result.first ? when : result.first;
      result.last = result.last === null || when > result.last ? when : result.last;
    }
    for (const p of op.postings) {
      const account = ledger.account(p.account_id);
      if (account.type === AccountType.EXPENSE) {
        result.expense = result.expense.add(p.amount);
        result.byCategory.set(p.account_id, (result.byCategory.get(p.account_id) ?? ZERO).add(p.amount));
      } else if (account.type === AccountType.INCOME) {
        result.income = result.income.add(p.amount.negate());
      }
    }
  }
  result.operations = sortedBy(result.operations, (o) => o.occurred_on ?? cashDate(o) ?? "0001-01-01");
  return result;
}

export function summaries(ledger: Ledger): TagSummary[] {
  return sortedBy(
    allTags(ledger).map((t) => summary(ledger, t)),
    (s) => s.expense,
    true,
  );
}
