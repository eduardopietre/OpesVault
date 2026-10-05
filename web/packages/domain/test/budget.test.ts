/** Port of `tests/test_budget.py`. */
import { describe, expect, it } from "vitest";

import * as budget from "../src/domain/budget.ts";
import { DomainError, Ledger } from "../src/domain/ledger.ts";
import { AccountSubtype, AccountType, LedgerAccountSchema } from "../src/domain/model.ts";
import { type IsoDate, ym } from "../src/lib/dates.ts";
import { category, family } from "./fixtures.ts";

const MAR = ym(2026, 3);
const APR = ym(2026, 4);
const d = (s: string) => s as IsoDate;

describe("budget", () => {
  it("planned, actual, remaining and states", () => {
    const f = family();
    const ledger = f.ledger;
    const food = f.groceries;
    const transport = category(ledger, "Transporte");
    budget.setBudget(ledger, food, MAR, "1000.00");
    budget.setBudget(ledger, transport, MAR, "100.00");
    // Card purchase counts in March (competence), the April bill payment does not repeat it.
    ledger.recordCardPurchase(f.card, food, "950.00", d("2026-03-10"), "Mercado");
    ledger.recordCardPayment(f.card, f.bank, "950.00", d("2026-04-10"));
    ledger.recordExpense(f.bank, transport, "130.00", d("2026-03-12"), "Combustível");
    ledger.recordExpense(f.bank, category(ledger, "Lazer"), "40.00", d("2026-03-13"), "Cinema");
    const s = budget.status(ledger, MAR);
    const rows = new Map(s.rows.map((r) => [r.categoryId, r]));
    expect([rows.get(food)!.actual.toFixed(), rows.get(food)!.remaining.toFixed()]).toEqual(["950.00", "50.00"]);
    expect(rows.get(food)!.state).toBe(budget.BudgetState.NEAR); // 95%
    expect(rows.get(transport)!.state).toBe(budget.BudgetState.OVER);
    expect(rows.get(transport)!.remaining.toFixed()).toBe("-30.00");
    expect(s.over).toEqual([rows.get(transport)]);
    expect(s.unbudgeted.toFixed()).toBe("40.00");
    expect([s.totalPlanned.toFixed(), s.totalActual.toFixed()]).toEqual(["1100.00", "1080.00"]);
    expect(budget.status(ledger, APR).rows).toEqual([]);
  });

  it("a parent budget covers sub-categories", () => {
    const f = family();
    const ledger = f.ledger;
    const food = f.groceries;
    const snacks = ledger.addAccount(
      LedgerAccountSchema.parse({
        name: "Lanches",
        type: AccountType.EXPENSE,
        subtype: AccountSubtype.CATEGORY,
        parent_id: food,
      }),
    ).id;
    budget.setBudget(ledger, food, MAR, "500.00");
    budget.setBudget(ledger, snacks, MAR, "50.00");
    ledger.recordExpense(f.bank, snacks, "60.00", d("2026-03-02"), "Lanche");
    ledger.recordExpense(f.bank, food, "100.00", d("2026-03-03"), "Feira");
    const s = budget.status(ledger, MAR);
    const rows = new Map(s.rows.map((r) => [r.categoryId, r]));
    expect(rows.get(food)!.actual.toFixed()).toBe("160.00");
    expect(rows.get(snacks)!.state).toBe(budget.BudgetState.OVER);
    expect(s.totalPlanned.toFixed()).toBe("500.00"); // the child plan is inside the parent's
  });

  it("copy, update, remove and validation", () => {
    const f = family();
    const ledger = f.ledger;
    budget.setBudget(ledger, f.groceries, MAR, "800.00");
    expect(budget.copyMonth(ledger, MAR, APR)).toBe(1);
    expect(budget.copyMonth(ledger, MAR, APR)).toBe(0); // never overwrites by default
    const line = budget.setBudget(ledger, f.groceries, APR, "900.00");
    expect(line.version).toBe(2);
    expect(ledger.historyOf(line.id).at(-1)!.reason).toBe("valor do orçamento alterado");
    budget.removeBudget(ledger, f.groceries, APR);
    expect(budget.lineFor(ledger, f.groceries, APR)).toBeNull();
    expect(() => budget.setBudget(ledger, f.salary, MAR, "10.00")).toThrow(DomainError); // income category
    expect(() => budget.setBudget(ledger, f.groceries, MAR, "0")).toThrow(DomainError);
    expect(() => budget.setBudget(ledger, f.groceries, MAR, "1.001")).toThrow(DomainError);
    const restored = Ledger.fromRecords(ledger.toRecords());
    expect(budget.lineFor(restored, f.groceries, MAR)).not.toBeNull();
  });
});
