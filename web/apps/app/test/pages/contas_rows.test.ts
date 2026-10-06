/** Contas e cartões without React: the rows of each table and the references of the links. */
import { Dec, charts, demoSession, dom, makeDate, type Ledger } from "@opesvault/domain";
import { beforeAll, describe, expect, it } from "vitest";
import { toChartData } from "../../src/data/chart_data.ts";
import {
  TAB_IDS,
  TAB_LABELS,
  accountRows,
  bankRows,
  billRows,
  cardRows,
  categoryRows,
  cents,
  checkLabel,
  defaultBill,
  installmentRows,
  loanRows,
  memberRows,
  nextInstallment,
  parseReveal,
  partRows,
  plural,
  proposalRows,
  rateLabel,
  ruleRows,
  summaryLine,
  whereLine,
} from "../../src/pages/contas/rows.ts";

let ledger: Ledger;
const today = makeDate(2026, 10, 6);

beforeAll(async () => {
  ledger = (await demoSession({ today })).ledger;
});

describe("what a link points to", () => {
  it("reads each reference of the contract", () => {
    const card = [...ledger.cards.values()][0]!;
    const plan = [...dom.loans.plans(ledger).values()][0]!;
    const bank = [...dom.banking.bankAccounts(ledger).values()][0]!;
    const account = [...ledger.accounts.values()][0]!;
    expect(parseReveal(`${card.id}:2026-10`, ledger)).toEqual({
      kind: "bill",
      cardId: card.id,
      month: { year: 2026, month: 10 },
    });
    expect(parseReveal(`loan:${plan.id}:9`, ledger)).toEqual({ kind: "loan", planId: plan.id, number: 9 });
    expect(parseReveal(`loan:${plan.id}`, ledger)).toEqual({ kind: "loan", planId: plan.id, number: null });
    expect(parseReveal("check:acc", ledger)).toEqual({ kind: "check", accountId: "acc" });
    expect(parseReveal("conta:acc", ledger)).toEqual({ kind: "account", accountId: "acc" });
    expect(parseReveal("cartao:c1", ledger)).toEqual({ kind: "card", cardId: "c1" });
    expect(parseReveal("banco:b1", ledger)).toEqual({ kind: "bank", bankId: "b1" });
    // a bare id is looked up
    expect(parseReveal(card.id, ledger)).toEqual({ kind: "bill", cardId: card.id, month: null });
    expect(parseReveal(plan.id, ledger)).toEqual({ kind: "loan", planId: plan.id, number: null });
    expect(parseReveal(bank.id, ledger)).toEqual({ kind: "bank", bankId: bank.id });
    expect(parseReveal(account.id, ledger)?.kind).toBe("account");
  });

  it("ignores what it does not know", () => {
    expect(parseReveal(undefined, ledger)).toBeNull();
    expect(parseReveal("", ledger)).toBeNull();
    expect(parseReveal("nao-existe", ledger)).toBeNull();
    expect(parseReveal("x:2026-13", ledger)).toBeNull();
    expect(parseReveal("x:y:z", ledger)).toBeNull();
  });

  it("names the eight tabs in the desktop's order", () => {
    expect(TAB_IDS.map((id) => TAB_LABELS[id])).toEqual([
      "Contas bancárias",
      "Todas as contas",
      "Cartões",
      "Faturas",
      "Financiamentos",
      "Categorias",
      "Regras",
      "Integrantes",
    ]);
  });
});

describe("the tables", () => {
  it("sorts money by exact cents and keeps unknown apart from zero", () => {
    expect(cents(Dec.from("1234.565"))).toBe(123457n);
    expect(cents(Dec.from("-0.004"))).toBe(0n);
    expect(cents(null)).toBeNull();
    expect(plural(1, "conta", "contas")).toBe("1 conta");
    expect(plural(2, "conta", "contas")).toBe("2 contas");
  });

  it("counts accounts, cards and members in the line under the title", () => {
    expect(summaryLine(ledger)).toMatch(/^\d+ contas · 1 cartão · 2 integrantes$/);
  });

  it("lists members, cards and categories", () => {
    expect(memberRows(ledger).map((m) => [m.name, m.status])).toEqual([
      ["Ana", "Ativo"],
      ["Bruno", "Ativo"],
    ]);
    const [card] = cardRows(ledger);
    expect(card).toMatchObject({ name: "Cartão X", last4: "1234" });
    expect(categoryRows(ledger).some((c) => c.name === "Saúde" && c.deductible !== "")).toBe(true);
    expect(categoryRows(ledger).find((c) => c.name === "Salário")!.kind).toBe("Receita");
  });

  it("says what the last check against the bank found", () => {
    const rows = accountRows(ledger);
    const banco = rows.find((r) => r.name === "Banco A")!;
    expect(banco.diverges).toBe(true);
    expect(banco.checked).toMatch(/^31\/03\/2026: diferença de /);
    expect(rows.find((r) => r.name === "Poupança")!.checked).toBe("nunca");
    const latest = dom.balanceChecks.latest(ledger).values().next().value!;
    expect(checkLabel(latest)).toContain("31/03/2026");
    expect(checkLabel(undefined)).toBe("nunca");
  });

  it("builds the bank accounts with parts, joint holders and the composition", () => {
    const rows = bankRows(ledger, today);
    const itau = rows.find((r) => r.name === "Itaú da Ana")!;
    expect(itau.holders).toBe("Ana e Bruno (conjunta)");
    expect(itau.bank).toMatch(/^341 — /);
    expect(itau.total).toMatch(/^R\$ /);
    const nubank = rows.find((r) => r.name === "Nubank do Bruno")!;
    expect(nubank.savings).toBe("—");
    expect(nubank.investments).toBe("—");
    const item = [...dom.banking.bankAccounts(ledger).values()].find((b) => b.name === "Itaú da Ana")!;
    const parts = partRows(ledger, item, today);
    expect(parts.map((p) => p.kind)).toEqual(["checking", "savings", "investment"]);
    expect(parts[2]).toMatchObject({ yield: "110% do CDI", maturity: "03/01/2028" });
    expect(parts[0]!.irpf).toContain("06.01");
    expect(whereLine(ledger, item)).toBe(
      "ITAÚ UNIBANCO S.A. (341), ag. 0123, conta 45678-9 · titular Ana, segundo titular Bruno",
    );
  });

  it("builds the bills around today, hides empty ones and selects the oldest with a balance", () => {
    const card = [...ledger.cards.values()][0]!;
    const rows = billRows(ledger, card.id, today);
    expect(rows.length).toBeGreaterThan(2);
    expect(rows.every((r) => !(r.total.isZero() && r.paid.isZero()))).toBe(true);
    expect(rows.map((r) => r.due)).toEqual([...rows.map((r) => r.due)].sort());
    const first = defaultBill(rows)!;
    expect(first.remaining.isPositive()).toBe(true);
    expect(rows.find((r) => r.remaining.isPositive())).toBe(first);
    expect(first.statusLabel).toBe("Vencida");
    expect(defaultBill([])).toBeNull();
  });

  it("shows the contract, its schedule and the next installment", () => {
    const [loan] = loanRows(ledger, today);
    expect(loan).toMatchObject({ name: "Financiamento do carro", system: "Price", rate: "1,4900% ao mês" });
    expect(loan!.paid).toBe("2 de 36");
    expect(rateLabel(Dec.from("0.0099"))).toBe("0,9900% ao mês");
    const rows = installmentRows(ledger, loan!.id, today);
    expect(rows).toHaveLength(36);
    expect(rows[0]).toMatchObject({ id: "1", state: "paid", stateLabel: "Paga" });
    expect(nextInstallment(rows)).toMatchObject({ number: 3, state: "overdue" });
    expect(rows.at(-1)!.balanceAfter.isZero()).toBe(true);
  });

  it("lists the rules and the proposals the family's choices suggest", () => {
    const rules = ruleRows(ledger);
    expect(rules.map((r) => r.pattern)).toContain("PADARIA");
    expect(rules.every((r) => r.state.startsWith("Ativa"))).toBe(true);
    const proposals = proposalRows(ledger);
    expect(proposals.length).toBeGreaterThan(0);
    expect(proposals.length).toBeLessThanOrEqual(12);
    expect(proposals.every((p) => p.count >= 3)).toBe(true);
  });
});

describe("the charts", () => {
  it("draws the bank's informed balances as isolated points and hides what the domain hides", () => {
    const account = [...ledger.accounts.values()].find((a) => a.name === "Banco A")!;
    const data = toChartData(
      charts.data.accountBalanceHistory(ledger, account.id, { year: 2025, month: 11 }, { year: 2026, month: 10 }),
    );
    expect(data.series.map((s) => [s.name, s.kind])).toEqual([
      ["Saldo no fim do mês", "line"],
      ["Saldo informado pelo banco", "line"],
    ]);
    expect(data.series[1]!.values.filter((v) => v !== null)).toHaveLength(1);
    const card = [...ledger.cards.values()][0]!;
    const bills = toChartData(charts.data.cardBillsHistory(ledger, card.id, [{ year: 2026, month: 4 }]));
    expect(bills.series.find((s) => s.name === "Parcelas")!.hidden).toBe(true);
  });

  it("labels each installment of the schedule by its month", () => {
    const plan = [...dom.loans.plans(ledger).values()][0]!;
    const data = toChartData(charts.data.loanChart(ledger, plan.id, today), { monthLabels: true });
    expect(data.categories[0]).toBe("jan/26");
    expect(data.categories).toHaveLength(36);
    expect(data.series.find((s) => s.name === "Parcela")!.hidden).toBe(true);
  });
});
