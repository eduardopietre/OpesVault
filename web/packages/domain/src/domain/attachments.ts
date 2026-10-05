/**
 * Receipts attached to any operation, kept encrypted in the project like imported documents
 * (docs/09 §1.3 A). Port of `domain/attachments.py`.
 *
 * The file itself is a project document (`Session.addDocument`); the link is an entity beside the
 * operation, so attaching a receipt to an operation of a closed month is allowed and never
 * changes a figure. Only PDF and images are accepted, recognized by their content, not their
 * name; nothing is written anywhere unencrypted.
 */
import { z } from "zod";

import type { Id } from "../lib/ids.ts";
import { zId } from "../lib/schema.ts";
import { batches } from "../importing/store.ts";
import { type Session, sha256Hex } from "../session.ts";
import { DomainError, Ledger } from "./ledger.ts";
import { zEntityId } from "./model.ts";

export const MAX_BYTES = 25 * 1024 * 1024;
export const KINDS: readonly (readonly [Uint8Array, string])[] = [
  [new TextEncoder().encode("%PDF-"), "pdf"],
  [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), "png"],
  [new Uint8Array([0xff, 0xd8, 0xff]), "jpeg"],
];

export const AttachmentSchema = z.strictObject({
  id: zEntityId,
  operation_id: zId,
  document_id: zId,
});
export type Attachment = Readonly<z.output<typeof AttachmentSchema>>;

Ledger.registerKind("attachment", AttachmentSchema);

export function attachments(ledger: Ledger) {
  return ledger.entities<Attachment>("attachment");
}

function startsWith(data: Uint8Array, magic: Uint8Array): boolean {
  return data.length >= magic.length && magic.every((b, i) => data[i] === b);
}

/** 'pdf', 'png' or 'jpeg' from the first bytes; null for anything else. */
export function kindOf(data: Uint8Array): string | null {
  return KINDS.find(([magic]) => startsWith(data, magic))?.[1] ?? null;
}

export function ofOperation(ledger: Ledger, operationId: Id): Attachment[] {
  return [...attachments(ledger).values()].filter((a) => a.operation_id === operationId);
}

export function ofDocument(ledger: Ledger, documentId: Id): Attachment[] {
  return [...attachments(ledger).values()].filter((a) => a.document_id === documentId);
}

export function attach(session: Session, operationId: Id, originalName: string, data: Uint8Array): Attachment {
  const ledger = session.ledger;
  if (!ledger.operations.has(operationId)) throw new DomainError("Operação inexistente.");
  if (kindOf(data) === null) throw new DomainError("Anexe um PDF ou uma imagem (PNG ou JPEG).");
  if (data.length > MAX_BYTES) throw new DomainError("O arquivo passa de 25 MB.");
  const existing = session.findDocumentByHash(sha256Hex(data));
  const document = existing !== null ? existing : session.addDocument(originalName, data);
  if (ofOperation(ledger, operationId).some((a) => a.document_id === document.meta.id)) {
    throw new DomainError("Este comprovante já está anexado a este lançamento.");
  }
  return ledger.put("attachment", AttachmentSchema.parse({ operation_id: operationId, document_id: document.meta.id }));
}

/** Removes the link; the file leaves the project when nothing else uses it. */
export function detach(session: Session, attachmentId: Id): void {
  const ledger = session.ledger;
  const found = attachments(ledger).get(attachmentId);
  if (found === undefined) return;
  attachments(ledger).delete(attachmentId);
  const stillUsed =
    ofDocument(ledger, found.document_id).length > 0 ||
    [...batches(ledger).values()].some((b) => b.document_id === found.document_id);
  if (!stillUsed) session.removeDocument(found.document_id);
}
