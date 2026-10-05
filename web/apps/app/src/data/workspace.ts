/**
 * The open project as the screens see it: the domain Ledger, undo/redo and the sync of what changed.
 *
 * Every user action goes through `act()`: the domain call runs, its changes become one undo step and
 * the changed records are handed to the sink (the encrypted vault, or nothing in the fake services).
 * Screens read the ledger and re-render on `version` (useSyncExternalStore). A failing action leaves no
 * partial change behind: whatever it wrote before failing is reverted.
 */
import {
  DomainError,
  Ledger,
  type IsoDate,
  type LedgerRecord,
  UndoStack,
  today as localToday,
} from "@opesvault/domain";

export interface PlainRecordLike {
  readonly kind: string;
  readonly id: string;
  readonly payload: unknown;
}

/** Where changed records go. The vault encrypts them at once and pushes them shortly after. */
export interface RecordSink {
  stage(upserts: readonly PlainRecordLike[], deletes: readonly { kind: string; id: string }[]): Promise<void> | void;
}

export class ReadOnlyError extends DomainError {
  constructor() {
    super("Este projeto está aberto só para leitura: outra aba ou aparelho está editando.");
    this.name = "ReadOnlyError";
  }
}

export interface WorkspaceOptions {
  readonly sink?: RecordSink | null;
  readonly readOnly?: boolean;
  /** The family's calendar date; the browser's local date by default. */
  readonly today?: () => IsoDate;
}

export class Workspace {
  #ledger: Ledger;
  #undo: UndoStack;
  #version = 0;
  #readOnly: boolean;
  readonly #sink: RecordSink | null;
  readonly #today: () => IsoDate;
  readonly #listeners = new Set<() => void>();
  #pendingStage: Promise<void> = Promise.resolve();
  /** A failure of the last hand-over to the vault (shown by the sync state). */
  stageError: unknown = null;

  constructor(ledger: Ledger, options: WorkspaceOptions = {}) {
    this.#ledger = ledger;
    this.#sink = options.sink ?? null;
    this.#readOnly = options.readOnly ?? false;
    this.#today = options.today ?? (() => localToday());
    this.#undo = new UndoStack(() => this.#ledger);
  }

  /** Builds the workspace from the records in the vault (an empty vault starts a new ledger). */
  static fromRecords(records: Iterable<PlainRecordLike>, name: string, options: WorkspaceOptions = {}): Workspace {
    const list = [...records].map((r) => ({ id: r.id, kind: r.kind, payload: r.payload as Record<string, unknown> }));
    const fresh = list.length === 0;
    const ledger = fresh ? Ledger.new(name) : Ledger.fromRecords(list);
    const workspace = new Workspace(ledger, options);
    // A new project, or one migrated in memory, sends every record once.
    if (fresh || ledger.migratedFrom !== null) workspace.#stageAll();
    return workspace;
  }

  get ledger(): Ledger {
    return this.#ledger;
  }

  get readOnly(): boolean {
    return this.#readOnly;
  }

  get undoStack(): UndoStack {
    return this.#undo;
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

  /** Runs one user action on the ledger: one undo step, synced, observed. */
  act<T>(action: (ledger: Ledger) => T): T {
    if (this.#readOnly) throw new ReadOnlyError();
    const journal = this.#undo.journal;
    const mark = journal.length;
    let result: T;
    try {
      result = action(this.#ledger);
    } catch (error) {
      // Put back whatever the failed action wrote before failing.
      const partial = journal.splice(mark);
      if (partial.length) this.#ledger.revert(partial);
      this.#ledger.markClean(-1); // nothing to forget; keeps the dirty map consistent
      throw error;
    }
    this.#undo.seal();
    this.#flush();
    this.#changed();
    return result;
  }

  undo(): string | null {
    if (this.#readOnly) throw new ReadOnlyError();
    const step = this.#undo.undo();
    if (!step) return null;
    this.#flush();
    this.#changed();
    return step.label;
  }

  redo(): string | null {
    if (this.#readOnly) throw new ReadOnlyError();
    const step = this.#undo.redo();
    if (!step) return null;
    this.#flush();
    this.#changed();
    return step.label;
  }

  /** Who is recorded in the history for the next changes (the operator picked in the top bar). */
  setOperator(name: string | null): void {
    this.#ledger.operator = name;
  }

  // ── sync ────────────────────────────────────────────

  /** Hands the records changed since the last hand-over to the vault. */
  #flush(): void {
    const keys = this.#ledger.dirtyKeys();
    if (!keys.length) return;
    const upTo = this.#ledger.changeCount;
    const upserts: PlainRecordLike[] = [];
    const deletes: { kind: string; id: string }[] = [];
    for (const { kind, id } of keys) {
      const payload = this.#ledger.recordFor(kind, id);
      if (payload === null) deletes.push({ kind, id });
      else upserts.push({ kind, id, payload });
    }
    this.#ledger.markClean(upTo);
    this.#send(upserts, deletes);
  }

  #stageAll(): void {
    const rows: LedgerRecord[] = this.#ledger.toRecords();
    this.#ledger.markClean(this.#ledger.changeCount);
    this.#send(rows, []);
  }

  #send(upserts: PlainRecordLike[], deletes: { kind: string; id: string }[]): void {
    if (!this.#sink) return;
    const sink = this.#sink;
    // Hand-overs stay in order; a failure is kept for the sync state, the data is still in memory.
    this.#pendingStage = this.#pendingStage
      .then(() => sink.stage(upserts, deletes))
      .then(
        () => {
          this.stageError = null;
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
   * Someone else changed the project (this tab is read-only, or took over the edit): the ledger is
   * rebuilt from the vault's records. Undo history of this tab no longer applies.
   */
  reload(records: Iterable<PlainRecordLike>, readOnly: boolean): void {
    const list = [...records].map((r) => ({ id: r.id, kind: r.kind, payload: r.payload as Record<string, unknown> }));
    if (list.length) {
      const operator = this.#ledger.operator;
      this.#ledger = Ledger.fromRecords(list);
      this.#ledger.operator = operator;
      this.#undo = new UndoStack(() => this.#ledger);
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
