/**
 * Schema 3 (not in the Python original): category management (rename, archive, merge), the new recurrence
 * frequencies and deleting a rule, the budget's carried leftover, and the migration from schema 2.
 */
import { describe, expect, it } from "vitest";

import * as budget from "../src/domain/budget.ts";
import * as categories from "../src/domain/categories.ts";
import * as deductibles from "../src/domain/deductibles.ts";
import { DomainError, Ledger, SCHEMA_VERSION } from "../src/domain/ledger.ts";
import { AccountSubtype, AccountType, LedgerAccountSchema } from "../src/domain/model.ts";
import * as periods from "../src/domain/periods.ts";
import * as recurrence from "../src/domain/recurrence.ts";
import * as subscriptions from "../src/domain/subscriptions.ts";
import * as importRules from "../src/importing/rules.ts";
import { UndoStack } from "../src/undo.ts";
import { type IsoDate, ym } from "../src/lib/dates.ts";
import { Dec } from "../src/lib/dec.ts";
import { category, family } from "./fixtures.ts";

const d = (s: string) => s as IsoDate;
const MAR = ym(2026, 3);
const APR = ym(2026, 4);
const MAY = ym(2026, 5);

function sub(ledger: Ledger, name: string, parent: string) {
  return ledger.addAccount(
    LedgerAccountSchema.parse({ name, type: AccountType.EXPENSE, subtype: AccountSubtype.CATEGORY, parent_id: parent }),
  ).id;
}

describe("categories: rename and archive", () => {
  it("renames, refusing an empty name and the name of another active category", () => {
    const f = family();
    const leisure = category(f.ledger, "Lazer");
    expect(categories.renameCategory(f.ledger, leisure, "  Passeios ").name).toBe("Passeios");
    expect(f.ledger.historyOf(leisure).at(-1)?.reason).toBe("categoria renomeada");
    expect(() => categories.renameCategory(f.ledger, leisure, " ")).toThrow(DomainError);
    expect(() => categories.renameCategory(f.ledger, leisure, "alimentação")).toThrow(/Mesclar/);
    // an income category may share a name with an expense one
    expect(categories.renameCategory(f.ledger, f.salary, "Passeios").name).toBe("Passeios");
    expect(() => categories.renameCategory(f.ledger, f.bank, "Banco")).toThrow("Categoria inexistente.");
  });

  it("archives and brings back; a parent with active sub-categories stays", () => {
    const f = family();
    const snacks = sub(f.ledger, "Lanches", f.groceries);
    expect(() => categories.setArchived(f.ledger, f.groceries, true)).toThrow(/subcategorias/);
    categories.setArchived(f.ledger, snacks, true);
    categories.setArchived(f.ledger, f.groceries, true);
    expect(f.ledger.categories(AccountType.EXPENSE).map((a) => a.id)).not.toContain(f.groceries);
    expect(() => categories.setArchived(f.ledger, snacks, false)).toThrow(/categoria-mãe/);
    categories.setArchived(f.ledger, f.groceries, false);
    expect(categories.setArchived(f.ledger, snacks, false).archived).toBe(false);
  });
});

describe("categories: merge", () => {
  it("moves postings, sub-categories, budgets, recurrences and rules, then archives the source", () => {
    const f = family();
    const ledger = f.ledger;
    const market = sub(ledger, "Mercado", f.groceries);
    const restaurant = category(ledger, "Lazer");
    const kid = sub(ledger, "Sorveteria", restaurant);
    // a split with both categories: the two postings become one
    const split = ledger.recordExpense(
      f.bank,
      [
        [restaurant, "30.00"],
        [market, "20.00"],
      ],
      null,
      d("2026-03-05"),
      "Feira",
    );
    const plain = ledger.recordCardPurchase(f.card, restaurant, "80.00", d("2026-03-08"), "Jantar");
    const cancelled = ledger.recordExpense(f.bank, restaurant, "10.00", d("2026-03-09"), "Errado");
    ledger.cancelOperation(cancelled.id, "duplicado");
    budget.setBudget(ledger, restaurant, MAR, "100.00");
    budget.setBudget(ledger, market, MAR, "50.00");
    budget.setBudget(ledger, restaurant, APR, "70.00");
    const rule = recurrence.addRule(
      ledger,
      recurrence.RecurrenceRuleSchema.parse({
        description: "Clube",
        account_id: f.bank,
        counterpart_id: restaurant,
        amount: Dec.from("50"),
        day: 10,
        start: d("2026-01-01"),
      }),
    );
    const catRule = importRules.addRule(ledger, "JANTAR", restaurant);
    deductibles.mark(ledger, restaurant, "other");

    expect(categories.previewMerge(ledger, restaurant, market)).toEqual({ operations: 2, closedMonths: [] });
    const result = categories.mergeCategories(ledger, restaurant, market);
    expect(result.operations).toBe(2);

    const moved = ledger.operations.get(split.id)!;
    expect(moved.postings.map((p) => [p.account_id, p.amount.toFixed()])).toEqual([
      [market, "50.00"],
      [f.bank, "-50.00"],
    ]);
    expect(ledger.operations.get(plain.id)!.postings[0]!.account_id).toBe(market);
    // a cancelled operation is history: it keeps naming the (archived) source
    expect(ledger.operations.get(cancelled.id)!.postings[0]!.account_id).toBe(restaurant);
    expect(ledger.account(restaurant).archived).toBe(true);
    expect(ledger.account(kid).parent_id).toBe(market);
    expect(budget.lineFor(ledger, market, MAR)!.amount.toFixed()).toBe("150.00");
    expect(budget.lineFor(ledger, market, APR)!.amount.toFixed()).toBe("70.00");
    expect(budget.lineFor(ledger, restaurant, MAR)).toBeNull();
    expect(recurrence.rules(ledger).get(rule.id)!.counterpart_id).toBe(market);
    expect(importRules.rules(ledger).get(catRule.id)!.target_account_id).toBe(market);
    expect(deductibles.kindOf(ledger, market)).toBe("other");
    for (const op of ledger.activeOperations()) ledger.validateOperation(op);
  });

  it("the target keeps its own one-per-category marks", () => {
    const f = family();
    const health = category(f.ledger, "Saúde");
    const education = category(f.ledger, "Educação");
    deductibles.mark(f.ledger, health, "health");
    deductibles.mark(f.ledger, education, "education");
    categories.mergeCategories(f.ledger, health, education);
    expect([...deductibles.marks(f.ledger).values()].map((m) => [m.category_id, m.kind])).toEqual([
      [education, "education"],
    ]);
  });

  it("refuses other kinds, itself, an archived target, a sub-category of the source and closed months", () => {
    const f = family();
    const ledger = f.ledger;
    const leisure = category(ledger, "Lazer");
    expect(() => categories.previewMerge(ledger, leisure, f.salary)).toThrow(/mesmo tipo/);
    expect(() => categories.previewMerge(ledger, leisure, leisure)).toThrow(/outra categoria/);
    const kid = sub(ledger, "Cinema", leisure);
    expect(() => categories.previewMerge(ledger, leisure, kid)).toThrow(/fica dentro/);
    const other = category(ledger, "Outras despesas");
    categories.setArchived(ledger, other, true);
    expect(() => categories.previewMerge(ledger, leisure, other)).toThrow(/arquivada/);

    const op = ledger.recordExpense(f.bank, leisure, "25.00", d("2026-03-05"), "Teatro");
    periods.closeMonth(ledger, MAR);
    expect(categories.previewMerge(ledger, leisure, f.groceries).closedMonths).toEqual([MAR]);
    expect(() => categories.mergeCategories(ledger, leisure, f.groceries)).toThrow(/03\/2026/);
    expect(ledger.operations.get(op.id)!.postings[0]!.account_id).toBe(leisure);
    expect(ledger.account(leisure).archived).toBe(false);
  });

  it("is one undo step", () => {
    const f = family();
    const ledger = f.ledger;
    const leisure = category(ledger, "Lazer");
    ledger.recordExpense(f.bank, leisure, "25.00", d("2026-03-05"), "Teatro");
    budget.setBudget(ledger, leisure, MAR, "60.00");
    const before = JSON.stringify(ledger.toRecords().filter((r) => r.kind !== "history"));
    const undo = new UndoStack(() => ledger);
    undo.seal();
    categories.mergeCategories(ledger, leisure, f.groceries);
    undo.seal("mesclar categorias");
    undo.undo();
    expect(JSON.stringify(ledger.toRecords().filter((r) => r.kind !== "history"))).toBe(before);
  });
});

describe("recurrence: new frequencies and delete", () => {
  const rule = (input: Partial<Parameters<typeof recurrence.RecurrenceRuleSchema.parse>[0]> & object) =>
    recurrence.RecurrenceRuleSchema.parse({
      description: "Regra",
      account_id: "00000000-0000-4000-8000-000000000001",
      counterpart_id: "00000000-0000-4000-8000-000000000002",
      amount: Dec.from("100"),
      day: 5,
      start: d("2026-01-01"),
      ...input,
    });

  it("semimonthly is twice a month, 15 days apart, clamped to the month's end", () => {
    expect(
      recurrence.occurrences(rule({ frequency: "semimonthly", day: 5 }), d("2026-01-01"), d("2026-02-28")),
    ).toEqual(["2026-01-05", "2026-01-20", "2026-02-05", "2026-02-20"]);
    expect(
      recurrence.occurrences(rule({ frequency: "semimonthly", day: 30 }), d("2026-02-01"), d("2026-03-31")),
    ).toEqual(["2026-02-15", "2026-02-28", "2026-03-15", "2026-03-30"]);
  });

  it("quarterly and every N months count from the start month", () => {
    expect(recurrence.occurrences(rule({ frequency: "quarterly", day: 31 }), d("2026-01-01"), d("2026-12-31"))).toEqual(
      ["2026-01-31", "2026-04-30", "2026-07-31", "2026-10-31"],
    );
    expect(
      recurrence.occurrences(
        rule({ frequency: "every_n_months", interval_months: 5, day: 10 }),
        d("2026-01-01"),
        d("2027-03-01"),
      ),
    ).toEqual(["2026-01-10", "2026-06-10", "2026-11-10"]);
  });

  it("last business day is the last Monday to Friday (holidays unknown)", () => {
    // 31/01/2026 is a Saturday, 28/02 a Saturday, 31/05 a Sunday, 30/04 a Thursday
    expect(
      recurrence.occurrences(rule({ frequency: "last_business_day", day: 31 }), d("2026-01-01"), d("2026-05-31")),
    ).toEqual(["2026-01-30", "2026-02-27", "2026-03-31", "2026-04-30", "2026-05-29"]);
  });

  it("an interval only with every N months, and the yearly cost of each frequency", () => {
    const f = family();
    const base = { account_id: f.bank, counterpart_id: f.groceries };
    expect(() => recurrence.addRule(f.ledger, rule({ ...base, frequency: "every_n_months" }))).toThrow(/quantos meses/);
    expect(() => recurrence.addRule(f.ledger, rule({ ...base, interval_months: 3 }))).toThrow(DomainError);
    const perYear = (input: object) => subscriptions.perYear(rule({ ...base, ...input })).toFixed();
    expect(perYear({ frequency: "semimonthly" })).toBe("2400");
    expect(perYear({ frequency: "quarterly" })).toBe("400");
    expect(perYear({ frequency: "last_business_day" })).toBe("1200");
    expect(perYear({ frequency: "every_n_months", interval_months: 5 })).toBe("240.00");
    expect(perYear({ frequency: "every_n_months", interval_months: 7, amount: Dec.from("100.00") })).toBe("171.43");
  });

  it("deletes a rule and its decided forecasts; the operation that realized it stays", () => {
    const f = family();
    const added = recurrence.addRule(f.ledger, rule({ account_id: f.bank, counterpart_id: f.groceries }));
    const op = f.ledger.recordExpense(f.bank, f.groceries, "100.00", d("2026-01-05"), "Feira");
    recurrence.realize(f.ledger, added.id, d("2026-01-05"), op.id);
    recurrence.skip(f.ledger, added.id, d("2026-02-05"));
    recurrence.removeRule(f.ledger, added.id);
    expect(recurrence.rules(f.ledger).size).toBe(0);
    expect(recurrence.links(f.ledger).size).toBe(0);
    expect(f.ledger.operations.get(op.id)!.status).toBe("active");
    expect(() => recurrence.removeRule(f.ledger, added.id)).toThrow("Regra inexistente.");
  });
});

describe("budget: carried leftover", () => {
  it("the unspent part goes to the next month, chained; overspending is not carried", () => {
    const f = family();
    const ledger = f.ledger;
    budget.setBudget(ledger, f.groceries, MAR, "500.00");
    budget.setCarryOver(ledger, f.groceries, MAR, true);
    ledger.recordExpense(f.bank, f.groceries, "380.00", d("2026-03-10"), "Mercado");
    budget.setBudget(ledger, f.groceries, APR, "500.00");
    budget.setCarryOver(ledger, f.groceries, APR, true);
    ledger.recordExpense(f.bank, f.groceries, "450.00", d("2026-04-10"), "Mercado");

    const april = budget.status(ledger, APR).rows[0]!;
    expect([april.planned, april.carried, april.available, april.remaining].map((x) => x.toFixed())).toEqual([
      "500.00",
      "120.00",
      "620.00",
      "170.00",
    ]);
    expect(april.carryOver).toBe(true);
    expect(budget.status(ledger, APR).totalCarried.toFixed()).toBe("120.00");
    // May has no plan: the leftover still shows, as budget of its own
    const may = budget.status(ledger, MAY).rows[0]!;
    expect([may.planned.toFixed(), may.carried.toFixed(), may.available.toFixed()]).toEqual(["0", "170.00", "170.00"]);

    // April overspent: May starts from zero, not in debt
    ledger.recordExpense(f.bank, f.groceries, "300.00", d("2026-04-20"), "Mercado");
    expect(budget.carriedInto(ledger, f.groceries, MAY).toFixed()).toBe("0");
    expect(budget.status(ledger, MAY).rows).toEqual([]);
    // without the switch nothing is carried
    budget.setCarryOver(ledger, f.groceries, MAR, false);
    expect(budget.carriedInto(ledger, f.groceries, APR).toFixed()).toBe("0");
  });

  it("needs a plan in the month, and Copiar mês keeps the switch", () => {
    const f = family();
    expect(() => budget.setCarryOver(f.ledger, f.groceries, MAR, true)).toThrow(/Defina o valor/);
    budget.setBudget(f.ledger, f.groceries, MAR, "200.00");
    budget.setCarryOver(f.ledger, f.groceries, MAR, true);
    budget.setBudget(f.ledger, f.groceries, MAR, "250.00");
    expect(budget.lineFor(f.ledger, f.groceries, MAR)!.carry_over).toBe(true);
    budget.copyMonth(f.ledger, MAR, APR);
    expect(budget.lineFor(f.ledger, f.groceries, APR)!.carry_over).toBe(true);
  });
});

describe("migration 2 → 3", () => {
  it("rules get no interval and budget lines no carry-over", () => {
    const f = family();
    recurrence.addRule(
      f.ledger,
      recurrence.RecurrenceRuleSchema.parse({
        description: "Aluguel",
        account_id: f.bank,
        counterpart_id: category(f.ledger, "Moradia"),
        amount: Dec.from("1500"),
        day: 5,
        start: d("2026-01-01"),
      }),
    );
    budget.setBudget(f.ledger, f.groceries, MAR, "300.00");
    // the rows as schema 2 wrote them: without the new fields
    const old = f.ledger.toRecords().map((r) => {
      if (r.kind === "ledger.meta") return { ...r, payload: { ...r.payload, schema_version: 2 } };
      if (r.kind === "recurrence_rule" || r.kind === "budget_line") {
        const { interval_months: _i, carry_over: _c, ...rest } = r.payload;
        return { ...r, payload: rest };
      }
      return r;
    });
    expect(old.find((r) => r.kind === "budget_line")!.payload).not.toHaveProperty("carry_over");
    const restored = Ledger.fromRecords(old);
    expect(restored.migratedFrom).toBe(2);
    expect(restored.meta.schema_version).toBe(SCHEMA_VERSION);
    expect([...recurrence.rules(restored).values()].map((r) => [r.frequency, r.interval_months])).toEqual([
      ["monthly", null],
    ]);
    expect([...budget.lines(restored).values()].map((l) => l.carry_over)).toEqual([false]);
    const rows = restored.toRecords();
    expect(rows.find((r) => r.kind === "recurrence_rule")!.payload).toHaveProperty("interval_months", null);
    expect(rows.find((r) => r.kind === "budget_line")!.payload).toHaveProperty("carry_over", false);
  });
});
