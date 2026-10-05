/** The budget case of `tests/test_undo.py`: a new action clears redo, and clear() empties everything. */
import { describe, expect, it } from "vitest";

import * as budget from "../src/domain/budget.ts";
import { type IsoDate, ym } from "../src/lib/dates.ts";
import { UndoStack } from "../src/undo.ts";
import { category, family } from "./fixtures.ts";

describe("undo", () => {
  it("a new action clears redo and clear() empties everything (budget)", () => {
    const f = family();
    f.ledger.recordOpeningBalance(f.bank, "1000.00", "2026-01-01" as IsoDate);
    const stack = new UndoStack(() => f.ledger);
    const ledger = f.ledger;
    budget.setBudget(ledger, category(ledger, "Lazer"), ym(2026, 1), "100.00");
    stack.seal();
    stack.undo();
    expect(stack.canRedo()).toBe(true);
    expect(stack.redoLabel()).toBe("orçamento");
    expect(budget.lines(ledger).size).toBe(0);
    ledger.addMember("Carla");
    stack.seal();
    expect(stack.canRedo()).toBe(false);
    stack.clear();
    expect(stack.canUndo() || stack.canRedo()).toBe(false);
  });
});
