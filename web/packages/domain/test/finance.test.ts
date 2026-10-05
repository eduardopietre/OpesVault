/**
 * Port of `tests/test_finance.py`: bill cycles, installments, recurrences and closing.
 * Skipped: `test_imported_installment_of_registered_plan_is_not_a_new_expense` (import pipeline).
 */
import { describe, expect, it } from "vitest";

import {
  BillStatus,
  bills,
  CompetencePolicy,
  cycleByDueMonth,
  cycleFor,
  plans,
  recordInstallmentPurchase,
  schedule,
} from "../src/domain/cards.ts";
import { DomainError, Ledger } from "../src/domain/ledger.ts";
import { closeMonth, isClosed, pendingItems, reopenMonth } from "../src/domain/periods.ts";
import * as queries from "../src/domain/queries.ts";
import {
  addRule,
  autoSuggestions,
  candidates,
  ForecastStatus,
  forecasts,
  realize,
  type RecurrenceRule,
  RecurrenceRuleSchema,
  skip,
} from "../src/domain/recurrence.ts";
import { type IsoDate, ym } from "../src/lib/dates.ts";
import { type Family, family } from "./fixtures.ts";

const d = (s: string) => s as IsoDate;
const [JAN, FEB, MAR, APR] = [1, 2, 3, 4].map((m) => ym(2026, m)) as [
  ReturnType<typeof ym>,
  ReturnType<typeof ym>,
  ReturnType<typeof ym>,
  ReturnType<typeof ym>,
];
const fx = (v: { toFixed(): string }) => v.toFixed();

describe("bill cycles", () => {
  it("closing and due", () => {
    const f = family(); // card closes on day 3, due on day 10
    const card = f.ledger.cards.get(f.card)!;
    expect(cycleFor(card, d("2026-01-02")).due).toBe("2026-01-10");
    expect(cycleFor(card, d("2026-01-03")).due).toBe("2026-01-10");
    expect(cycleFor(card, d("2026-01-04")).due).toBe("2026-02-10");
    expect(cycleByDueMonth(card, FEB).closing).toBe("2026-02-03");
  });

  it("due next month and short months", () => {
    const f = family();
    const card = { ...f.ledger.cards.get(f.card)!, closing_day: 31, due_day: 8 };
    const cycle = cycleFor(card, d("2026-02-15"));
    expect([cycle.closing, cycle.due]).toEqual(["2026-02-28", "2026-03-08"]);
  });

  it("bill totals, status and payment", () => {
    const f = family();
    f.ledger.recordOpeningBalance(f.bank, "1000.00", d("2026-01-01"));
    f.ledger.recordCardPurchase(f.card, f.groceries, "100.00", d("2026-01-05"), "Mercado");
    f.ledger.recordCardPurchase(f.card, f.groceries, "50.00", d("2026-01-20"), "Feira");
    let [feb] = bills(f.ledger, f.card, [FEB]);
    expect(fx(feb!.total)).toBe("150.00");
    expect(feb!.status(d("2026-02-05"))).toBe(BillStatus.CLOSED);
    expect(feb!.status(d("2026-02-11"))).toBe(BillStatus.OVERDUE);
    f.ledger.recordCardPayment(f.card, f.bank, "100.00", d("2026-02-09"));
    [feb] = bills(f.ledger, f.card, [FEB]);
    expect([fx(feb!.payments), fx(feb!.remaining)]).toEqual(["100.00", "50.00"]);
    expect(feb!.status(d("2026-02-20"))).toBe(BillStatus.PARTIAL);
  });
});

/** Feb bill R$ 150 (due 10/02) and Mar bill R$ 80 (due 10/03); card closes on day 3. */
function twoBills(): Family {
  const f = family();
  f.ledger.recordOpeningBalance(f.bank, "1000.00", d("2026-01-01"));
  f.ledger.recordCardPurchase(f.card, f.groceries, "150.00", d("2026-01-20"), "Mercado");
  f.ledger.recordCardPurchase(f.card, f.groceries, "80.00", d("2026-02-15"), "Feira");
  return f;
}

describe("late payments (docs/04 §5)", () => {
  it("a late payment settles the overdue bill", () => {
    const f = twoBills();
    f.ledger.recordCardPayment(f.card, f.bank, "150.00", d("2026-02-20")); // ten days late
    const [feb, mar] = bills(f.ledger, f.card, [FEB, MAR]);
    expect(fx(feb!.payments)).toBe("150.00");
    expect(feb!.status(d("2026-02-21"))).toBe(BillStatus.PAID);
    expect(mar!.payments.isZero()).toBe(true);
    expect(fx(mar!.remaining)).toBe("80.00");
  });

  it("a late payment beyond the overdue bill goes to the current one", () => {
    const f = twoBills();
    f.ledger.recordCardPayment(f.card, f.bank, "200.00", d("2026-02-20"));
    const [feb, mar] = bills(f.ledger, f.card, [FEB, MAR]);
    expect([fx(feb!.payments), fx(mar!.payments)]).toEqual(["150.00", "50.00"]);
    expect(fx(mar!.remaining)).toBe("30.00");
  });

  it("the oldest overdue bill is paid first even outside the requested months", () => {
    const f = twoBills();
    f.ledger.recordCardPayment(f.card, f.bank, "100.00", d("2026-03-20")); // both bills overdue
    const [onlyMar] = bills(f.ledger, f.card, [MAR]);
    expect(onlyMar!.payments.isZero()).toBe(true);
    const [feb, mar] = bills(f.ledger, f.card, [FEB, MAR]);
    expect([fx(feb!.payments), fx(feb!.remaining)]).toEqual(["100.00", "50.00"]);
    expect(mar!.payments.isZero()).toBe(true);
  });

  it("a payment on time stays in its own bill", () => {
    const f = twoBills();
    f.ledger.recordCardPayment(f.card, f.bank, "150.00", d("2026-02-10")); // on the due date
    f.ledger.recordCardPayment(f.card, f.bank, "80.00", d("2026-03-01")); // early for March
    const [feb, mar] = bills(f.ledger, f.card, [FEB, MAR]);
    expect(feb!.remaining.isZero() && mar!.remaining.isZero()).toBe(true);
  });
});

describe("installments", () => {
  it("purchase policy: whole expense in the purchase month, one installment per bill", () => {
    const f = family();
    const plan = recordInstallmentPurchase(f.ledger, f.card, f.groceries, "100.00", d("2026-01-05"), "Geladeira", 3);
    expect(plan.amounts.map(fx)).toEqual(["33.34", "33.33", "33.33"]);
    expect(fx(queries.incomeStatement(f.ledger, JAN).totalExpense)).toBe("100.00");
    expect(queries.incomeStatement(f.ledger, FEB).totalExpense.isZero()).toBe(true);
    expect(bills(f.ledger, f.card, [FEB, MAR, APR]).map((b) => fx(b.total))).toEqual(["33.34", "33.33", "33.33"]);
    expect(fx(queries.balance(f.ledger, f.card_account))).toBe("100.00"); // the full debt exists
    expect(schedule(f.ledger, plan).map((s) => s.cycle.due)).toEqual(["2026-02-10", "2026-03-10", "2026-04-10"]);
  });

  it("spread policy", () => {
    const f = family();
    recordInstallmentPurchase(
      f.ledger,
      f.card,
      f.groceries,
      "90.00",
      d("2026-01-05"),
      "Curso",
      3,
      CompetencePolicy.SPREAD,
    );
    expect([JAN, FEB, MAR, APR].map((m) => fx(queries.incomeStatement(f.ledger, m).totalExpense))).toEqual([
      "0",
      "30.00",
      "30.00",
      "30.00",
    ]);
    expect(bills(f.ledger, f.card, [FEB, MAR, APR]).map((b) => fx(b.total))).toEqual(["30.00", "30.00", "30.00"]);
  });

  it("count and value are never mixed", () => {
    const f = family();
    expect(() => recordInstallmentPurchase(f.ledger, f.card, f.groceries, "100", d("2026-01-01"), "x", 1)).toThrow(
      DomainError,
    );
  });
});

function salaryRule(f: Family): RecurrenceRule {
  return addRule(
    f.ledger,
    RecurrenceRuleSchema.parse({
      description: "Salário Ana",
      account_id: f.bank,
      counterpart_id: f.salary,
      amount: "5000.00",
      tolerance: "50.00",
      day: 5,
      start: "2026-01-01",
    }),
  );
}

describe("recurrences (RF-11, TA-17)", () => {
  it("a forecast does not change balances", () => {
    const f = family();
    salaryRule(f);
    const projected = forecasts(f.ledger, d("2026-01-01"), d("2026-03-31"), d("2026-01-01"));
    expect(projected.map((p) => p.dueOn)).toEqual(["2026-01-05", "2026-02-05", "2026-03-05"]);
    expect(queries.balance(f.ledger, f.bank).isZero()).toBe(true);
  });

  it("a realized salary is linked and not counted twice (TA-17)", () => {
    const f = family();
    const rule = salaryRule(f);
    const op = f.ledger.recordIncome(f.bank, f.salary, "4980.00", d("2026-01-06"), "SALARIO EMPRESA");
    const [forecast] = forecasts(f.ledger, d("2026-01-01"), d("2026-01-31"), d("2026-01-10"));
    expect(candidates(f.ledger, forecast!).map((c) => c.id)).toEqual([op.id]);
    expect(autoSuggestions(f.ledger, d("2026-01-01"), d("2026-01-31"), d("2026-01-10"))[0]![1].id).toBe(op.id);
    realize(f.ledger, rule.id, forecast!.dueOn, op.id);
    const [after] = forecasts(f.ledger, d("2026-01-01"), d("2026-01-31"), d("2026-01-10"));
    expect(after!.status).toBe(ForecastStatus.REALIZED);
    expect(after!.operationId).toBe(op.id);
    expect(fx(queries.incomeStatement(f.ledger, JAN).totalIncome)).toBe("4980.00");
    expect(f.ledger.operations.get(op.id)!.forecast_id).toBe(rule.id);
  });

  it("a value outside the tolerance is not a candidate", () => {
    const f = family();
    salaryRule(f);
    f.ledger.recordIncome(f.bank, f.salary, "4000.00", d("2026-01-05"), "x");
    const [forecast] = forecasts(f.ledger, d("2026-01-01"), d("2026-01-31"), d("2026-10-05"));
    expect(candidates(f.ledger, forecast!)).toEqual([]);
  });

  it("skipped and late forecasts", () => {
    const f = family();
    const rule = salaryRule(f);
    const [late] = forecasts(f.ledger, d("2026-01-01"), d("2026-01-31"), d("2026-01-20"));
    expect(late!.status).toBe(ForecastStatus.LATE);
    skip(f.ledger, rule.id, d("2026-01-05"));
    const [skipped] = forecasts(f.ledger, d("2026-01-01"), d("2026-01-31"), d("2026-01-20"));
    expect(skipped!.status).toBe(ForecastStatus.SKIPPED);
  });
});

describe("closing (RF-13, TA-19)", () => {
  it("a closed month blocks changes until reopened (TA-19)", () => {
    const f = family();
    const op = f.ledger.recordExpense(f.bank, f.groceries, "10.00", d("2026-01-10"), "Padaria");
    closeMonth(f.ledger, JAN);
    expect(isClosed(f.ledger, JAN)).toBe(true);
    expect(() => f.ledger.recordExpense(f.bank, f.groceries, "5.00", d("2026-01-11"), "x")).toThrow(DomainError);
    f.ledger.updateOperation({ ...op, description: "Padaria do bairro" }, "descrição não altera números"); // allowed
    expect(() => f.ledger.cancelOperation(op.id, "erro")).toThrow(DomainError);
    expect(() => reopenMonth(f.ledger, JAN, " ")).toThrow(DomainError);
    reopenMonth(f.ledger, JAN, "nota fiscal atrasada");
    f.ledger.cancelOperation(op.id, "erro");
    const closed = closeMonth(f.ledger, JAN);
    expect(closed.reopen_reasons).toEqual(["nota fiscal atrasada"]);
    expect(f.ledger.historyOf(closed.id).at(-1)!.reason).toBe("novo fechamento");
  });

  it("closing with pending items requires a justification", () => {
    const f = family();
    salaryRule(f);
    expect(pendingItems(f.ledger, JAN).length).toBeGreaterThan(0);
    expect(() => closeMonth(f.ledger, JAN)).toThrow(DomainError);
    const closed = closeMonth(f.ledger, JAN, "salário caiu no dia 10, previsão ajustada depois");
    expect(closed.pending_note).toBeTruthy();
  });

  it("closing keeps a summary snapshot", () => {
    const f = family();
    f.ledger.recordIncome(f.bank, f.salary, "5000.00", d("2026-01-05"), "Salário");
    const closed = closeMonth(f.ledger, JAN, "ok");
    expect([fx(closed.summary.income), fx(closed.summary.cash_in)]).toEqual(["5000.00", "5000.00"]);
  });

  it("closing survives persistence", () => {
    const f = family();
    closeMonth(f.ledger, JAN);
    const restored = Ledger.fromRecords(f.ledger.toRecords());
    expect(isClosed(restored, JAN)).toBe(true);
    expect(() => restored.recordExpense(f.bank, f.groceries, "1.00", d("2026-01-02"), "x")).toThrow(DomainError);
    expect(plans(restored).size).toBe(0);
  });
});
