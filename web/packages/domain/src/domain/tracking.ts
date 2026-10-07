/**
 * Collections that report every change to their ledger: what makes syncs incremental, caches
 * invalidate and unsaved edits undoable. Port of `domain/tracking.py`.
 *
 * A write to a tracked collection touches the ledger (`dirty`, `changeCount`) and is journaled
 * with its previous value; values loaded while opening a project are not changes.
 */
import type { Id } from "../lib/ids.ts";
import { type HistoryEntry, HistoryEntrySchema } from "./model.ts";

/** Marks "no value" in the change journal (null is a valid stored value). */
export const MISSING: unique symbol = Symbol("MISSING");
export type Missing = typeof MISSING;

/** What a tracked collection needs from its ledger. */
export interface ChangeSink {
  touch(kind: string, key: Id): void;
  journalAdd(entry: JournalEntry): void;
}

export type JournalEntry =
  | readonly ["entity", string, Id, unknown, unknown]
  | readonly ["history", HistoryEntry]
  | readonly ["meta", unknown, unknown]
  | readonly ["external", (forward: boolean) => void];

/** ISO instants compare as text once the fraction has a fixed width. */
function instantKey(at: string): string {
  const m = /^(.*T\d{2}:\d{2}:\d{2})(?:\.(\d+))?(.*)$/.exec(at);
  if (!m) return at;
  return `${m[1]}.${(m[2] ?? "").padEnd(9, "0")}${m[3]}`;
}

/** Entity collection (a Map by id) that reports every change. */
export class TrackedMap<V> extends Map<Id, V> {
  private readonly sink: ChangeSink | undefined;
  private readonly kind: string;

  constructor(sink: ChangeSink, kind: string) {
    super();
    this.sink = sink;
    this.kind = kind;
  }

  override set(key: Id, value: V): this {
    // Map's constructor may call set before fields exist; there is nothing to track then.
    if (this.sink === undefined) return super.set(key, value);
    const before = super.has(key) ? super.get(key) : MISSING;
    super.set(key, value);
    this.sink.touch(this.kind, key);
    this.sink.journalAdd(["entity", this.kind, key, before, value]);
    return this;
  }

  override delete(key: Id): boolean {
    if (!super.has(key)) return false;
    const before = super.get(key);
    super.delete(key);
    this.sink!.touch(this.kind, key);
    this.sink!.journalAdd(["entity", this.kind, key, before, MISSING]);
    return true;
  }

  override clear(): void {
    for (const key of [...this.keys()]) this.delete(key);
  }

  /** Insert while opening a project: not a change. */
  load(key: Id, value: V): void {
    super.set(key, value);
  }
}

/**
 * History list. Entries loaded from a project may stay as raw JSON until first read: a session
 * that never looks at old history never pays for parsing it.
 */
export class HistoryList implements Iterable<HistoryEntry> {
  private readonly sink: ChangeSink;
  private entries: HistoryEntry[] = [];
  private raw: unknown[] = [];

  constructor(sink: ChangeSink) {
    this.sink = sink;
  }

  loadRaw(payloads: unknown[]): void {
    this.raw = payloads;
  }

  /** Insert while opening a project: not a change. */
  load(entry: HistoryEntry): void {
    this.entries.push(entry);
  }

  private ensure(): void {
    if (this.raw.length) {
      const raw = this.raw;
      this.raw = [];
      const parsed = raw.map((p) => HistoryEntrySchema.parse(typeof p === "string" ? JSON.parse(p) : p));
      // Loaded history is ordered by time, like the desktop's `history.sort(key=at)` (stable).
      const keyed = parsed.map((entry, index) => ({ entry, index, key: instantKey(entry.at) }));
      keyed.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : a.index - b.index));
      parsed.splice(0, parsed.length, ...keyed.map((k) => k.entry));
      this.entries = [...parsed, ...this.entries];
    }
  }

  append(entry: HistoryEntry): void {
    this.entries.push(entry);
    this.sink.touch("history", entry.id);
    this.sink.journalAdd(["history", entry]);
  }

  /** Removes an entry appended in this session (undo of an unsynced change). */
  discard(entry: HistoryEntry): void {
    const index = this.entries.lastIndexOf(entry);
    if (index >= 0) this.entries.splice(index, 1);
    this.sink.touch("history", entry.id);
  }

  /** Entries appended in this session, newest first, without parsing old ones. */
  recent(): HistoryEntry[] {
    return [...this.entries].reverse();
  }

  get length(): number {
    return this.entries.length + this.raw.length;
  }

  all(): readonly HistoryEntry[] {
    this.ensure();
    return this.entries;
  }

  [Symbol.iterator](): Iterator<HistoryEntry> {
    return this.all()[Symbol.iterator]();
  }

  sortBy(compare: (a: HistoryEntry, b: HistoryEntry) => number): void {
    this.ensure();
    this.entries.sort(compare);
  }
}
