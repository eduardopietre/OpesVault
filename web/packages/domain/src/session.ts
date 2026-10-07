/**
 * In-memory editing session of one open project (docs/03 §5, docs/18 §3.3). Port of `session.py`.
 *
 * The desktop froze snapshots for the SQLCipher worker; the web syncs encrypted records
 * instead. What a sync needs is exposed here: the ledger's pending records and the documents
 * added or removed since the last sync (`pendingSync`), then `markSynced` with what was sent.
 * Edits made while a sync runs stay pending (docs/03 §5).
 *
 * Documents keep their bytes in memory with a SHA-256; there is no file path, the project has
 * an id. Adding and removing documents is journaled, so undo puts them back exactly like the
 * desktop.
 */
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";

import { Ledger, type LedgerRecord } from "./domain/ledger.ts";
import { type Id, newId } from "./lib/ids.ts";
import { KeyError } from "./lib/py.ts";
import { UndoStack } from "./undo.ts";

export interface DocumentMeta {
  readonly id: Id;
  readonly sha256: string; // lowercase hex
  readonly original_name: string;
  readonly size: number;
}

/** Document metadata plus its original bytes, kept only in memory. */
export interface Document {
  readonly meta: DocumentMeta;
  readonly data: Uint8Array;
}

export function sha256Hex(data: Uint8Array): string {
  return bytesToHex(sha256(data));
}

export function documentFromBytes(originalName: string, data: Uint8Array): Document {
  return {
    meta: { id: newId(), sha256: sha256Hex(data), original_name: originalName, size: data.length },
    data,
  };
}

export function verifyDocument(document: Document): boolean {
  return document.data.length === document.meta.size && sha256Hex(document.data) === document.meta.sha256;
}

/** Python's `KeyError` for a document id that is not in the session. */
export class DocumentNotFound extends KeyError {}

/** What one sync sends, tagged with the edit it reflects (the web's `FrozenSnapshot`). */
export interface PendingSync {
  readonly editSeq: number;
  readonly ledgerSeq: number;
  /** Every record (new or migrated project, or a forced full sync) instead of only the changes. */
  readonly full: boolean;
  readonly upserts: readonly LedgerRecord[];
  readonly deletes: readonly { readonly kind: string; readonly id: Id }[];
  readonly documentsAdded: readonly Document[];
  readonly documentsRemoved: readonly Id[];
}

export class Session {
  readonly projectId: Id;
  ledger: Ledger;
  documents: Document[];
  /** Set when the project was never synced or must be sent whole. */
  forceFullSync: boolean;
  private docChanges = 0;
  private savedSeq = 0;
  private readonly docsAdded = new Set<Id>();
  private readonly docsRemoved = new Set<Id>();
  private undo: UndoStack | null = null;

  constructor(projectId: Id, ledger: Ledger, documents: Document[] = [], forceFullSync = false) {
    this.projectId = projectId;
    this.ledger = ledger;
    this.documents = documents;
    this.forceFullSync = forceFullSync;
  }

  /** A never-synced project starts dirty: creating the chart of accounts counts as edits. */
  static new(familyName = "Projeto", projectId: Id = newId()): Session {
    return new Session(projectId, Ledger.new(familyName), [], true);
  }

  /** A project opened from its decrypted records and documents. */
  static fromRecords(projectId: Id, records: Iterable<LedgerRecord>, documents: Document[] = []): Session {
    return new Session(projectId, Ledger.fromRecords(records), [...documents]);
  }

  private get editSeq(): number {
    return this.ledger.changeCount + this.docChanges;
  }

  get dirty(): boolean {
    return this.editSeq !== this.savedSeq;
  }

  /** Created on first use; journaling starts then, so loading never fills it. */
  undoStack(): UndoStack {
    this.undo ??= new UndoStack(() => this.ledger);
    return this.undo;
  }

  addDocument(originalName: string, data: Uint8Array): Document {
    const document = documentFromBytes(originalName, data);
    this.insertDocument(document);
    this.ledger.journalAdd(["external", (forward) => this.redoAdd(document, forward)]);
    return document;
  }

  removeDocument(documentId: Id): void {
    const document = this.documents.find((d) => d.meta.id === documentId);
    this.dropDocument(documentId);
    if (document !== undefined) this.ledger.journalAdd(["external", (forward) => this.redoAdd(document, !forward)]);
  }

  private insertDocument(document: Document): void {
    this.documents.push(document);
    if (this.docsRemoved.has(document.meta.id))
      this.docsRemoved.delete(document.meta.id); // removed and put back before a sync
    else this.docsAdded.add(document.meta.id);
    this.docChanges += 1;
  }

  private dropDocument(documentId: Id): void {
    this.documents = this.documents.filter((d) => d.meta.id !== documentId);
    if (this.docsAdded.has(documentId)) this.docsAdded.delete(documentId);
    else this.docsRemoved.add(documentId);
    this.docChanges += 1;
  }

  /** Undo/redo of a document: present=true puts it back, false takes it out. */
  private redoAdd(document: Document, present: boolean): void {
    if (present) this.insertDocument(document);
    else this.dropDocument(document.meta.id);
  }

  document(documentId: Id): Document {
    const found = this.documents.find((d) => d.meta.id === documentId);
    if (found === undefined) throw new DocumentNotFound(documentId);
    return found;
  }

  findDocumentByHash(hash: string): Document | null {
    return this.documents.find((d) => d.meta.sha256 === hash) ?? null;
  }

  /** Documents added and removed since the last sync. */
  documentChanges(): { added: Id[]; removed: Id[] } {
    return { added: [...this.docsAdded], removed: [...this.docsRemoved] };
  }

  /** What the next sync must send (the desktop's `freeze`). */
  pendingSync(): PendingSync {
    const full = this.forceFullSync || this.ledger.migratedFrom !== null;
    const upserts: LedgerRecord[] = [];
    const deletes: { kind: string; id: Id }[] = [];
    if (full) upserts.push(...this.ledger.toRecords());
    else {
      for (const { kind, id } of this.ledger.dirtyKeys()) {
        const payload = this.ledger.recordFor(kind, id);
        if (payload === null) deletes.push({ kind, id });
        else upserts.push({ id, kind, payload });
      }
    }
    return {
      editSeq: this.editSeq,
      ledgerSeq: this.ledger.changeCount,
      full,
      upserts,
      deletes,
      documentsAdded: full ? [...this.documents] : this.documents.filter((d) => this.docsAdded.has(d.meta.id)),
      documentsRemoved: [...this.docsRemoved],
    };
  }

  /** Edits made after `pendingSync()` stay pending (docs/03 §5). */
  markSynced(sent: PendingSync): void {
    this.savedSeq = sent.editSeq;
    this.ledger.markClean(sent.ledgerSeq);
    for (const d of sent.documentsAdded) this.docsAdded.delete(d.meta.id);
    for (const id of sent.documentsRemoved) this.docsRemoved.delete(id);
    if (sent.full) {
      this.ledger.migratedFrom = null;
      this.forceFullSync = false;
    }
  }
}
