/** Port of the ledger-only cases of `tests/test_undo.py` (the import and budget cases come with those modules). */
import { describe, expect, it } from "vitest";

import * as queries from "../src/domain/queries.ts";
import type { IsoDate } from "../src/lib/dates.ts";
import { UndoStack } from "../src/undo.ts";
import { category, family } from "./fixtures.ts";

const d = (s: string) => s as IsoDate;

function setup() {
  const f = family();
  f.ledger.recordOpeningBalance(f.bank, "1000.00", d("2026-01-01"));
  const stack = new UndoStack(() => f.ledger);
  return { f, stack };
}

describe("undo", () => {
  it("undo/redo of an expense restores balances and history", () => {
    const { f, stack } = setup();
    const ledger = f.ledger;
    const historyBefore = ledger.history.length;
    const op = ledger.recordExpense(f.bank, category(ledger, "Lazer"), "200.00", d("2026-01-05"), "Show");
    const step = stack.seal();
    expect(step?.label).toBe("lançamento");
    expect(queries.balance(ledger, f.bank).toFixed()).toBe("800.00");
    stack.undo();
    expect(ledger.operations.has(op.id)).toBe(false);
    expect(ledger.history.length).toBe(historyBefore);
    expect(queries.balance(ledger, f.bank).toFixed()).toBe("1000.00");
    stack.redo();
    expect(ledger.operations.get(op.id)).toBe(op);
    expect(queries.balance(ledger, f.bank).toFixed()).toBe("800.00");
  });

  it("undoing a correction brings back the previous version", () => {
    const { f, stack } = setup();
    const ledger = f.ledger;
    const op = ledger.recordExpense(f.bank, category(ledger, "Lazer"), "50.00", d("2026-01-05"), "Cinema");
    stack.seal();
    ledger.updateOperation({ ...op, description: "Teatro" }, "nome errado");
    stack.seal();
    stack.undo();
    expect(ledger.operations.get(op.id)!.description).toBe("Cinema");
    expect(ledger.operations.get(op.id)!.version).toBe(1);
    expect(ledger.historyOf(op.id).map((h) => h.reason)).toEqual([null]);
  });

  it("a new action clears redo and clear() empties everything", () => {
    const { f, stack } = setup();
    f.ledger.addMember("Carla");
    stack.seal();
    stack.undo();
    expect(stack.canRedo()).toBe(true);
    expect(stack.redoLabel()).toBe("integrante");
    f.ledger.addMember("Davi");
    stack.seal();
    expect(stack.canRedo()).toBe(false);
    stack.clear();
    expect(stack.canUndo() || stack.canRedo()).toBe(false);
  });

  it("an undone change is pending as a deletion", () => {
    const { f, stack } = setup();
    f.ledger.markClean(f.ledger.changeCount);
    stack.clear();
    const op = f.ledger.recordExpense(f.bank, category(f.ledger, "Lazer"), "9.00", d("2026-01-09"), "X");
    stack.seal();
    stack.undo();
    const pending = f.ledger.dirtyKeys().find((k) => k.kind === "operation" && k.id === op.id);
    expect(pending).toBeDefined();
    expect(f.ledger.recordFor("operation", op.id)).toBeNull();
  });
});
