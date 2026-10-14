/**
 * Documentos without React (desktop `DocumentsPage.refresh`): one row per stored file, with when it is from,
 * which account or card it belongs to, its situation and what uses it.
 */
import {
  cashDate,
  dom,
  importing,
  type Id,
  type IsoDate,
  type Ledger,
  type YearMonth,
  type session,
} from "@opesvault/domain";
import { formatBytes } from "@opesvault/ui";
import { plural } from "../../data/text.ts";

type Document = session.Document;

const BATCH_STATUS_LABELS: Readonly<Record<string, string>> = {
  unsupported: "Não suportado",
  ambiguous: "Escolher layout",
  in_review: "Em revisão",
  partial: "Parcial",
  approved: "Aprovado",
  rejected: "Rejeitado",
};

/** An operation that has the document as its receipt. */
export interface ReceiptUse {
  /** The link between the operation and the document (what "Desvincular" removes). */
  attachmentId: Id;
  operationId: Id;
  description: string;
  date: IsoDate | null;
}

export interface DocumentRow {
  id: Id;
  name: string;
  size: number;
  sha256: string;
  date: IsoDate | null;
  where: string;
  state: string;
  /** The import this file was read for (opens in Importar). */
  batchId: Id | null;
  batchStatus: string | null;
  /** The operations it is a receipt of (open in the Livro). */
  receipts: ReceiptUse[];
  /** Nothing uses it: it can be removed. */
  free: boolean;
}

export function documentRows(ledger: Ledger, documents: readonly Document[]): DocumentRow[] {
  const batches = new Map([...importing.importStore.batches(ledger).values()].map((b) => [b.document_id, b]));
  return documents.map((d): DocumentRow => {
    const batch = batches.get(d.meta.id) ?? null;
    const receipts = dom.attachments.ofDocument(ledger, d.meta.id).flatMap((a): ReceiptUse[] => {
      const op = ledger.operations.get(a.operation_id);
      return op
        ? [
            {
              attachmentId: a.id,
              operationId: op.id,
              description: op.description,
              date: op.occurred_on ?? cashDate(op),
            },
          ]
        : [];
    });
    let date: IsoDate | null = null;
    let where = "—";
    let state = "Sem importação";
    if (batch) {
      date = batch.header.due_on ?? batch.header.period_end ?? (batch.created_at.slice(0, 10) as IsoDate);
      const card = batch.card_id ? ledger.cards.get(batch.card_id) : undefined;
      const account = batch.account_id ? ledger.accounts.get(batch.account_id) : undefined;
      where = card?.name ?? account?.name ?? "—";
      state = BATCH_STATUS_LABELS[batch.status] ?? "—";
    } else if (receipts.length) {
      const first = receipts[0]!;
      date = first.date;
      where = first.description;
      state = receipts.length > 1 ? `Comprovante de ${receipts.length} lançamentos` : "Comprovante";
    }
    return {
      id: d.meta.id,
      name: d.meta.original_name,
      size: d.meta.size,
      sha256: d.meta.sha256,
      date,
      where,
      state,
      batchId: batch?.id ?? null,
      batchStatus: batch ? (BATCH_STATUS_LABELS[batch.status] ?? null) : null,
      receipts,
      free: batch === null && receipts.length === 0,
    };
  });
}

/** What a file is, for the type filter. */
export type FileType = "pdf" | "image" | "other";

export const FILE_TYPE_LABELS: Readonly<Record<FileType, string>> = { pdf: "PDF", image: "Imagem", other: "Outro" };

/**
 * A file's type from its name. Only a label for the list: the bytes are fetched and decrypted when a document is
 * opened, never to filter, and the viewer still recognizes the content by its first bytes.
 */
export function fileType(name: string): FileType {
  const extension = /\.([a-z0-9]+)$/i.exec(name.trim())?.[1]?.toLowerCase() ?? "";
  if (extension === "pdf") return "pdf";
  if (["png", "jpg", "jpeg", "gif", "webp", "heic", "heif", "bmp", "tif", "tiff"].includes(extension)) return "image";
  return "other";
}

/** The text a document is found by in the search box. */
export function documentSearchText(row: DocumentRow): string {
  return [row.name, row.where, row.state, ...row.receipts.map((use) => use.description)].join(" ");
}

/** When a document is from, for the date filter: any date, one month or a range of days (either end open). */
export type DateFilter =
  { kind: "any" } | { kind: "month"; month: YearMonth } | { kind: "range"; from: IsoDate | null; to: IsoDate | null };

export interface DocumentFilter {
  type: FileType | null;
  date: DateFilter;
}

export const NO_FILTER: DocumentFilter = { type: null, date: { kind: "any" } };

/** Whether the filter narrows anything (a range with neither end keeps every row). */
export function filterActive(filter: DocumentFilter): boolean {
  const { date } = filter;
  return (
    filter.type !== null || date.kind === "month" || (date.kind === "range" && (date.from !== null || date.to !== null))
  );
}

/** Whether a document passes the type and date filter; a document without a date passes only "any date". */
export function keepsDocument(row: DocumentRow, filter: DocumentFilter): boolean {
  if (filter.type !== null && fileType(row.name) !== filter.type) return false;
  const { date } = filter;
  if (date.kind === "any") return true;
  if (row.date === null) return date.kind === "range" && date.from === null && date.to === null;
  if (date.kind === "month") {
    const prefix = `${date.month.year}-${String(date.month.month).padStart(2, "0")}-`;
    return row.date.startsWith(prefix);
  }
  return (date.from === null || row.date >= date.from) && (date.to === null || row.date <= date.to);
}

/** The line under the title: how many files and how much room they take. */
export function summaryLine(rows: readonly DocumentRow[]): string {
  if (!rows.length) return "";
  return `${plural(rows.length, "arquivo", "arquivos")} · ${formatBytes(rows.reduce((total, row) => total + row.size, 0))}`;
}

/** What uses a file, in words, for the tooltip of a disabled "Remover". */
export function usedBy(row: DocumentRow): string {
  const parts: string[] = [];
  if (row.batchId) parts.push("uma importação");
  if (row.receipts.length) parts.push(`${plural(row.receipts.length, "lançamento", "lançamentos")} como comprovante`);
  return parts.join(" e ");
}
