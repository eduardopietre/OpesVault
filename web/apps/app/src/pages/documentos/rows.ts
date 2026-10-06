/**
 * Documentos without React (desktop `DocumentsPage.refresh`): one row per stored file, with when it is from,
 * which account or card it belongs to, its situation and what uses it.
 */
import { cashDate, dom, importing, type Id, type IsoDate, type Ledger, type session } from "@opesvault/domain";

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

/** Bytes as people read them: "840 bytes", "12 KB", "3,4 MB" (decimal comma). */
export function fileSize(size: number): string {
  if (size < 1024) return `${size} bytes`;
  for (const [unit, scale] of [
    ["KB", 1024],
    ["MB", 1024 ** 2],
    ["GB", 1024 ** 3],
  ] as const) {
    const value = size / scale;
    if (value < 1024 || unit === "GB") {
      return `${value >= 10 ? value.toFixed(0) : value.toFixed(1).replace(".", ",")} ${unit}`;
    }
  }
  return `${size} bytes`;
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

/** The line under the title: how many files and how much room they take. */
export function summaryLine(rows: readonly DocumentRow[]): string {
  if (!rows.length) return "";
  return `${rows.length} arquivo(s) · ${fileSize(rows.reduce((total, row) => total + row.size, 0))}`;
}

/** What uses a file, in words, for the tooltip of a disabled "Remover". */
export function usedBy(row: DocumentRow): string {
  const parts: string[] = [];
  if (row.batchId) parts.push("uma importação");
  if (row.receipts.length) parts.push(`${row.receipts.length} lançamento(s) como comprovante`);
  return parts.join(" e ");
}
