/** Bulk edits over operations (reclassification). Port of `domain/edits.py`. */
import type { Id } from "../lib/ids.ts";
import { DomainError, type Ledger } from "./ledger.ts";
import { AccountSubtype, isActive, type Posting } from "./model.ts";

export interface BulkResult {
  readonly changed: number;
  readonly skipped: number;
  readonly errors: readonly string[];
}

/**
 * Moves category postings to `targetId`. Without `sourceId`, only operations with exactly one
 * category posting of the same type are changed, so a split (rateio) is never collapsed by accident.
 */
export function reclassify(
  ledger: Ledger,
  operationIds: readonly Id[],
  targetId: Id,
  reason: string,
  sourceId: Id | null = null,
): BulkResult {
  if (!reason.trim()) throw new DomainError("A reclassificação exige um motivo.");
  const target = ledger.account(targetId);
  if (target.subtype !== AccountSubtype.CATEGORY) throw new DomainError("Escolha uma categoria de destino.");
  let changed = 0;
  let skipped = 0;
  const errors: string[] = [];
  for (const opId of operationIds) {
    const op = ledger.operations.get(opId);
    if (op === undefined || !isActive(op)) {
      skipped += 1;
      continue;
    }
    const candidates = op.postings.flatMap((p, i) => {
      const account = ledger.account(p.account_id);
      return account.type === target.type &&
        account.subtype === AccountSubtype.CATEGORY &&
        (sourceId === null || p.account_id === sourceId)
        ? [i]
        : [];
    });
    if (!candidates.length || (sourceId === null && candidates.length !== 1)) {
      skipped += 1;
      continue;
    }
    const postings: Posting[] = [...op.postings];
    for (const i of candidates) postings[i] = { ...postings[i]!, account_id: targetId };
    if (postings.every((p, i) => p.account_id === op.postings[i]!.account_id)) {
      skipped += 1;
      continue;
    }
    try {
      ledger.updateOperation({ ...op, postings }, reason);
    } catch (error) {
      if (!(error instanceof DomainError)) throw error;
      errors.push(`${op.description}: ${error.message}`);
      skipped += 1;
      continue;
    }
    changed += 1;
  }
  return { changed, skipped, errors };
}
