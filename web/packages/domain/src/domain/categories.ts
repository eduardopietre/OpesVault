/**
 * Managing income and expense categories: rename, archive (and bring back) and merge two into one.
 * Not in the Python original.
 *
 * A category is a ledger account (subtype `category`), so renaming and archiving go through
 * `Ledger.updateAccount` and leave history. Merging moves every reference to the source category to the
 * target: the postings of active operations (each a corrected operation, so the double entry is checked
 * again), sub-categories, budget lines, recurrences, categorization rules, items under import review,
 * installment and loan plans, saved filters and the tax records keyed by category. The source is then
 * archived, not deleted: cancelled operations and the history still name it.
 */
import type { Dec } from "../lib/dec.ts";
import type { Id } from "../lib/ids.ts";
import { type YearMonth, ymBr, ymCompare, ymEq } from "../lib/dates.ts";
import { casefold } from "../lib/text.ts";
import { DomainError, type Ledger } from "./ledger.ts";
import { AccountSubtype, type LedgerAccount, type Operation, type Posting } from "./model.ts";
import { isClosed, monthsOf } from "./periods.ts";
import { ZERO } from "./money.ts";

export const MERGE_REASON = "categorias mescladas";

function category(ledger: Ledger, id: Id): LedgerAccount {
  const account = ledger.accounts.get(id);
  if (account === undefined || account.subtype !== AccountSubtype.CATEGORY) {
    throw new DomainError("Categoria inexistente.");
  }
  return account;
}

/** Active categories of the same kind with this name (case and accents as typed, compared without case). */
function sameName(ledger: Ledger, account: LedgerAccount, name: string): LedgerAccount | undefined {
  const wanted = casefold(name);
  return [...ledger.accounts.values()].find(
    (a) =>
      a.id !== account.id &&
      a.subtype === AccountSubtype.CATEGORY &&
      a.type === account.type &&
      !a.archived &&
      casefold(a.name) === wanted,
  );
}

export function renameCategory(ledger: Ledger, id: Id, name: string): LedgerAccount {
  const current = category(ledger, id);
  const title = name.trim();
  if (!title) throw new DomainError("Informe o nome.");
  if (title.length > 120) throw new DomainError("Use até 120 caracteres no nome.");
  if (title === current.name) return current;
  if (sameName(ledger, current, title)) {
    throw new DomainError(`Já existe a categoria “${title}”. Para juntar as duas, use Mesclar.`);
  }
  return ledger.updateAccount({ ...current, name: title }, "categoria renomeada");
}

/** Sub-categories of `id` that are still in use (not archived). */
export function activeChildren(ledger: Ledger, id: Id): LedgerAccount[] {
  return [...ledger.accounts.values()].filter((a) => a.parent_id === id && !a.archived);
}

/**
 * Archives a category (it leaves the lists of choices; its entries and reports stay) or brings it back.
 * A category with active sub-categories is not archived, so no active category hangs from an archived one.
 */
export function setArchived(ledger: Ledger, id: Id, archived: boolean): LedgerAccount {
  const current = category(ledger, id);
  if (current.archived === archived) return current;
  if (archived && activeChildren(ledger, id).length) {
    throw new DomainError(`Arquive ou mescle antes as subcategorias de “${current.name}”.`);
  }
  if (!archived && current.parent_id !== null && ledger.accounts.get(current.parent_id)?.archived) {
    throw new DomainError("Reative antes a categoria-mãe.");
  }
  if (!archived && sameName(ledger, current, current.name)) {
    throw new DomainError(`Já existe outra categoria ativa chamada “${current.name}”. Renomeie uma delas antes.`);
  }
  return ledger.updateAccount({ ...current, archived }, archived ? "categoria arquivada" : "categoria reativada");
}

/** Active operations with a posting on the category: the ones a merge moves. */
export function operationsUsing(ledger: Ledger, id: Id): Operation[] {
  return [...ledger.activeOperations()].filter((op) => op.postings.some((p) => p.account_id === id));
}

function isDescendant(ledger: Ledger, id: Id, ancestorId: Id): boolean {
  const seen = new Set<Id>();
  let cursor = ledger.accounts.get(id)?.parent_id ?? null;
  while (cursor !== null && !seen.has(cursor)) {
    if (cursor === ancestorId) return true;
    seen.add(cursor);
    cursor = ledger.accounts.get(cursor)?.parent_id ?? null;
  }
  return false;
}

export interface MergePreview {
  /** Active operations whose postings move. */
  readonly operations: number;
  /** Closed months among those operations: the merge is refused until they are reopened. */
  readonly closedMonths: readonly YearMonth[];
}

/** Checks a merge and says what it would move; throws when it cannot be done. */
export function previewMerge(ledger: Ledger, sourceId: Id, targetId: Id): MergePreview {
  const source = category(ledger, sourceId);
  const target = category(ledger, targetId);
  if (sourceId === targetId) throw new DomainError("Escolha outra categoria de destino.");
  if (source.type !== target.type)
    throw new DomainError("Só se mesclam categorias do mesmo tipo (receita ou despesa).");
  if (target.archived) throw new DomainError("A categoria de destino está arquivada. Reative-a antes.");
  if (isDescendant(ledger, targetId, sourceId)) {
    throw new DomainError(`“${target.name}” fica dentro de “${source.name}”: escolha uma categoria fora dela.`);
  }
  const ops = operationsUsing(ledger, sourceId);
  const closedMonths: YearMonth[] = [];
  for (const op of ops) {
    for (const month of monthsOf(op)) {
      if (isClosed(ledger, month) && !closedMonths.some((m) => ymEq(m, month))) closedMonths.push(month);
    }
  }
  return { operations: ops.length, closedMonths };
}

/** The postings with the source replaced by the target; two postings then equal in account and member become one. */
function movedPostings(postings: readonly Posting[], sourceId: Id, targetId: Id): Posting[] {
  const out: Posting[] = [];
  for (const p of postings) {
    const moved = p.account_id === sourceId ? { ...p, account_id: targetId } : p;
    const twin = out.findIndex(
      (q) => q.account_id === targetId && moved.account_id === targetId && q.member_id === moved.member_id,
    );
    const sum = twin >= 0 ? out[twin]!.amount.add(moved.amount) : ZERO;
    if (twin >= 0 && !sum.isZero()) out[twin] = { ...out[twin]!, amount: sum };
    else out.push(moved);
  }
  return out;
}

type Row = { readonly id: Id } & Record<string, unknown>;

/** Every record of `kind` whose `field` names the source now names the target. */
function repoint(ledger: Ledger, kind: string, field: string, sourceId: Id, targetId: Id): void {
  const collection = ledger.entities<Row>(kind);
  for (const row of [...collection.values()]) {
    if (row[field] === sourceId) ledger.put(kind, { ...row, [field]: targetId }, { reason: MERGE_REASON });
  }
}

/**
 * Records that hold at most one entry per category (`refField` names it, `match` picks the category ones): the
 * target keeps its own; the source's entry moves only when the target has none.
 */
function repointUnique(
  ledger: Ledger,
  kind: string,
  refField: string,
  match: (row: Row) => boolean,
  sourceId: Id,
  targetId: Id,
): void {
  const collection = ledger.entities<Row>(kind);
  const rows = [...collection.values()].filter(match);
  const targetHas = rows.some((r) => r[refField] === targetId);
  for (const row of rows) {
    if (row[refField] !== sourceId) continue;
    if (targetHas) collection.delete(row.id);
    else ledger.put(kind, { ...row, [refField]: targetId }, { reason: MERGE_REASON });
  }
}

interface BudgetRow extends Row {
  readonly category_id: Id;
  readonly month: YearMonth;
  readonly amount: Dec;
  readonly version: number;
}

/** Budget lines: the source's plan moves to the target; in a month both have, the two values add up. */
function mergeBudgets(ledger: Ledger, sourceId: Id, targetId: Id): void {
  const collection = ledger.entities<BudgetRow>("budget_line");
  const all = [...collection.values()];
  for (const line of all.filter((l) => l.category_id === sourceId)) {
    const twin = all.find((l) => l.category_id === targetId && ymEq(l.month, line.month));
    if (twin === undefined) {
      ledger.put(
        "budget_line",
        { ...line, category_id: targetId, version: line.version + 1 },
        { reason: MERGE_REASON },
      );
    } else {
      ledger.put(
        "budget_line",
        { ...twin, amount: twin.amount.add(line.amount), version: twin.version + 1 },
        { reason: MERGE_REASON },
      );
      collection.delete(line.id);
    }
  }
}

export interface MergeResult {
  /** Operations whose postings moved. */
  readonly operations: number;
}

/**
 * Merges `sourceId` into `targetId` (same kind): every reference moves to the target and the source is
 * archived. Refused while an operation to move lies in a closed month. Run inside one action (one undo step).
 */
export function mergeCategories(ledger: Ledger, sourceId: Id, targetId: Id): MergeResult {
  const preview = previewMerge(ledger, sourceId, targetId);
  if (preview.closedMonths.length) {
    const months = [...preview.closedMonths].sort(ymCompare).map(ymBr).join(", ");
    throw new DomainError(`Há lançamentos desta categoria em mês fechado (${months}). Reabra-o antes de mesclar.`);
  }
  const ops = operationsUsing(ledger, sourceId);
  for (const op of ops) {
    ledger.updateOperation({ ...op, postings: movedPostings(op.postings, sourceId, targetId) }, MERGE_REASON);
  }
  // Sub-categories of the source now hang from the target.
  for (const child of [...ledger.accounts.values()].filter((a) => a.parent_id === sourceId)) {
    ledger.updateAccount({ ...child, parent_id: targetId }, MERGE_REASON);
  }
  mergeBudgets(ledger, sourceId, targetId);
  repoint(ledger, "recurrence_rule", "counterpart_id", sourceId, targetId);
  repoint(ledger, "category_rule", "target_account_id", sourceId, targetId);
  repoint(ledger, "extracted_item", "target_account_id", sourceId, targetId);
  repoint(ledger, "installment_plan", "category_id", sourceId, targetId);
  repoint(ledger, "loan_plan", "interest_category_id", sourceId, targetId);
  repoint(ledger, "loan_plan", "fees_category_id", sourceId, targetId);
  repoint(ledger, "saved_filter", "account_id", sourceId, targetId);
  repoint(ledger, "income_report", "source_id", sourceId, targetId);
  repointUnique(ledger, "deductible_category", "category_id", () => true, sourceId, targetId);
  repointUnique(ledger, "tax_identity", "ref", (r) => r["subject"] === "category", sourceId, targetId);
  repointUnique(ledger, "income_classification", "ref", (r) => r["subject"] === "category", sourceId, targetId);
  const source = ledger.account(sourceId);
  if (!source.archived) ledger.updateAccount({ ...source, archived: true }, MERGE_REASON);
  return { operations: ops.length };
}
