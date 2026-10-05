/** The closed-month case of `tests/test_edits.py` (needs `periods`). */
import { describe, expect, it } from "vitest";

import { reclassify } from "../src/domain/edits.ts";
import { DomainError } from "../src/domain/ledger.ts";
import { closeMonth } from "../src/domain/periods.ts";
import { type IsoDate, ym } from "../src/lib/dates.ts";
import { category, family } from "./fixtures.ts";

describe("reclassify", () => {
  it("respects closed months and needs a reason", () => {
    const f = family();
    const leisure = category(f.ledger, "Lazer");
    const op = f.ledger.recordExpense(f.bank, f.groceries, "10.00", "2026-01-02" as IsoDate, "Cinema");
    expect(() => reclassify(f.ledger, [op.id], leisure, " ")).toThrow(DomainError);
    closeMonth(f.ledger, ym(2026, 1));
    const result = reclassify(f.ledger, [op.id], leisure, "tarde demais");
    expect(result.changed).toBe(0);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]).toBe("Cinema: O mês 2026-01 está fechado. Reabra-o com um motivo antes de alterar.");
  });
});
