/** Port of `tests/test_edits.py` (the closed-month case comes with periods in W4). */
import { describe, expect, it } from "vitest";

import { reclassify } from "../src/domain/edits.ts";
import * as queries from "../src/domain/queries.ts";
import { type IsoDate, ym } from "../src/lib/dates.ts";
import { Dec } from "../src/lib/dec.ts";
import { category, family } from "./fixtures.ts";

const JAN = ym(2026, 1);
const d = (s: string) => s as IsoDate;

describe("reclassify", () => {
  it("changes single-category operations", () => {
    const f = family();
    const leisure = category(f.ledger, "Lazer");
    const a = f.ledger.recordExpense(f.bank, f.groceries, "10.00", d("2026-01-02"), "Cinema");
    const b = f.ledger.recordExpense(f.bank, f.groceries, "20.00", d("2026-01-03"), "Show");
    expect(reclassify(f.ledger, [a.id, b.id], leisure, "eram lazer").changed).toBe(2);
    expect([...queries.expensesByCategory(f.ledger, JAN, JAN)].map(([k, v]) => [k, v.toFixed()])).toEqual([
      [leisure, "30.00"],
    ]);
    expect(f.ledger.historyOf(a.id).at(-1)!.reason).toBe("eram lazer");
  });

  it("does not collapse a split without a source", () => {
    const f = family();
    const housing = category(f.ledger, "Moradia");
    const leisure = category(f.ledger, "Lazer");
    const op = f.ledger.recordExpense(
      f.bank,
      [
        [f.groceries, "10"],
        [housing, "5"],
      ],
      "15",
      d("2026-01-02"),
      "Misto",
    );
    expect(reclassify(f.ledger, [op.id], leisure, "x").changed).toBe(0);
    expect(reclassify(f.ledger, [op.id], leisure, "x", housing).changed).toBe(1);
    const ids = new Set(f.ledger.operations.get(op.id)!.postings.map((p) => p.account_id));
    expect(ids.has(f.groceries) && ids.has(leisure)).toBe(true);
  });

  it("a full edit changes amount, accounts and split", () => {
    const f = family();
    const op = f.ledger.recordExpense(f.bank, f.groceries, "10.00", d("2026-01-02"), "Mercado");
    f.ledger.updateOperation(
      {
        ...op,
        postings: [
          { account_id: f.groceries, amount: Dec.parse("6.00"), member_id: f.ana },
          { account_id: f.groceries, amount: Dec.parse("6.50"), member_id: f.bruno },
          { account_id: f.joint, amount: Dec.parse("-12.50"), member_id: null },
        ],
        settled_on: d("2026-01-03"),
      },
      "valor e conta corrigidos",
    );
    expect(queries.balance(f.ledger, f.joint).toFixed()).toBe("-12.50");
    expect(queries.incomeStatement(f.ledger, JAN, f.bruno).totalExpense.toFixed()).toBe("6.50");
  });
});
