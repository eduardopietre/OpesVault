/**
 * Importar e revisar without React (desktop `ui/pages/imports/labels.py` and the `refresh` of `page.py`): the
 * words the review shows for batches, items and where a suggested category came from, one row per imported
 * document and one per extracted item, and the facts of a document with the verdict of each check.
 */
import { AccountType, importing, type Dec, type Id, type IsoDate, type Ledger, type session } from "@opesvault/domain";
import type { SelectOption } from "@opesvault/ui";
import { categoryItems } from "../../dialogs/account_choices.ts";
import { dateOr, moneyOr } from "../../data/money.ts";

type Batch = importing.importModel.ImportBatch;
type Item = importing.importModel.ExtractedItem;
type Evidence = importing.importModel.Evidence;
const { BatchStatus, ItemKind, ItemStatus } = importing.importModel;

export const STATUS_LABELS: Readonly<Record<Batch["status"], string>> = {
  [BatchStatus.UNSUPPORTED]: "Não suportado",
  [BatchStatus.AMBIGUOUS]: "Escolher layout",
  [BatchStatus.IN_REVIEW]: "Em revisão",
  [BatchStatus.PARTIAL]: "Parcial",
  [BatchStatus.APPROVED]: "Aprovado",
  [BatchStatus.REJECTED]: "Rejeitado",
};

export const ITEM_STATUS_LABELS: Readonly<Record<Item["status"], string>> = {
  [ItemStatus.NEEDS_REVIEW]: "Revisar",
  [ItemStatus.READY]: "Pronto",
  [ItemStatus.APPROVED]: "Aprovado",
  [ItemStatus.REJECTED]: "Rejeitado",
  [ItemStatus.DUPLICATE]: "Já registrado",
};

export const KIND_LABELS: Readonly<Record<Item["kind"], string>> = {
  [ItemKind.PURCHASE]: "Compra",
  [ItemKind.CARD_CREDIT]: "Crédito/estorno",
  [ItemKind.CARD_PAYMENT]: "Pagamento",
  [ItemKind.CARD_CHARGE]: "Encargo",
  [ItemKind.DEBIT]: "Saída",
  [ItemKind.CREDIT]: "Entrada",
  [ItemKind.TRADE]: "Negócio",
  [ItemKind.FEE]: "Custo",
};

/** "history" was written by versions before the learned suggestions; old items still carry it. */
const SOURCE_LABELS: Readonly<Record<string, string>> = {
  history: "sugestão (histórico)",
  rule: "sugestão (regra padrão)",
};

export function sourceLabel(source: string): string {
  const learned = importing.learning.describeSource(source);
  if (learned !== null) return `sugestão (${learned})`;
  if (source.startsWith("user_rule:")) return "sugestão (sua regra)";
  if (source.startsWith("ollama:")) {
    // "ollama:<model>:<prompt>[@digest]": the model name is what a person recognizes.
    const rest = (source.slice("ollama:".length).split("@")[0] ?? "").split(":");
    return `sugestão (IA local, ${rest.slice(0, -1).join(":") || (rest[0] ?? "")})`;
  }
  return SOURCE_LABELS[source] ?? `sugestão (${source})`;
}

/** What the review row says about an item besides its fields: warnings, installment, origin. */
export function itemNotes(item: Item): string {
  const notes = [...item.warnings];
  if (item.installment) notes.push(`parcela ${item.installment[0]}/${item.installment[1]}`);
  if (item.foreign_amount !== null)
    notes.push(`${item.foreign_currency ?? ""} ${item.foreign_amount.toString()}`.trim());
  if (item.card_last4) notes.push(`cartão final ${item.card_last4}`);
  if (item.suggestion_source) notes.push(sourceLabel(item.suggestion_source));
  if (item.status === ItemStatus.DUPLICATE) notes.push("já existe no livro: aprovar só vincula a evidência");
  return notes.join("; ");
}

/** Waiting for the user's decision: validated and ready, or with something to check. */
export const isPending = (item: Item): boolean =>
  item.status === ItemStatus.READY || item.status === ItemStatus.NEEDS_REVIEW;

/** Items the approval still acts on (a duplicate is approved by linking its evidence). */
export const isOpen = (item: Item): boolean => isPending(item) || item.status === ItemStatus.DUPLICATE;

// ── the queue ───────────────────────────────────────

export type TotalCheck = "ok" | "divergent" | "incomparable" | "none";

export function totalCheck(batch: Batch): TotalCheck {
  if (!batch.reconciliations.length) return "none";
  if (batch.reconciliations.every((r) => r.ok === true)) return "ok";
  return batch.reconciliations.some((r) => r.ok === false) ? "divergent" : "incomparable";
}

export interface BatchRow {
  id: Id;
  name: string;
  institution: string;
  state: string;
  status: Batch["status"];
  items: number;
  pending: number;
}

export function batchRows(ledger: Ledger, documents: readonly session.Document[]): BatchRow[] {
  const names = new Map(documents.map((d) => [d.meta.id, d.meta.original_name]));
  return [...importing.pipeline.batches(ledger).values()]
    .sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0))
    .map((batch) => {
      const items = importing.pipeline.itemsOf(ledger, batch.id);
      return {
        id: batch.id,
        name: names.get(batch.document_id) ?? "Documento",
        institution: batch.header.institution ?? "—",
        state: STATUS_LABELS[batch.status] + (totalCheck(batch) === "divergent" ? " · total divergente" : ""),
        status: batch.status,
        items: items.length,
        pending: items.filter(isPending).length,
      };
    });
}

/** The count of items waiting for review in every document ("3 documento(s) · 12 item(ns) aguardando revisão"). */
export function waitingItems(ledger: Ledger): number {
  return [...importing.pipeline.items(ledger).values()].filter(isPending).length;
}

export function queueContext(rows: readonly BatchRow[], waiting: number): string {
  if (!rows.length) return "";
  return `${rows.length} documento(s) · ${waiting} item(ns) aguardando revisão`;
}

// ── the facts of a document ─────────────────────────

export interface Verdict {
  label: string;
  expected: string;
  computed: string;
  /** In words; the tone only reinforces it. */
  verdict: "confere" | "diverge" | "não comparável";
  tone: "positive" | "negative" | "neutral";
}

export function verdicts(batch: Batch): Verdict[] {
  return batch.reconciliations.map((r) => ({
    label: r.label,
    expected: moneyOr(r.expected),
    computed: moneyOr(r.computed),
    verdict: r.ok === true ? "confere" : r.ok === false ? "diverge" : "não comparável",
    tone: r.ok === true ? "positive" : r.ok === false ? "negative" : "neutral",
  }));
}

/** One line of facts: institution, state, layout, due date, totals and period. */
export function factsLine(batch: Batch): string {
  const h = batch.header;
  const parts = [h.institution || "Instituição não identificada", STATUS_LABELS[batch.status]];
  if (batch.parser_id) parts.push(`layout ${batch.parser_id} v${batch.parser_version ?? ""}`);
  if (h.due_on) parts.push(`vencimento ${dateOr(h.due_on)}`);
  if (h.total !== null) parts.push(`total ${moneyOr(h.total)}`);
  if (h.period_start || h.period_end) parts.push(`período ${dateOr(h.period_start)} a ${dateOr(h.period_end)}`);
  if (h.net_amount !== null) parts.push(`líquido ${moneyOr(h.net_amount)}`);
  return parts.join(" · ");
}

/** A batch that needs the user to pick a layout. */
export const needsLayout = (batch: Batch): boolean =>
  batch.status === BatchStatus.AMBIGUOUS || batch.status === BatchStatus.UNSUPPORTED;

// ── the items ───────────────────────────────────────

export interface ItemRow {
  id: Id;
  item: Item;
  status: string;
  date: IsoDate | null;
  description: string;
  kind: string;
  amount: Dec | null;
  targetId: Id | null;
  targetName: string;
  notes: string;
  /** A category or counterpart can still be chosen. */
  editable: boolean;
}

export function itemRows(ledger: Ledger, batchId: Id): ItemRow[] {
  const items = [...importing.pipeline.itemsOf(ledger, batchId)].sort((a, b) => {
    if ((a.occurred_on === null) !== (b.occurred_on === null)) return a.occurred_on === null ? 1 : -1;
    return a.occurred_on === b.occurred_on ? 0 : (a.occurred_on ?? "") < (b.occurred_on ?? "") ? -1 : 1;
  });
  return items.map((item) => {
    const target = item.target_account_id ? ledger.accounts.get(item.target_account_id) : undefined;
    return {
      id: item.id,
      item,
      status: ITEM_STATUS_LABELS[item.status],
      date: item.occurred_on,
      description: item.description,
      kind: KIND_LABELS[item.kind],
      amount: item.amount,
      targetId: item.target_account_id,
      targetName: target ? target.name : "—",
      notes: itemNotes(item),
      editable: isPending(item) && item.kind !== ItemKind.TRADE && item.kind !== ItemKind.FEE,
    };
  });
}

/** The default option of an item's selector: the category the desktop calls "(padrão)". */
export const DEFAULT_TARGET = "__default";

/** The categories and counterpart accounts an item of this kind can go to (desktop `_install_target_editors`). */
export function targetOptions(ledger: Ledger, kind: Item["kind"]): SelectOption[] {
  const expense = categoryItems(ledger, AccountType.EXPENSE);
  const income = categoryItems(ledger, AccountType.INCOME);
  const balance = [...ledger.accounts.values()]
    .filter((a) => a.type === AccountType.ASSET || a.type === AccountType.LIABILITY)
    .sort((a, b) => a.name.localeCompare(b.name, "pt-BR"))
    .map((a) => ({ id: a.id, label: `↔ ${a.name}` }));
  const choices =
    kind === ItemKind.CREDIT
      ? [...income, ...balance]
      : kind === ItemKind.DEBIT
        ? [...expense, ...balance]
        : kind === ItemKind.CARD_PAYMENT
          ? balance
          : expense;
  return [{ id: DEFAULT_TARGET, label: "(padrão)" }, ...choices];
}

// ── the evidence ────────────────────────────────────

export interface EvidenceView {
  /** A PDF item: the page and the box in PDF points. */
  page: number | null;
  box: readonly [number, number, number, number] | null;
  /** A structured file: the line of the file and its text. */
  line: number | null;
  text: string;
}

/** The first evidence of an item (what the desktop shows beside the review), or null when it has none. */
export function evidenceOf(ledger: Ledger, item: Item): EvidenceView | null {
  const id = item.evidence_ids[0];
  const found: Evidence | undefined = id ? importing.pipeline.evidence(ledger).get(id) : undefined;
  if (!found) return null;
  return { page: found.page, box: found.bbox, line: found.line, text: found.text };
}

/** An evidence box as percentages of the page, to draw over it at any size. */
export function boxStyle(
  box: readonly [number, number, number, number],
  page: { width: number; height: number },
): { left: string; top: string; width: string; height: string } {
  const [x0, top, x1, bottom] = box;
  const pad = 2; // a little air around the text, in points
  const left = Math.max(0, x0 - pad);
  const upper = Math.max(0, top - pad);
  const right = Math.min(page.width, x1 + pad);
  const lower = Math.min(page.height, bottom + pad);
  const pct = (value: number, of: number) => `${((100 * value) / of).toFixed(3)}%`;
  return {
    left: pct(left, page.width),
    top: pct(upper, page.height),
    width: pct(Math.max(0, right - left), page.width),
    height: pct(Math.max(0, lower - upper), page.height),
  };
}
