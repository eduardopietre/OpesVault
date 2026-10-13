/**
 * What the command palette finds besides commands: lançamentos (by description, notes, amount or date), contas
 * and documentos. Every word typed must appear, without accents or case. The search stops at a few results of
 * each kind and builds the text of an operation only when it reaches it (newest first), so a project with
 * 50 thousand operations answers while the person types.
 */
import {
  AccountType,
  Dec,
  ZERO,
  cashDate,
  formatBrl,
  formatDateBr,
  search,
  type Ledger,
  type Operation,
  type session,
} from "@opesvault/domain";
import { searchKey } from "@opesvault/ui";
import { subtypeLabel } from "../dialogs/accounts_labels.ts";

/** The amount the Livro shows: the sum of the positive postings. */
function operationTotal(op: Operation): Dec {
  return Dec.sum(
    op.postings.filter((p) => p.amount.isPositive()).map((p) => p.amount),
    ZERO,
  );
}

export interface RecordHit {
  kind: "operation" | "account" | "document";
  id: string;
  /** Where it lives and how to reveal it there (`useGoTo`). */
  page: string;
  ref: string;
  label: string;
  detail: string;
}

/** Results of each kind, at most. */
export const RECORD_LIMIT = 6;
/** Shorter queries find only commands (two letters already narrow 50 thousand descriptions enough). */
export const MIN_QUERY = 2;

const texts = new WeakMap<Operation, string>();

/** Description, notes, the amount as shown ("R$ 1.234,56") and plain ("1234,56"), and the date. */
function operationText(op: Operation): string {
  let text = texts.get(op);
  if (text === undefined) {
    const total = operationTotal(op);
    const when = op.occurred_on ?? cashDate(op);
    text = searchKey(
      [
        op.description,
        op.notes ?? "",
        formatBrl(total),
        total.toFixed().replace(".", ","),
        when ? `${formatDateBr(when)} ${when}` : "",
      ].join(" "),
    );
    texts.set(op, text);
  }
  return text;
}

function wordsOf(query: string): string[] {
  return searchKey(query).split(/\s+/).filter(Boolean);
}

const hasAll = (text: string, words: readonly string[]) => words.every((word) => text.includes(word));

/** The project's operations, newest first (the order the Livro shows), kept while the ledger does not change. */
function newestFirst(ledger: Ledger): readonly Operation[] {
  return ledger.cached("palette.operations", () => search.findOperations(ledger, search.operationFilter()));
}

export function findRecords(
  ledger: Ledger,
  documents: readonly session.Document[],
  query: string,
  limit: number = RECORD_LIMIT,
): RecordHit[] {
  if (query.trim().length < MIN_QUERY) return [];
  const words = wordsOf(query);
  if (!words.length) return [];
  const hits: RecordHit[] = [];

  let found = 0;
  for (const op of newestFirst(ledger)) {
    if (!hasAll(operationText(op), words)) continue;
    const when = op.occurred_on ?? cashDate(op);
    hits.push({
      kind: "operation",
      id: op.id,
      page: "livro",
      ref: op.id,
      label: op.description,
      detail: [formatBrl(operationTotal(op)), when ? formatDateBr(when) : null].filter(Boolean).join(" · "),
    });
    if (++found >= limit) break;
  }

  found = 0;
  for (const account of ledger.accounts.values()) {
    if (account.type !== AccountType.ASSET && account.type !== AccountType.LIABILITY) continue;
    if (!hasAll(searchKey(`${account.name} ${account.institution ?? ""}`), words)) continue;
    hits.push({
      kind: "account",
      id: account.id,
      page: "contas",
      ref: `conta:${account.id}`,
      label: account.name,
      detail: [subtypeLabel(account.subtype), account.institution].filter(Boolean).join(" · "),
    });
    if (++found >= limit) break;
  }

  found = 0;
  for (const document of documents) {
    if (!hasAll(searchKey(document.meta.original_name), words)) continue;
    hits.push({
      kind: "document",
      id: document.meta.id,
      page: "documentos",
      ref: document.meta.id,
      label: document.meta.original_name,
      detail: "Documento",
    });
    if (++found >= limit) break;
  }
  return hits;
}
