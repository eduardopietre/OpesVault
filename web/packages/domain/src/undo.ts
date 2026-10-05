/**
 * Undo/redo for edits not yet synced (Ctrl+Z / Ctrl+Shift+Z). Port of `undo.py`.
 *
 * Each user action (everything between two `seal()` calls) is one step. Undo puts back the exact
 * objects that existed before, including removing the history entries the action created. After a
 * sync the synced steps can no longer be undone here; corrections to synced data keep going
 * through the history with a reason (estorno, correção, cancelamento).
 */
import type { Ledger } from "./domain/ledger.ts";
import type { JournalEntry } from "./domain/tracking.ts";

export const MAX_STEPS = 200;

/** What a step changed, in the user's words, by persisted kind (most specific first). */
export const KIND_LABELS: readonly (readonly [string, string])[] = [
  ["operation", "lançamento"],
  ["extracted_item", "revisão de importação"],
  ["import_batch", "importação"],
  ["budget_line", "orçamento"],
  ["category_rule", "regra de categoria"],
  ["recurrence_rule", "recorrência"],
  ["forecast_link", "recorrência"],
  ["period_close", "fechamento do mês"],
  ["card", "cartão"],
  ["account", "conta"],
  ["member", "integrante"],
  ["settings", "configurações"],
];

export interface Step {
  readonly entries: readonly JournalEntry[];
  readonly label: string;
}

export function describe(entries: readonly JournalEntry[]): string {
  const kinds = new Map<string, number>();
  for (const e of entries) if (e[0] === "entity") kinds.set(e[1], (kinds.get(e[1]) ?? 0) + 1);
  if (entries.some((e) => e[0] === "external") && kinds.size === 0) return "documento";
  for (const [kind, label] of KIND_LABELS) {
    const count = kinds.get(kind);
    if (count !== undefined) return kind === "operation" && count > 1 ? "lançamentos" : label;
  }
  return "alteração";
}

export class UndoStack {
  undoSteps: Step[] = [];
  redoSteps: Step[] = [];
  private readonly getLedger: () => Ledger;

  constructor(getLedger: () => Ledger) {
    this.getLedger = getLedger;
    const ledger = getLedger();
    if (ledger.journal === null) ledger.journal = [];
  }

  get journal(): JournalEntry[] {
    const ledger = this.getLedger();
    if (ledger.journal === null) ledger.journal = []; // the ledger was replaced; start recording it
    return ledger.journal;
  }

  /** Closes the current user action as one undo step. */
  seal(): Step | null {
    const entries = [...this.journal];
    this.journal.length = 0;
    if (!entries.length) return null;
    const step: Step = { entries, label: describe(entries) };
    this.undoSteps.push(step);
    if (this.undoSteps.length > MAX_STEPS) this.undoSteps.splice(0, this.undoSteps.length - MAX_STEPS);
    this.redoSteps = []; // a new action forks history: redo no longer applies
    return step;
  }

  canUndo(): boolean {
    return this.undoSteps.length > 0 || this.journal.length > 0;
  }

  canRedo(): boolean {
    return this.redoSteps.length > 0;
  }

  undoLabel(): string | null {
    if (this.journal.length) return describe(this.journal);
    return this.undoSteps.at(-1)?.label ?? null;
  }

  redoLabel(): string | null {
    return this.redoSteps.at(-1)?.label ?? null;
  }

  undo(): Step | null {
    this.seal();
    const step = this.undoSteps.pop();
    if (step === undefined) return null;
    this.getLedger().revert(step.entries);
    this.redoSteps.push(step);
    return step;
  }

  redo(): Step | null {
    const step = this.redoSteps.pop();
    if (step === undefined) return null;
    this.getLedger().replay(step.entries);
    this.undoSteps.push(step);
    return step;
  }

  /** Seals pending edits before a sync; returns how many steps the sync will contain. */
  checkpoint(): number {
    this.seal();
    return this.undoSteps.length;
  }

  /**
   * The first `steps` steps are now synced: they can no longer be undone here. Edits made while
   * the sync ran stay undoable; redo is dropped because it would re-apply on a different state.
   */
  saved(steps: number): void {
    this.undoSteps.splice(0, steps);
    this.redoSteps = [];
  }

  clear(): void {
    this.journal.length = 0;
    this.undoSteps = [];
    this.redoSteps = [];
  }
}
