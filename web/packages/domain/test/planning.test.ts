/**
 * Port of `tests/test_planning.py` (review of 03/10/2026): loans, tags, reimbursements, settling
 * up, bank checks, deductible expenses, subscriptions, indicators, comparisons and projection.
 *
 * Skipped (modules ported later): `test_calendar_lists_bills_recurrences_and_installments_with_state`
 * (agenda), `test_table_rows_total_flows_but_not_positions` (charts/data), and the `alerts.*` and
 * `charts.*` asserts inside the bank check, commitments and projection cases. `Ledger.from_raw`
 * (JSON lines) is covered by `fromRecords` over JSON-parsed records.
 */
import { describe, expect, it } from "vitest";

import * as balanceChecks from "../src/domain/balance_checks.ts";
import { CompetencePolicy, recordInstallmentPurchase } from "../src/domain/cards.ts";
import * as comparisons from "../src/domain/comparisons.ts";
import * as deductibles from "../src/domain/deductibles.ts";
import * as indicators from "../src/domain/indicators.ts";
import { DomainError, Ledger, type LedgerRecord } from "../src/domain/ledger.ts";
import * as loans from "../src/domain/loans.ts";
import { AccountSubtype, AccountType, dump, LedgerAccountSchema } from "../src/domain/model.ts";
import { closeMonth } from "../src/domain/periods.ts";
import * as projection from "../src/domain/projection.ts";
import * as queries from "../src/domain/queries.ts";
import { addRule, Frequency, realize, type RecurrenceRule, RecurrenceRuleSchema } from "../src/domain/recurrence.ts";
import { findOperations, operationFilter } from "../src/domain/search.ts";
import * as sharing from "../src/domain/sharing.ts";
import * as subscriptions from "../src/domain/subscriptions.ts";
import * as tags from "../src/domain/tags.ts";
import { type IsoDate, ym } from "../src/lib/dates.ts";
import { Dec } from "../src/lib/dec.ts";
import { j } from "./golden.ts";
import { category, type Family, family } from "./fixtures.ts";

const d = (s: string) => s as IsoDate;
const D = (s: string) => Dec.parse(s);
const fx = (v: Dec) => v.toFixed();

function loan(
  f: Family,
  system: loans.AmortizationSystem = loans.AmortizationSystem.PRICE,
  extra: Record<string, unknown> = {},
): loans.LoanPlan {
  const debt = f.ledger.addAccount(
    LedgerAccountSchema.parse({ name: "Carro", type: AccountType.LIABILITY, subtype: AccountSubtype.LOAN }),
  );
  return loans.LoanPlanSchema.parse({
    name: "Carro",
    liability_account_id: debt.id,
    payment_account_id: f.bank,
    interest_category_id: category(f.ledger, "Juros e encargos"),
    principal: "1000.00",
    monthly_rate: "0.01",
    term: 12,
    system,
    first_due: "2026-02-10",
    ...extra,
  });
}

describe("loans", () => {
  it("Price schedule matches the textbook installment", () => {
    const f = family();
    const items = loans.schedule(loan(f));
    expect(items.length).toBe(12);
    expect(fx(items[0]!.payment)).toBe("88.85"); // 1000 × 0.01 / (1 − 1.01^−12) = 88,8488 → 88,85
    expect([fx(items[0]!.interest), fx(items[0]!.amortization)]).toEqual(["10.00", "78.85"]);
    expect(items.slice(0, -1).every((i) => i.payment.eq("88.85"))).toBe(true);
    expect(fx(Dec.sum(items.map((i) => i.amortization)))).toBe("1000.00");
    expect(items.at(-1)!.balanceAfter.isZero()).toBe(true);
    expect(items.at(-1)!.due).toBe("2027-01-10");
  });

  it("SAC schedule has constant amortization", () => {
    const f = family();
    const items = loans.schedule(loan(f, loans.AmortizationSystem.SAC, { principal: "1200.00" }));
    expect(new Set(items.map((i) => fx(i.amortization)))).toEqual(new Set(["100.00"]));
    expect([fx(items[0]!.payment), fx(items.at(-1)!.payment)]).toEqual(["112.00", "101.00"]);
    const payments = items.map((i) => i.payment);
    expect(payments.map(fx)).toEqual([...payments].sort((a, b) => b.cmp(a)).map(fx));
  });

  it("zero rate and the rounding residual go to the last installment", () => {
    const f = family();
    const items = loans.schedule(
      loan(f, loans.AmortizationSystem.PRICE, { principal: "100.00", monthly_rate: "0", term: 3 }),
    );
    expect(items.map((i) => fx(i.payment))).toEqual(["33.33", "33.33", "33.34"]);
  });

  it("the annual rate converts to the equivalent monthly rate", () => {
    expect(loans.annualToMonthly("0.126825030").toString()).toBe("0.0100000000");
    expect(() => loans.annualToMonthly("-0.1")).toThrow(DomainError);
  });

  it("paying an installment splits amortization, interest and fees", () => {
    const f = family();
    const fees = category(f.ledger, "Serviços e assinaturas");
    const plan = loans.createLoan(
      f.ledger,
      loan(f, loans.AmortizationSystem.PRICE, { fees_per_installment: "5.00", fees_category_id: fees }),
      loans.Opening.OPENING_BALANCE,
      { on: d("2026-01-10") },
    );
    expect(fx(queries.balance(f.ledger, plan.liability_account_id))).toBe("1000.00");
    const op = loans.payInstallment(f.ledger, plan.id, 1, d("2026-02-10"));
    const byAccount = new Map(op.postings.map((p) => [p.account_id, fx(p.amount)]));
    expect(byAccount.get(plan.liability_account_id)).toBe("78.85");
    expect(byAccount.get(plan.interest_category_id)).toBe("10.00");
    expect(byAccount.get(fees)).toBe("5.00");
    expect(byAccount.get(f.bank)).toBe("-93.85");
    const status = loans.status(f.ledger, plan.id, d("2026-03-01"));
    expect([fx(status.outstanding), fx(status.ledgerBalance)]).toEqual(["921.15", "921.15"]);
    expect(status.paid).toBe(1);
    expect(status.nextDue?.number).toBe(2);
    expect(() => loans.payInstallment(f.ledger, plan.id, 1, d("2026-02-11"))).toThrow(/já foi paga/);
    expect(() => loans.payInstallment(f.ledger, plan.id, 2, d("2026-03-10"), "50.00")).toThrow(/menor/);
    const late = loans.payInstallment(f.ledger, plan.id, 2, d("2026-03-15"), "100.00"); // with late charges
    const interest = Dec.sum(
      late.postings.filter((p) => p.account_id === plan.interest_category_id).map((p) => p.amount),
    );
    expect(interest.eq(D("100.00").sub("5.00").sub(loans.planSchedule(f.ledger, plan.id)[1]!.amortization))).toBe(true);
  });

  it("deposit opening and a cancelled payment", () => {
    const f = family();
    const plan = loans.createLoan(f.ledger, loan(f), loans.Opening.DEPOSIT, {
      on: d("2026-01-05"),
      depositAccountId: f.bank,
    });
    expect(fx(queries.balance(f.ledger, f.bank))).toBe("1000.00");
    const op = loans.payInstallment(f.ledger, plan.id, 1, d("2026-02-10"));
    f.ledger.cancelOperation(op.id, "lançado em duplicidade");
    expect(loans.status(f.ledger, plan.id, d("2026-10-05")).paid).toBe(0); // a cancelled operation does not pay
  });

  it("a prepayment reduces term or payment and a simulation writes nothing", () => {
    const f = family();
    const plan = loans.createLoan(f.ledger, loan(f), loans.Opening.OPENING_BALANCE, { on: d("2026-01-10") });
    loans.payInstallment(f.ledger, plan.id, 1, d("2026-02-10"));
    const before = f.ledger.changeCount;
    const shorter = loans.simulatePrepayment(f.ledger, plan.id, "300.00", loans.PrepaymentMode.REDUCE_TERM);
    const lower = loans.simulatePrepayment(f.ledger, plan.id, "300.00", loans.PrepaymentMode.REDUCE_PAYMENT);
    expect(f.ledger.changeCount).toBe(before);
    expect(shorter.installmentsBefore).toBe(11);
    expect(shorter.installmentsAfter).toBeLessThan(11);
    expect(shorter.nextPaymentAfter!.eq(shorter.nextPaymentBefore!)).toBe(true);
    expect(lower.installmentsAfter).toBe(11);
    expect(lower.nextPaymentAfter!.lt(lower.nextPaymentBefore!)).toBe(true);
    expect(shorter.interestSaved.gt(lower.interestSaved) && lower.interestSaved.isPositive()).toBe(true);
    loans.prepay(f.ledger, plan.id, "300.00", d("2026-02-20"), loans.PrepaymentMode.REDUCE_TERM);
    const status = loans.status(f.ledger, plan.id, d("2026-03-01"));
    expect([fx(status.outstanding), fx(status.ledgerBalance)]).toEqual(["621.15", "621.15"]);
    expect(status.installments.length).toBe(1 + shorter.installmentsAfter);
    expect(() => loans.prepay(f.ledger, plan.id, "5000.00", d("2026-02-21"), loans.PrepaymentMode.REDUCE_TERM)).toThrow(
      /saldo devedor/,
    );
  });

  it("validation", () => {
    const f = family();
    expect(() => loans.createLoan(f.ledger, { ...loan(f), liability_account_id: f.card_account })).toThrow(
      /empréstimo/,
    );
    expect(() =>
      loans.createLoan(f.ledger, loan(f, loans.AmortizationSystem.PRICE, { fees_per_installment: "5.00" })),
    ).toThrow(/categoria dos encargos/);
    expect(() => loans.createLoan(f.ledger, loan(f), loans.Opening.DEPOSIT)).toThrow(/conta que recebeu/);
    expect(loans.plans(f.ledger).size).toBe(0);
  });
});

describe("tags", () => {
  it("group operations, and a plan is tagged whole", () => {
    const f = family();
    const leisure = category(f.ledger, "Lazer");
    const lodging = f.ledger.recordCardPurchase(f.card, leisure, "900.00", d("2026-02-02"), "Pousada");
    const food = f.ledger.recordExpense(f.bank, f.groceries, "120.00", d("2026-02-03"), "Restaurante");
    const plan = recordInstallmentPurchase(
      f.ledger,
      f.card,
      leisure,
      "600.00",
      d("2026-02-04"),
      "Passeio",
      3,
      CompetencePolicy.SPREAD,
    );
    expect(tags.addTag(f.ledger, [lodging.id, food.id], "Viagem 2026")).toBe(2);
    tags.addTag(f.ledger, [plan.operation_ids[0]!], "viagem 2026"); // same tag, other spelling
    expect(tags.allTags(f.ledger)).toEqual(["Viagem 2026"]);
    expect(tags.operationsWith(f.ledger, "VIAGEM 2026")).toEqual(new Set([lodging.id, food.id, ...plan.operation_ids]));
    const found = tags.summary(f.ledger, "Viagem 2026");
    expect([fx(found.expense), found.first]).toEqual(["1620.00", "2026-02-02"]);
    expect(fx(found.byCategory.get(leisure)!)).toBe("1500.00");
    const ids = tags.operationsWith(f.ledger, "Viagem 2026");
    expect(new Set(findOperations(f.ledger, operationFilter({ operation_ids: ids })).map((o) => o.id))).toEqual(ids);
    expect(tags.renameTag(f.ledger, "Viagem 2026", "Férias")).toBe(5);
    expect(tags.allTags(f.ledger)).toEqual(["Férias"]);
    tags.removeTag(f.ledger, [food.id], "férias");
    expect(tags.tagsOf(f.ledger, food.id)).toEqual([]);
    expect(() => tags.addTag(f.ledger, [food.id], "   ")).toThrow(DomainError);
  });

  it("tagging is allowed in a closed month", () => {
    const f = family();
    const op = f.ledger.recordExpense(f.bank, f.groceries, "50.00", d("2026-01-05"), "Feira");
    closeMonth(f.ledger, ym(2026, 1), "teste");
    tags.addTag(f.ledger, [op.id], "Casa");
    expect(tags.tagsOf(f.ledger, op.id)).toEqual(["Casa"]);
  });
});

describe("reimbursements and settling up", () => {
  it("a reimbursement is received as a refund of the same categories", () => {
    const f = family();
    const health = category(f.ledger, "Saúde");
    const op = f.ledger.recordExpense(f.bank, health, "400.00", d("2026-03-05"), "Exame");
    expect(() => sharing.request(f.ledger, op.id, "Plano", "500.00")).toThrow(/passa do valor/);
    let item = sharing.request(f.ledger, op.id, "Plano", "300.00", d("2026-03-06"));
    expect(() => sharing.request(f.ledger, op.id, "Plano", "100.00")).toThrow(/já tem/);
    expect(sharing.state(f.ledger, item)).toBe(sharing.ReimbursementState.PENDING);
    sharing.receive(f.ledger, item.id, f.bank, "100.00", d("2026-04-02"));
    item = sharing.reimbursements(f.ledger).get(item.id)!;
    expect(sharing.state(f.ledger, item)).toBe(sharing.ReimbursementState.PARTIAL);
    sharing.receive(f.ledger, item.id, f.bank, "200.00", d("2026-04-09"));
    item = sharing.reimbursements(f.ledger).get(item.id)!;
    expect(sharing.state(f.ledger, item)).toBe(sharing.ReimbursementState.RECEIVED);
    expect(fx(sharing.received(f.ledger, item))).toBe("300.00");
    const april = queries.incomeStatement(f.ledger, ym(2026, 4));
    expect(fx(april.expense.get(health)!)).toBe("-300.00");
    expect(april.totalIncome.isZero()).toBe(true); // never counted as income
    expect(sharing.openItems(f.ledger)).toEqual([]);
  });

  it("a denied reimbursement", () => {
    const f = family();
    const op = f.ledger.recordExpense(f.bank, f.groceries, "80.00", d("2026-03-05"), "Almoço de trabalho");
    const item = sharing.request(f.ledger, op.id, "Empresa", "80.00");
    sharing.deny(f.ledger, item.id, "fora da política");
    expect(sharing.state(f.ledger, sharing.reimbursements(f.ledger).get(item.id)!)).toBe(
      sharing.ReimbursementState.DENIED,
    );
    expect(() => sharing.receive(f.ledger, item.id, f.bank, "10.00", d("2026-03-09"))).toThrow(DomainError);
  });

  it("who owes whom", () => {
    const f = family();
    const rent = category(f.ledger, "Moradia");
    // Ana's own account pays a split expense: Bruno owes his share.
    const op = f.ledger.recordExpense(
      f.bank,
      [
        [rent, "600.00"],
        [rent, "400.00"],
      ],
      "1000.00",
      d("2026-03-01"),
      "Aluguel",
    );
    f.ledger.updateOperation(
      {
        ...op,
        postings: [
          { ...op.postings[0]!, member_id: f.ana },
          { ...op.postings[1]!, member_id: f.bruno },
          op.postings[2]!,
        ],
      },
      "rateio",
    );
    // The joint account paid for Bruno: nobody fronted anything.
    f.ledger.recordExpense(f.joint, f.groceries, "90.00", d("2026-03-02"), "Feira", { member_id: f.bruno });
    // The card (Ana) paid for Bruno.
    f.ledger.recordCardPurchase(f.card, f.groceries, "60.00", d("2026-03-03"), "Lanche", null, { member_id: f.bruno });
    const found = sharing.balances(f.ledger);
    expect(found.map((b) => [b.debtorId, b.creditorId, fx(b.amount)])).toEqual([[f.bruno, f.ana, "460.00"]]);
    sharing.settle(f.ledger, f.bruno, f.ana, "400.00", d("2026-03-20"));
    expect(sharing.balances(f.ledger).map((b) => fx(b.amount))).toEqual(["60.00"]);
    sharing.settle(f.ledger, f.bruno, f.ana, "100.00", d("2026-03-21")); // paid back too much
    expect(sharing.balances(f.ledger).map((b) => [b.debtorId, fx(b.amount)])).toEqual([[f.ana, "40.00"]]);
    expect(() => sharing.settle(f.ledger, f.ana, f.ana, "1.00", d("2026-03-22"))).toThrow(DomainError);
  });
});

describe("bank checks", () => {
  it("show the difference until the missing operation is registered", () => {
    const f = family();
    f.ledger.recordOpeningBalance(f.bank, "1000.00", d("2026-01-01"));
    const check = balanceChecks.record(f.ledger, f.bank, d("2026-01-31"), "880.00", "extrato");
    const [result] = balanceChecks.results(f.ledger, f.bank);
    expect(fx(result!.difference)).toBe("-120.00");
    expect(result!.matches).toBe(false);
    expect(balanceChecks.divergent(f.ledger).length).toBe(1);
    f.ledger.recordExpense(f.bank, f.groceries, "120.00", d("2026-01-20"), "Compra esquecida");
    expect(balanceChecks.divergent(f.ledger)).toEqual([]);
    f.ledger.recordExpense(f.bank, f.groceries, "10.00", d("2026-02-01"), "Depois da conferência");
    expect(balanceChecks.divergent(f.ledger)).toEqual([]); // the check compares on its own date
    balanceChecks.remove(f.ledger, check.id);
    expect(balanceChecks.results(f.ledger)).toEqual([]);
  });
});

describe("deductible expenses", () => {
  it("totals per person and kind", () => {
    const f = family();
    const health = category(f.ledger, "Saúde");
    const dentist = f.ledger.addAccount(
      LedgerAccountSchema.parse({
        name: "Dentista",
        type: AccountType.EXPENSE,
        subtype: AccountSubtype.CATEGORY,
        parent_id: health,
      }),
    );
    deductibles.mark(f.ledger, health, deductibles.DeductibleKind.HEALTH);
    expect(deductibles.kindOf(f.ledger, dentist.id)).toBe(deductibles.DeductibleKind.HEALTH); // inherited
    f.ledger.recordExpense(f.bank, dentist.id, "500.00", d("2026-05-02"), "Canal", { member_id: f.bruno });
    f.ledger.recordExpense(f.bank, health, "200.00", d("2026-06-02"), "Consulta", { member_id: f.bruno });
    f.ledger.recordExpense(f.bank, health, "90.00", d("2025-12-02"), "Ano anterior", { member_id: f.bruno });
    f.ledger.recordExpense(f.bank, f.groceries, "70.00", d("2026-06-03"), "Mercado", { member_id: f.bruno });
    const consult = f.ledger.recordExpense(f.bank, health, "300.00", d("2026-07-02"), "Consulta Ana", {
      member_id: f.ana,
    });
    const item = sharing.request(f.ledger, consult.id, "Plano", "100.00");
    sharing.receive(f.ledger, item.id, f.bank, "100.00", d("2026-07-20"));
    const groups = new Map(deductibles.annual(f.ledger, 2026).map((g) => [`${g.kind}|${g.memberId}`, g]));
    expect(fx(groups.get(`health|${f.bruno}`)!.total)).toBe("700.00");
    expect(fx(groups.get(`health|${f.ana}`)!.total)).toBe("200.00"); // net of the reimbursement
    expect(groups.size).toBe(2);
    deductibles.mark(f.ledger, health, null);
    expect(deductibles.annual(f.ledger, 2026)).toEqual([]);
    expect(() => deductibles.mark(f.ledger, f.bank, deductibles.DeductibleKind.OTHER)).toThrow(DomainError);
  });
});

function rule(
  f: Family,
  description: string,
  amount: string,
  frequency: Frequency = Frequency.MONTHLY,
): RecurrenceRule {
  return addRule(
    f.ledger,
    RecurrenceRuleSchema.parse({
      description,
      account_id: f.card_account,
      counterpart_id: category(f.ledger, "Serviços e assinaturas"),
      amount,
      frequency,
      day: 12,
      start: "2026-01-01",
    }),
  );
}

describe("subscriptions", () => {
  it("commitments cost per year and price changes", () => {
    const f = family();
    const streaming = rule(f, "Streaming", "39.90");
    rule(f, "Antivírus", "120.00", Frequency.YEARLY);
    rule(f, "Aula", "50.00", Frequency.WEEKLY);
    const found = new Map(subscriptions.commitments(f.ledger).map((c) => [c.rule.description, c]));
    expect(fx(found.get("Streaming")!.perYear)).toBe("478.80");
    expect([fx(found.get("Antivírus")!.perYear), fx(found.get("Aula")!.perYear)]).toEqual(["120.00", "2600.00"]);
    expect(fx(subscriptions.yearlyTotal(f.ledger))).toBe("3198.80");
    const services = category(f.ledger, "Serviços e assinaturas");
    for (const [month, value] of [
      ["01", "39.90"],
      ["02", "44.90"],
    ] as const) {
      const op = f.ledger.recordCardPurchase(f.card, services, value, d(`2026-${month}-12`), "STREAMING");
      realize(f.ledger, streaming.id, d(`2026-${month}-12`), op.id);
    }
    const changed = subscriptions.commitments(f.ledger).find((c) => c.rule.id === streaming.id)!;
    expect(changed.priceChanged).toBe(true);
    expect([fx(changed.lastPaid!), fx(changed.previousPaid!)]).toEqual(["44.90", "39.90"]);
  });

  it("recurring charges without a rule are suggested", () => {
    const f = family();
    const services = category(f.ledger, "Serviços e assinaturas");
    for (const month of [1, 2, 3, 4]) {
      f.ledger.recordCardPurchase(f.card, services, "21.90", d(`2026-0${month}-08`), "SPOTIFY P1A2B3");
    }
    f.ledger.recordCardPurchase(f.card, services, "15.00", d("2026-01-09"), "AVULSO");
    const [found, ...rest] = subscriptions.candidates(f.ledger, d("2026-04-20"));
    expect(rest).toEqual([]);
    expect([found!.description, fx(found!.amount), found!.day]).toEqual(["SPOTIFY P1A2B3", "21.90", 8]);
    expect([found!.accountId, found!.categoryId, found!.months]).toEqual([f.card_account, services, 4]);
    expect(subscriptions.candidates(f.ledger, d("2026-08-01"))).toEqual([]); // stopped: no longer suggested
    rule(f, "Spotify", "21.90");
    expect(subscriptions.candidates(f.ledger, d("2026-04-20"))).toEqual([]); // already registered
  });
});

describe("indicators and comparisons", () => {
  it("indicators say why they are unavailable", () => {
    const f = family();
    const march = ym(2026, 3);
    let found = new Map(indicators.indicators(f.ledger, march).map((i) => [i.key, i]));
    expect([...found.values()].every((i) => i.value === null)).toBe(true);
    expect(found.get("savings")!.detail).toBe("Sem receitas no mês.");
    f.ledger.recordOpeningBalance(f.bank, "6000.00", d("2026-01-01"));
    for (const month of [1, 2, 3]) {
      f.ledger.recordIncome(f.bank, f.salary, "5000.00", d(`2026-0${month}-05`), "Salário");
      f.ledger.recordExpense(f.bank, f.groceries, "1000.00", d(`2026-0${month}-08`), "Mercado");
    }
    const rentRule = addRule(
      f.ledger,
      RecurrenceRuleSchema.parse({
        description: "Aluguel",
        account_id: f.bank,
        counterpart_id: category(f.ledger, "Moradia"),
        amount: "1000",
        day: 10,
        start: "2026-03-01",
      }),
    );
    const rent = f.ledger.recordExpense(f.bank, category(f.ledger, "Moradia"), "1000.00", d("2026-03-10"), "Aluguel");
    realize(f.ledger, rentRule.id, d("2026-03-10"), rent.id);
    recordInstallmentPurchase(f.ledger, f.card, f.groceries, "1500.00", d("2026-02-20"), "Geladeira", 3);
    found = new Map(indicators.indicators(f.ledger, march).map((i) => [i.key, i]));
    expect(fx(found.get("savings")!.value!)).toBe("0.6000"); // (5000 − 1000 − 1000) / 5000; the fridge is February's
    expect(fx(found.get("fixed")!.value!)).toBe("0.5000");
    expect(fx(found.get("committed")!.value!)).toBe("0.1000"); // one 500,00 installment of the fridge in the March bill
    expect(found.get("reserve")!.value).not.toBeNull();
    expect(found.get("reserve")!.unit).toBe("meses");
  });

  it("a comparison ignores months before the first record", () => {
    const f = family();
    f.ledger.recordOpeningBalance(f.bank, "1000.00", d("2025-01-01")); // not activity
    expect(comparisons.firstActivity(f.ledger)).toBeNull();
    f.ledger.recordExpense(f.bank, f.groceries, "300.00", d("2026-02-03"), "Feira");
    f.ledger.recordExpense(f.bank, f.groceries, "600.00", d("2026-03-03"), "Feira");
    const rows = new Map(comparisons.categoryComparison(f.ledger, ym(2026, 3)).map((r) => [r.categoryId, r]));
    const row = rows.get(f.groceries)!;
    expect([fx(row.current), fx(row.average!), row.monthsAveraged]).toEqual(["600.00", "300.00", 1]);
    expect(fx(row.change!)).toBe("1.0000");
    expect(row.lastYear).toBeNull();
    const totals = new Map(comparisons.totalsComparison(f.ledger, ym(2026, 2)).map((r) => [r.name, r]));
    expect(totals.get("Despesas")!.average).toBeNull(); // nothing known before February
  });
});

describe("projection", () => {
  it("projected balance before going negative", () => {
    const f = family();
    const today = d("2026-03-01");
    f.ledger.recordOpeningBalance(f.bank, "1000.00", d("2026-01-01"));
    f.ledger.recordCardPurchase(f.card, f.groceries, "700.00", d("2026-02-20"), "Mercado"); // due 10/03 from bank
    for (const [description, counterpart, amount, day] of [
      ["Aluguel", category(f.ledger, "Moradia"), "500", 15],
      ["Salário", f.salary, "3000", 30],
    ] as const) {
      addRule(
        f.ledger,
        RecurrenceRuleSchema.parse({
          description,
          account_id: f.bank,
          counterpart_id: counterpart,
          amount,
          day,
          start: "2026-03-01",
        }),
      );
    }
    const [bank] = projection.project(f.ledger, today, 40, [f.bank]);
    expect(bank!.events.map((e) => [e.on, fx(e.amount)])).toEqual([
      ["2026-03-10", "-700.00"],
      ["2026-03-15", "-500"],
      ["2026-03-30", "3000"],
    ]);
    expect(bank!.firstNegative).toBe("2026-03-15");
    expect(j(bank!.lowest)).toEqual(["2026-03-15", { $dec: "-200.00" }]);
    expect(fx(bank!.balanceOn(d("2026-04-01")))).toBe("2800.00");
    expect(projection.negativeAhead(f.ledger, today).map((p) => p.accountId)).toEqual([f.bank]);
    expect(fx(queries.balance(f.ledger, f.bank))).toBe("1000.00"); // a projection never changes balances
    const daily = bank!.daily(d("2026-04-10"));
    expect(daily.every(([, v]) => v !== null)).toBe(true);
  });

  it("a card without a payment account is left out with a note", () => {
    const f = family();
    const card = f.ledger.cards.get(f.card)!;
    f.ledger.updateCard({ ...card, settlement_account_id: null }, "sem conta");
    f.ledger.recordCardPurchase(f.card, f.groceries, "100.00", d("2026-02-20"), "Mercado");
    const [found, notes] = projection.events(f.ledger, d("2026-03-01"), d("2026-04-01"));
    expect(found).toEqual([]);
    expect(notes).toEqual(["Fatura de Cartão X sem conta de pagamento: fora da projeção."]);
  });
});

describe("persistence", () => {
  it("new kinds survive a save and open", () => {
    const f = family();
    const plan = loans.createLoan(f.ledger, loan(f), loans.Opening.OPENING_BALANCE, { on: d("2026-01-10") });
    loans.payInstallment(f.ledger, plan.id, 1, d("2026-02-10"));
    loans.prepay(f.ledger, plan.id, "100.00", d("2026-02-11"), loans.PrepaymentMode.REDUCE_PAYMENT);
    const op = f.ledger.recordExpense(f.bank, category(f.ledger, "Saúde"), "200.00", d("2026-02-03"), "Consulta");
    tags.addTag(f.ledger, [op.id], "Saúde");
    const item = sharing.request(f.ledger, op.id, "Plano", "100.00");
    sharing.receive(f.ledger, item.id, f.bank, "50.00", d("2026-02-20"));
    sharing.settle(f.ledger, f.bruno, f.ana, "10.00", d("2026-02-21"));
    balanceChecks.record(f.ledger, f.bank, d("2026-02-28"), "0.00");
    deductibles.mark(f.ledger, category(f.ledger, "Saúde"), deductibles.DeductibleKind.HEALTH);
    const rows = JSON.parse(JSON.stringify(f.ledger.toRecords())) as LedgerRecord[];
    const opened = Ledger.fromRecords(rows);
    for (const kind of [
      "loan_plan",
      "loan_payment",
      "loan_prepayment",
      "operation_tags",
      "reimbursement",
      "member_settlement",
      "balance_check",
      "deductible_category",
    ]) {
      const a = [...opened.entities(kind).values()].map(dump);
      const b = [...f.ledger.entities(kind).values()].map(dump);
      expect(a, kind).toEqual(b);
    }
    expect(j(loans.status(opened, plan.id, d("2026-10-05")).installments)).toEqual(
      j(loans.status(f.ledger, plan.id, d("2026-10-05")).installments),
    );
  });
});
