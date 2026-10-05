/**
 * Port of `tests/test_planning_more.py`: saved filters, merchants, suspicious operations and goals.
 *
 * Skipped (owned by the import pipeline port): receipts (`attachments` + Session), W6-integration.
 */
import { describe, expect, it } from "vitest";

import * as alerts from "../src/domain/alerts.ts";
import * as annual from "../src/domain/annual.ts";
import * as anomalies from "../src/domain/anomalies.ts";
import { recordInstallmentPurchase } from "../src/domain/cards.ts";
import * as goals from "../src/domain/goals.ts";
import { DomainError } from "../src/domain/ledger.ts";
import * as merchants from "../src/domain/merchants.ts";
import * as savedFilters from "../src/domain/saved_filters.ts";
import { exporting } from "../src/index.ts";
import { AssetClass } from "../src/investments/model.ts";
import * as inv from "../src/investments/service.ts";
import { type IsoDate, ym } from "../src/lib/dates.ts";
import { Dec } from "../src/lib/dec.ts";
import { category, family } from "./fixtures.ts";

const d = (s: string) => s as IsoDate;

describe("saved filters", () => {
  it("live in the project", () => {
    const f = family();
    const saved = savedFilters.saveFilter(
      f.ledger,
      savedFilters.SavedFilterSchema.parse({
        name: "  Cartão  da Ana ",
        period: "this_month",
        account_id: f.card_account,
      }),
    );
    expect(saved.name).toBe("Cartão da Ana");
    const replaced = savedFilters.saveFilter(
      f.ledger,
      savedFilters.SavedFilterSchema.parse({ name: "cartão da ana", period: "all" }),
    );
    expect(replaced.id).toBe(saved.id);
    expect(savedFilters.saved(f.ledger).map((s) => s.period)).toEqual(["all"]);
    expect(() =>
      savedFilters.saveFilter(f.ledger, savedFilters.SavedFilterSchema.parse({ name: "X", period: "custom" })),
    ).toThrow(/personalizado/);
    savedFilters.deleteFilter(f.ledger, saved.id);
    expect(savedFilters.saved(f.ledger)).toEqual([]);
  });
});

describe("merchants", () => {
  it.each([
    ["IFD*IFOOD.COM AGENCIA", "Ifood"],
    ["MP*LOJA DO ZE 123456", "Loja Do Ze"],
    ["PADARIA REAL LTDA BR", "Padaria Real"],
    ["SPOTIFY P1A2B3", "Spotify"],
    ["NETFLIX.COM", "Netflix"],
    ["TV 55 (3/10)", "Tv"],
    ["12345", "12345"],
  ])("cleans %s", (description, cleaned) => {
    expect(merchants.clean(description)).toBe(cleaned);
  });

  it("an approved name covers similar descriptions", () => {
    const f = family();
    for (const [day, text] of [
      ["03", "IFD*IFOOD.COM AGENCIA"],
      ["09", "IFD*IFOOD.COM AGENCIA 7781"],
    ] as const) {
      f.ledger.recordCardPurchase(f.card, f.groceries, "50.00", d(`2026-03-${day}`), text);
    }
    f.ledger.recordCardPurchase(f.card, f.groceries, "20.00", d("2026-03-09"), "PADARIA REAL");
    merchants.nameMerchant(f.ledger, "IFD*IFOOD.COM AGENCIA", "iFood");
    expect(merchants.merchantOf(f.ledger, "IFD*IFOOD.COM AGENCIA 7781")).toBe("iFood");
    const found = merchants.totals(f.ledger, d("2026-03-01"), d("2026-03-31"));
    expect(found.map((m) => [m.name, m.expense.toFixed(), m.count, m.approved])).toEqual([
      ["iFood", "100.00", 2, true],
      ["Padaria Real", "20.00", 1, false],
    ]);
    expect([...f.ledger.operations.values()][0]!.description).toBeTruthy(); // descriptions untouched
    expect(() => merchants.nameMerchant(f.ledger, "X", "  ")).toThrow(DomainError);
  });
});

describe("suspicious operations", () => {
  it("a possible duplicate charge until reviewed", () => {
    const f = family();
    const today = d("2026-03-20");
    f.ledger.recordCardPurchase(f.card, f.groceries, "89.90", d("2026-03-10"), "POSTO SHELL");
    const second = f.ledger.recordCardPurchase(f.card, f.groceries, "89.90", d("2026-03-11"), "POSTO SHELL");
    f.ledger.recordCardPurchase(f.card, f.groceries, "89.90", d("2026-03-18"), "POSTO SHELL"); // a week later
    recordInstallmentPurchase(f.ledger, f.card, f.groceries, "300.00", d("2026-03-12"), "TV", 3);
    const found = anomalies.suspicions(f.ledger, today);
    expect(found.map((s) => [s.kind, s.operationId])).toEqual([[anomalies.SuspicionKind.DUPLICATE, second.id]]);
    expect(found[0]!.detail).toContain("10/03");
    expect(found[0]!.accountId).toBe(f.card_account);
    expect(found[0]!.title).toBe("Possível cobrança duplicada: POSTO SHELL");
    expect(alerts.suspicionAlerts(f.ledger, today).map((a) => a.title)).toEqual([
      "Possível cobrança duplicada: POSTO SHELL",
    ]);
    expect(anomalies.markReviewed(f.ledger, second.id)).toBe(2);
    expect(anomalies.suspicions(f.ledger, today)).toEqual([]);
    expect(anomalies.markReviewed(f.ledger, second.id)).toBe(0);
  });

  it("a value far above the category's usual", () => {
    const f = family();
    for (let month = 1; month < 7; month++) {
      const m = 9 + (month % 4);
      f.ledger.recordExpense(
        f.bank,
        f.groceries,
        "100.00",
        d(`2025-${String(m).padStart(2, "0")}-0${month}`),
        `Mercado ${month}`,
      );
    }
    f.ledger.recordExpense(f.bank, f.groceries, "120.00", d("2026-02-10"), "Mercado normal");
    const typo = f.ledger.recordExpense(f.bank, f.groceries, "1000.00", d("2026-03-01"), "Mercado digitado errado");
    const found = anomalies.suspicions(f.ledger, d("2026-03-05"));
    expect(found.map((s) => [s.kind, s.operationId])).toEqual([[anomalies.SuspicionKind.OUTLIER, typo.id]]);
    expect(found[0]!.detail).toContain("R$ 100,00");
  });
});

describe("goals", () => {
  it("progress, needed per month and pace", () => {
    const f = family();
    f.ledger.recordOpeningBalance(f.savings, "2000.00", d("2025-12-31"));
    for (const month of [1, 2, 3]) {
      f.ledger.recordIncome(f.savings, f.salary, "500.00", d(`2026-0${month}-05`), "Guardado");
    }
    const goal = goals.addGoal(
      f.ledger,
      goals.GoalSchema.parse({
        name: "Reserva",
        kind: goals.GoalKind.ACCOUNTS,
        target: "6000.00",
        target_date: "2026-12-31",
        account_ids: [f.savings],
        created_on: "2026-01-01",
      }),
    );
    const p = goals.progress(f.ledger, goal, d("2026-03-20"));
    expect([p.current, p.missing, p.share].map((v) => v.toFixed())).toEqual(["3500.00", "2500.00", "0.5833"]);
    expect([p.monthsLeft, p.neededPerMonth?.toFixed()]).toEqual([9, "277.78"]);
    expect(p.pace?.toFixed()).toBe("500.00");
    expect(p.reachedOnPace).toEqual(ym(2026, 8));
    const worth = goals.addGoal(
      f.ledger,
      goals.GoalSchema.parse({
        name: "Patrimônio",
        kind: goals.GoalKind.NET_WORTH,
        target: "1000.00",
        created_on: "2026-01-01",
      }),
    );
    const reached = goals.progress(f.ledger, worth, d("2026-03-20"));
    expect(reached.reached).toBe(true);
    expect(reached.neededPerMonth).toBeNull();
    expect(reached.share.eq(1)).toBe(true);
    expect(() =>
      goals.addGoal(
        f.ledger,
        goals.GoalSchema.parse({ name: "X", kind: goals.GoalKind.ACCOUNTS, target: "1", created_on: "2026-01-01" }),
      ),
    ).toThrow(/contas/);
    expect(() =>
      goals.addGoal(
        f.ledger,
        goals.GoalSchema.parse({
          name: "X",
          kind: goals.GoalKind.NET_WORTH,
          target: "1",
          target_date: "2025-01-01",
          created_on: "2026-01-01",
        }),
      ),
    ).toThrow(/futura/);
  });
});

describe("year end", () => {
  it("summary", () => {
    const f = family();
    const D = (v: string) => Dec.parse(v);
    f.ledger.recordOpeningBalance(f.bank, "1000.00", d("2025-06-01"));
    f.ledger.recordIncome(f.bank, f.salary, "5000.00", d("2026-02-05"), "Salário");
    f.ledger.recordExpense(f.bank, f.groceries, "300.00", d("2026-02-08"), "Mercado");
    const pos = inv.createPosition(f.ledger, "Fundo", AssetClass.FIXED_INCOME, d("2026-01-02"), {
      initial_cost: "2000",
      from_account: f.bank,
    });
    inv.distribute(f.ledger, pos.id, "50.00", d("2026-06-30"), f.bank, "7.50");
    inv.redeem(f.ledger, pos.id, d("2026-09-01"), "1100.00", f.bank, {
      cost_attributed: "1000.00",
      tax_withheld: "15.00",
    });
    const summary = annual.annual(f.ledger, 2026);
    const balances = new Map(summary.balances.map((b) => [b.name, [b.previousYearEnd, b.yearEnd]]));
    expect(balances.get("Banco A")![0]!.eq("1000.00")).toBe(true);
    expect(summary.income.get(f.salary)!.eq("5000.00")).toBe(true);
    expect(summary.expenseTotal.gte(D("300.00"))).toBe(true);
    expect(summary.investmentIncome.eq("50.00") && summary.taxWithheld.eq("22.50")).toBe(true);
    expect(summary.realizedGains.eq("100.00") && summary.incompleteEvents === 0).toBe(true);
    expect(annual.annual(f.ledger, 2024).balances).toEqual([]);
  });
});

describe("reminders and printable reports", () => {
  it("backup reminder", () => {
    const today = d("2026-03-31");
    expect(alerts.backupAlert(null, today, false)[0]!.title).toBe("Faça um backup do cofre");
    expect(alerts.backupAlert(null, today, true)[0]!.detail).toContain("nenhum backup");
    expect(alerts.backupAlert(d("2026-03-20"), today, true)).toEqual([]);
    expect(alerts.backupAlert(d("2026-01-31"), today, true)[0]!.title).toBe("Último backup há 59 dias");
  });

  it("monthly and annual reports escape text and say they are unencrypted", () => {
    const f = family();
    f.ledger.recordIncome(f.bank, f.salary, "5000.00", d("2026-03-05"), "Salário");
    f.ledger.recordExpense(f.bank, f.groceries, "300.00", d("2026-03-08"), "<script>Mercado</script>");
    const html = exporting.monthlyReportHtml(f.ledger, ym(2026, 3), d("2026-03-31"));
    for (const text of [exporting.WARNING, "março de 2026", "R$ 5.000,00", "Alimentação"]) expect(html).toContain(text);
    expect(html).not.toContain("<script>");
    const memberView = exporting.monthlyReportHtml(f.ledger, ym(2026, 3), d("2026-03-31"), f.ana);
    expect(memberView).toContain("Visão de <b>Ana</b>");
    const year = exporting.annualReportHtml(f.ledger, 2026);
    for (const text of ["fechamento de 2026", "Salário", exporting.WARNING]) expect(year).toContain(text);
    expect(category(f.ledger, "Saúde")).toBeTruthy(); // deductibles section renders even when empty
  });
});
