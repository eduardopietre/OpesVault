/**
 * The open project as the screens see it: the domain Session (Ledger + documents), undo/redo and the
 * sync of what changed.
 *
 * Every user action goes through `act()`: the domain call runs, its changes become one undo step and
 * the changed records are handed to the sink (the encrypted vault, or nothing in the fake services).
 * Documents (PDFs and other originals) travel apart: their bytes become an encrypted blob and their
 * metadata a `document` record; on opening, only the metadata is read and the bytes are fetched when a
 * screen needs them (`loadDocument`). A failing action leaves no partial change behind.
 */
import {
  DomainError,
  type IsoDate,
  type Ledger,
  type LedgerRecord,
  type UndoStack,
  newId,
  session as sessions,
  today as localToday,
} from "@opesvault/domain";

type Session = sessions.Session;
type Document = sessions.Document;
type DocumentMeta = sessions.DocumentMeta;

export interface PlainRecordLike {
  readonly kind: string;
  readonly id: string;
  readonly payload: unknown;
}

/** Where changed records and document bytes go. The vault encrypts them before they leave the tab. */
export interface RecordSink {
  stage(upserts: readonly PlainRecordLike[], deletes: readonly { kind: string; id: string }[]): Promise<void> | void;
  putBlob?(data: Uint8Array): Promise<string>;
  getBlob?(blobId: string): Promise<Uint8Array>;
  deleteBlob?(blobId: string): Promise<void>;
}

/** Record kind holding a document's metadata (the bytes are a blob). */
export const DOCUMENT_KIND = "document";

interface DocumentRecord extends DocumentMeta {
  readonly blob_id: string;
}

export class ReadOnlyError extends DomainError {
  constructor() {
    super("Este projeto está aberto só para leitura: outra aba ou aparelho está editando.");
    this.name = "ReadOnlyError";
  }
}

export class DocumentUnavailable extends DomainError {
  constructor() {
    super("O documento original ainda não foi baixado. Abra-o de novo com a conexão disponível.");
    this.name = "DocumentUnavailable";
  }
}

export interface WorkspaceOptions {
  readonly sink?: RecordSink | null;
  readonly readOnly?: boolean;
  /** The family's calendar date; the browser's local date by default. */
  readonly today?: () => IsoDate;
}

/** A document whose bytes are fetched on demand: reading `data` before `loadDocument` is an error. */
function lazyDocument(meta: DocumentMeta, holder: Map<string, Uint8Array>): Document {
  return {
    meta,
    get data(): Uint8Array {
      const bytes = holder.get(meta.id);
      if (bytes === undefined) throw new DocumentUnavailable();
      return bytes;
    },
  };
}

function splitRecords(records: Iterable<PlainRecordLike>): { ledger: LedgerRecord[]; documents: DocumentRecord[] } {
  const ledger: LedgerRecord[] = [];
  const documents: DocumentRecord[] = [];
  for (const r of records) {
    if (r.kind === DOCUMENT_KIND) documents.push(r.payload as DocumentRecord);
    else ledger.push({ id: r.id, kind: r.kind, payload: r.payload as Record<string, unknown> });
  }
  return { ledger, documents };
}

export class Workspace {
  #session: Session;
  #version = 0;
  #readOnly: boolean;
  readonly #sink: RecordSink | null;
  readonly #today: () => IsoDate;
  readonly #listeners = new Set<() => void>();
  #pendingStage: Promise<void> = Promise.resolve();
  /** Bytes of documents known in this tab (loaded on demand or added here). */
  readonly #bytes: Map<string, Uint8Array>;
  /** Blob id of each synced document. */
  readonly #blobOf = new Map<string, string>();
  /** Documents added here whose bytes could not be uploaded yet (offline, no lease). */
  readonly #unsent = new Map<string, Document>();
  /** A failure of the last hand-over to the vault (shown by the sync state). */
  stageError: unknown = null;

  constructor(session: Session, options: WorkspaceOptions = {}, bytes: Map<string, Uint8Array> = new Map()) {
    this.#session = session;
    this.#bytes = bytes;
    this.#sink = options.sink ?? null;
    this.#readOnly = options.readOnly ?? false;
    this.#today = options.today ?? (() => localToday());
    for (const d of session.documents) {
      try {
        this.#bytes.set(d.meta.id, d.data);
      } catch {
        // lazy document: fetched on demand
      }
    }
    session.undoStack(); // journaling starts now: what was loaded is not an edit
  }

  /** Builds the workspace from the records in the vault (an empty vault starts a new project). */
  static fromRecords(records: Iterable<PlainRecordLike>, name: string, options: WorkspaceOptions = {}): Workspace {
    const { ledger, documents } = splitRecords(records);
    const bytes = new Map<string, Uint8Array>();
    let session: Session;
    if (ledger.length === 0) {
      session = sessions.Session.new(name, newId());
    } else {
      const docs = documents.map((d) =>
        lazyDocument({ id: d.id, sha256: d.sha256, original_name: d.original_name, size: d.size }, bytes),
      );
      session = sessions.Session.fromRecords(newId(), ledger, docs);
    }
    // The lazy documents read their bytes from the workspace's map.
    const workspace = new Workspace(session, options, bytes);
    for (const d of documents) workspace.#blobOf.set(d.id, d.blob_id);
    // A new project, or one migrated in memory, sends every record once.
    if (session.forceFullSync || session.ledger.migratedFrom !== null) workspace.#flush();
    return workspace;
  }

  #setBytes(id: string, data: Uint8Array): void {
    this.#bytes.set(id, data);
  }

  get session(): Session {
    return this.#session;
  }

  get ledger(): Ledger {
    return this.#session.ledger;
  }

  get readOnly(): boolean {
    return this.#readOnly;
  }

  get undoStack(): UndoStack {
    return this.#session.undoStack();
  }

  today(): IsoDate {
    return this.#today();
  }

  // ── observation (useSyncExternalStore) ──────────────

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  getVersion = (): number => this.#version;

  #changed(): void {
    this.#version += 1;
    for (const listener of [...this.#listeners]) listener();
  }

  // ── actions ─────────────────────────────────────────

  /** Runs one user action on the project: one undo step, synced, observed. */
  act<T>(action: (ledger: Ledger, session: Session) => T): T {
    if (this.#readOnly) throw new ReadOnlyError();
    const journal = this.undoStack.journal;
    const mark = journal.length;
    let result: T;
    try {
      result = action(this.#session.ledger, this.#session);
    } catch (error) {
      // Put back whatever the failed action wrote before failing.
      const partial = journal.splice(mark);
      if (partial.length) this.#session.ledger.revert(partial);
      throw error;
    }
    this.undoStack.seal();
    this.#flush();
    this.#changed();
    return result;
  }

  undo(): string | null {
    if (this.#readOnly) throw new ReadOnlyError();
    const step = this.undoStack.undo();
    if (!step) return null;
    this.#flush();
    this.#changed();
    return step.label;
  }

  redo(): string | null {
    if (this.#readOnly) throw new ReadOnlyError();
    const step = this.undoStack.redo();
    if (!step) return null;
    this.#flush();
    this.#changed();
    return step.label;
  }

  /** Who is recorded in the history for the next changes (the operator picked in the top bar). */
  setOperator(name: string | null): void {
    this.#session.ledger.operator = name;
  }

  // ── documents ───────────────────────────────────────

  /** True when the document's bytes are in this tab. */
  hasDocument(documentId: string): boolean {
    return this.#bytes.has(documentId);
  }

  /** Fetches and decrypts a document's bytes (once); afterwards `session.document(id).data` works. */
  async loadDocument(documentId: string): Promise<Uint8Array> {
    const cached = this.#bytes.get(documentId);
    if (cached !== undefined) return cached;
    const blobId = this.#blobOf.get(documentId);
    if (blobId === undefined || !this.#sink?.getBlob) throw new DocumentUnavailable();
    const data = await this.#sink.getBlob(blobId);
    const meta = this.#session.documents.find((d) => d.meta.id === documentId)?.meta;
    if (meta && sessions.sha256Hex(data) !== meta.sha256) throw new DomainError("O documento baixado não confere.");
    this.#setBytes(documentId, data);
    return data;
  }

  // ── sync ────────────────────────────────────────────

  /** Hands what changed since the last hand-over to the vault. */
  #flush(): void {
    const sent = this.#session.pendingSync();
    this.#session.markSynced(sent);
    const upserts: PlainRecordLike[] = sent.upserts.map((r) => ({ kind: r.kind, id: r.id, payload: r.payload }));
    const deletes = sent.deletes.map((d) => ({ kind: d.kind, id: d.id }));
    for (const d of sent.documentsAdded) {
      this.#setBytes(d.meta.id, d.data);
      if (!this.#blobOf.has(d.meta.id)) this.#unsent.set(d.meta.id, d);
    }
    const removed: string[] = [];
    for (const id of sent.documentsRemoved) {
      this.#unsent.delete(id);
      const blob = this.#blobOf.get(id);
      if (blob !== undefined) removed.push(blob);
      this.#blobOf.delete(id);
      deletes.push({ kind: DOCUMENT_KIND, id });
    }
    if (!this.#sink) return;
    const sink = this.#sink;
    // Hand-overs stay in order; a failure is kept for the sync state, the data is still in memory.
    this.#pendingStage = this.#pendingStage
      .then(async () => {
        await sink.stage(upserts, deletes);
        await this.#uploadUnsent();
        if (sink.deleteBlob) for (const blob of removed) await sink.deleteBlob(blob).catch(() => undefined);
      })
      .then(
        () => {
          if (this.stageError !== null) {
            this.stageError = null;
            this.#changed();
          }
        },
        (error: unknown) => {
          this.stageError = error;
          this.#changed();
        },
      );
  }

  /** Uploads documents added here; their metadata record is staged only once the bytes are stored. */
  async #uploadUnsent(): Promise<void> {
    const sink = this.#sink;
    if (!sink?.putBlob) {
      this.#unsent.clear();
      return;
    }
    for (const [id, document] of [...this.#unsent]) {
      const blobId = await sink.putBlob(document.data);
      this.#blobOf.set(id, blobId);
      this.#unsent.delete(id);
      const record: DocumentRecord = { ...document.meta, blob_id: blobId };
      await sink.stage([{ kind: DOCUMENT_KIND, id, payload: record }], []);
    }
  }

  /** Documents whose bytes are only in this tab (not uploaded yet). */
  get unsentDocuments(): number {
    return this.#unsent.size;
  }

  /** Tries again to upload documents that could not be sent (called when the network returns). */
  retryUploads(): void {
    if (!this.#unsent.size || !this.#sink) return;
    this.#pendingStage = this.#pendingStage
      .then(() => this.#uploadUnsent())
      .then(
        () => {
          this.stageError = null;
          this.#changed();
        },
        (error: unknown) => {
          this.stageError = error;
          this.#changed();
        },
      );
  }

  /** Resolves when every change so far has been handed to the vault (tests, closing). */
  settled(): Promise<void> {
    return this.#pendingStage;
  }

  /**
   * Someone else changed the project (this tab is read-only, or took over the edit): the session is
   * rebuilt from the vault's records. Undo history of this tab no longer applies.
   */
  reload(records: Iterable<PlainRecordLike>, readOnly: boolean): void {
    const { ledger, documents } = splitRecords(records);
    if (ledger.length) {
      const operator = this.#session.ledger.operator;
      const docs = documents.map((d) =>
        lazyDocument({ id: d.id, sha256: d.sha256, original_name: d.original_name, size: d.size }, this.#bytes),
      );
      this.#session = sessions.Session.fromRecords(this.#session.projectId, ledger, docs);
      this.#session.ledger.operator = operator;
      this.#session.undoStack();
      for (const d of documents) this.#blobOf.set(d.id, d.blob_id);
    }
    this.#readOnly = readOnly;
    this.#changed();
  }

  setReadOnly(readOnly: boolean): void {
    if (this.#readOnly === readOnly) return;
    this.#readOnly = readOnly;
    this.#changed();
  }
}
