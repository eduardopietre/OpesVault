/**
 * Support for the income tax return: ids, sheets, checklist, variable income and the
 * simplified/itemized simulation. All rates and tables are typed by the test. Port of `tests/test_tax.py`.
 *
 * `test_informe_is_read_and_checked_against_the_records` reads the text lines of the synthetic PDF
 * (`synthetic_docs.bank_income_report_pdf`) instead of the PDF: extracting text is the import
 * pipeline's job (`statements.read`, TODO(W6-integration)).
 */
import { describe, expect, it } from "vitest";

import * as alerts from "../src/domain/alerts.ts";
import * as deductibles from "../src/domain/deductibles.ts";
import { DomainError, Ledger } from "../src/domain/ledger.ts";
import { AccountSubtype, AccountType, LedgerAccountSchema } from "../src/domain/model.ts";
import * as sharing from "../src/domain/sharing.ts";
import { exporting } from "../src/index.ts";
import type { IsoDate } from "../src/lib/dates.ts";
import { AssetClass, TrackingMode, ValueNature } from "../src/investments/model.ts";
import * as inv from "../src/investments/service.ts";
import * as trades from "../src/investments/trades.ts";
import * as checklist from "../src/tax/checklist.ts";
import * as declaration from "../src/tax/declaration.ts";
import * as ids from "../src/tax/ids.ts";
import * as issues from "../src/tax/issues.ts";
import {
  BracketSchema,
  Bucket,
  BucketRuleSchema,
  DeclaredAssetSchema,
  FilingSubject,
  IncomeKind,
  IncomeNature,
  NatureSubject,
  PaymentPurpose,
  ReportField,
  ReportLineSchema,
  ReportSource,
  TaxParametersSchema,
  TaxSubject,
} from "../src/tax/model.ts";
import * as records from "../src/tax/records.ts";
import * as simulation from "../src/tax/simulation.ts";
import * as statements from "../src/tax/statements.ts";
import * as variableIncome from "../src/tax/variable_income.ts";
import { category, family } from "./fixtures.ts";

const CNPJ = "11.222.333/0001-81";
const CPF_ANA = "529.982.247-25";
const CPF_BRUNO = "111.444.777-35";
const Y = 2025;
const d = (s: string) => s as IsoDate;
const TODAY = d("2026-10-05");

function salarySetup() {
  const f = family();
  const ledger = f.ledger;
  records.classify(ledger, NatureSubject.CATEGORY, f.salary, IncomeNature.TAXABLE_PJ);
  records.setIdentity(ledger, TaxSubject.CATEGORY, f.salary, CNPJ, "Empresa Exemplo Ltda");
  const jan = ledger.recordIncome(f.bank, f.salary, "4000.00", d(`${Y}-01-05`), "Salário", { member_id: f.ana });
  records.setIncomeDetail(ledger, jan.id, IncomeKind.SALARY, "5000.00", "450.00", "550.00");
  const dec = ledger.recordIncome(f.bank, f.salary, "2000.00", d(`${Y}-12-20`), "13º", { member_id: f.ana });
  records.setIncomeDetail(ledger, dec.id, IncomeKind.THIRTEENTH, "2400.00", "150.00", null);
  ledger.recordIncome(f.bank, f.salary, "4000.00", d(`${Y}-02-05`), "Salário", { member_id: f.ana }); // net only
  return f;
}

describe("tax", () => {
  it("tax ids check digits", () => {
    expect(ids.isCpf(CPF_ANA) && ids.isCnpj(CNPJ)).toBe(true);
    expect(ids.isCpf("529.982.247-24") || ids.isCnpj("11.222.333/0001-80")).toBe(false);
    expect(ids.isCpf("111.111.111-11")).toBe(false);
    expect(ids.normalize(CNPJ)).toBe("11222333000181");
    expect(ids.display("52998224725")).toBe(CPF_ANA);
    expect(() => ids.normalize("123")).toThrow(DomainError);
    expect(() => ids.normalize(CNPJ, [ids.TaxIdKind.CPF])).toThrow(DomainError);
    expect(ids.findCnpj(`Banco - CNPJ ${CNPJ}`)).toBe("11222333000181");
  });

  it("taxable income by payer uses the payslip's gross", () => {
    const f = salarySetup();
    const found = declaration.income(f.ledger, Y);
    expect(found.taxable).toHaveLength(1);
    const row = found.taxable[0]!;
    expect(row.tax_id).toBe("11222333000181");
    expect(row.payer).toBe("Empresa Exemplo Ltda");
    expect(row.taxable.eq("9000.00")).toBe(true); // 5000 gross + 4000 net-only
    expect(row.withheld.eq("450.00") && row.social_security.eq("550.00")).toBe(true);
    expect(row.thirteenth.eq("2400.00") && row.thirteenth_withheld.eq("150.00")).toBe(true);
    expect(row.net_only).toBe(1);
    expect(() => records.setIncomeDetail(f.ledger, row.operations[0]!, IncomeKind.SALARY, "100.00")).toThrow(
      DomainError,
    ); // gross < received
  });

  it("unclassified income is flagged, not guessed", () => {
    const f = family();
    const rent = f.ledger.addAccount(
      LedgerAccountSchema.parse({
        name: "Aluguel recebido",
        type: AccountType.INCOME,
        subtype: AccountSubtype.CATEGORY,
      }),
    );
    f.ledger.recordIncome(f.bank, rent.id, "1500.00", d(`${Y}-03-01`), "Aluguel", { member_id: f.ana });
    let found = declaration.income(f.ledger, Y);
    expect(declaration.unclassified(found).map((r) => r.source)).toEqual(["Aluguel recebido"]);
    const titles = issues.issues(f.ledger, Y, null, d(`${Y + 1}-03-01`)).map((i) => i.title);
    expect(titles).toContain("Natureza do rendimento: Aluguel recebido");
    records.classify(f.ledger, NatureSubject.CATEGORY, rent.id, IncomeNature.CARNE_LEAO);
    found = declaration.income(f.ledger, Y);
    expect(declaration.unclassified(found)).toEqual([]);
    expect(found.carne_leao).toHaveLength(1);
    const month = found.carne_leao[0]!;
    expect(month.month).toEqual({ year: Y, month: 3 });
    expect(month.amount.eq("1500.00") && month.paid.isZero()).toBe(true);
    const foundIssues = issues.issues(f.ledger, Y, null, d(`${Y}-04-10`));
    expect(foundIssues.some((i) => i.title.startsWith("Carnê-Leão 03/2025"))).toBe(true);
    records.recordPayment(
      f.ledger,
      PaymentPurpose.CARNE_LEAO,
      { year: Y, month: 3 },
      "100.00",
      d(`${Y}-04-20`),
      f.bank,
      f.ana,
    );
    expect(declaration.income(f.ledger, Y).carne_leao[0]!.paid.eq("100.00")).toBe(true);
  });

  it("payments show paid and reimbursed parts per payee", () => {
    const f = family();
    const ledger = f.ledger;
    const health = category(ledger, "Saúde");
    deductibles.mark(ledger, health, deductibles.DeductibleKind.HEALTH);
    const op = ledger.recordExpense(f.bank, health, "800.00", d(`${Y}-05-02`), "CLINICA SORRISO LTDA", {
      member_id: f.bruno,
    });
    ledger.recordExpense(f.bank, health, "200.00", d(`${Y}-06-02`), "CLINICA SORRISO LTDA", { member_id: f.bruno });
    const item = sharing.request(ledger, op.id, "Plano de saúde", "300.00");
    sharing.receive(ledger, item.id, f.bank, "300.00", d(`${Y}-05-20`));
    const rows = declaration.payments(ledger, Y);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.paid.eq("1000.00") && row.not_deductible.eq("300.00") && declaration.paymentNet(row).eq("700.00")).toBe(
      true,
    );
    expect(row.beneficiary_id).toBe(f.bruno);
    expect(row.without_receipt).toBe(2);
    expect(row.tax_id).toBeNull();
    const found = issues.issues(ledger, Y, null, d(`${Y + 1}-03-01`));
    expect(found.some((i) => i.title === `CPF/CNPJ de quem recebeu: ${row.payee}`)).toBe(true);
    records.setIdentity(ledger, TaxSubject.MERCHANT, row.payee_key, CNPJ);
    expect(declaration.payments(ledger, Y)[0]!.tax_id).toBe("11222333000181");
  });

  it("assets at cost and debts on December 31", () => {
    const f = family();
    const ledger = f.ledger;
    ledger.recordOpeningBalance(f.bank, "3000.00", d(`${Y - 1}-06-01`));
    const pos = inv.createPosition(ledger, "CDB X", AssetClass.FIXED_INCOME, d(`${Y}-02-01`), {
      initial_cost: "5000",
      from_account: f.bank,
      holder_id: f.ana,
    });
    inv.addValuation(ledger, pos.id, d(`${Y}-12-31`), "5400", ValueNature.GROSS);
    const car = records.saveDeclaredAsset(
      ledger,
      DeclaredAssetSchema.parse({
        name: "Carro",
        group: "02",
        code: "01",
        owner_id: f.ana,
        acquired_on: `${Y}-03-01`,
        cost: "60000.00",
      }),
    );
    const loan = ledger.addAccount(
      LedgerAccountSchema.parse({
        name: "Financiamento",
        type: AccountType.LIABILITY,
        subtype: AccountSubtype.LOAN,
        holders: [f.ana],
      }),
    );
    ledger.recordOpeningBalance(loan.id, "-20000.00", d(`${Y}-03-01`));
    const rows = new Map(declaration.assets(ledger, Y).map((r) => [r.name, r]));
    const cdb = rows.get("CDB X")!;
    expect(cdb.current!.eq("5000.00")).toBe(true); // cost, not the 5400 market value
    expect(cdb.previous!.isZero() && cdb.suggested && cdb.group === "04").toBe(true);
    expect(rows.get("Carro")!.current!.eq("60000.00") && rows.get("Carro")!.previous!.isZero()).toBe(true);
    expect(rows.get("Banco A")!.previous!.eq("3000.00")).toBe(true);
    records.setFiling(ledger, FilingSubject.POSITION, pos.id, "04", "02", "CDB do Banco X");
    expect(declaration.assets(ledger, Y).find((r) => r.name === "CDB X")!.suggested).toBe(false);
    const debts = declaration.debts(ledger, Y);
    expect(debts).toHaveLength(1);
    expect(debts[0]!.name).toBe("Financiamento");
    expect(debts[0]!.current.abs().eq("20000.00")).toBe(true);
    expect(records.declaredAssets(ledger).has(car.id)).toBe(true);
  });

  it("a declarant sees their own and their dependents' items", () => {
    const f = salarySetup();
    const ledger = f.ledger;
    records.setMemberInfo(ledger, f.ana, { cpf: CPF_ANA, birth_date: d("1985-01-01"), declared_by: null }, TODAY);
    records.setMemberInfo(
      ledger,
      f.bruno,
      { cpf: CPF_BRUNO, birth_date: d("2015-01-01"), declared_by: f.ana, relation: "Filho(a)" },
      TODAY,
    );
    expect(records.declarants(ledger)).toEqual([f.ana]);
    expect(records.peopleOf(ledger, f.ana)).toEqual(new Set([f.ana, f.bruno]));
    expect(() =>
      records.setMemberInfo(ledger, f.ana, { cpf: CPF_BRUNO, birth_date: null, declared_by: null }, TODAY),
    ).toThrow(DomainError); // CPF already used
    expect(() =>
      records.setMemberInfo(ledger, f.ana, { cpf: CPF_ANA, birth_date: null, declared_by: f.bruno }, TODAY),
    ).toThrow(DomainError); // declares someone
    const dependents = declaration.dependents(ledger, f.ana);
    expect(dependents.map((x) => x.cpf)).toEqual(["11144477735"]);
    const other = ledger.addMember("Carla").id;
    ledger.recordIncome(f.bank, f.salary, "100.00", d(`${Y}-03-05`), "Bico", { member_id: other });
    expect(declaration.income(ledger, Y, records.peopleOf(ledger, f.ana)).taxable).toHaveLength(1);
  });

  it("the informe is read and checked against the records", () => {
    const f = family();
    const ledger = f.ledger;
    // the text lines of synthetic_docs.bank_income_report_pdf(Y)
    const parsed = statements.parse([
      "Banco Exemplo S.A. - CNPJ 11.222.333/0001-81",
      "INFORME DE RENDIMENTOS FINANCEIROS",
      `Ano-calendário: ${Y}`,
      "Cliente: Ana Teste - CPF 529.982.247-25",
      "1. Saldos",
      `Conta corrente - saldo em 31/12/${Y - 1} R$ 1.000,00`,
      `Conta corrente - saldo em 31/12/${Y} R$ 2.500,00`,
      "2. Rendimentos isentos e não tributáveis",
      "Rendimento de poupança 12,34",
      "3. Rendimentos sujeitos à tributação exclusiva",
      "Aplicações de renda fixa 45,60",
      "Imposto de renda retido na fonte 10,26",
      "Atendimento 0800 000 0000",
    ]);
    expect(parsed.year).toBe(Y);
    expect(parsed.payerTaxId).toBe("11222333000181");
    const fields = new Map(parsed.lines.map((line) => [line.field, line.amount]));
    expect(fields.get(ReportField.BALANCE_PREVIOUS)!.eq("1000.00")).toBe(true);
    expect(fields.get(ReportField.BALANCE_END)!.eq("2500.00")).toBe(true);
    expect(fields.get(ReportField.EXEMPT)!.eq("12.34")).toBe(true);
    expect(fields.get(ReportField.WITHHELD)!.eq("10.26")).toBe(true);
    ledger.recordOpeningBalance(f.bank, "1000.00", d(`${Y - 1}-01-02`));
    ledger.recordIncome(f.bank, f.salary, "1400.00", d(`${Y}-06-01`), "Depósito");
    const report = records.saveReport(ledger, Y, ReportSource.ACCOUNT, f.bank, parsed.lines, {
      payer_tax_id: parsed.payerTaxId,
    });
    const diffs = statements.differences(ledger, report);
    expect(diffs.map((x) => x.field)).toEqual([ReportField.BALANCE_END]); // 2.500 informed, 2.400 recorded
    expect(statements.difference(diffs[0]!)!.eq("100.00")).toBe(true);
    expect(() => records.saveReport(ledger, Y, ReportSource.ACCOUNT, f.bank, [])).toThrow(DomainError); // one per source and year
    const found = issues.issues(ledger, Y, null, d(`${Y + 1}-03-01`));
    expect(found.some((i) => i.title === "Informe diferente do registrado: Banco A")).toBe(true);
  });

  it("the parser never raises on garbage", () => {
    const parsed = statements.parse([
      "",
      "R$ ,00",
      "Saldo em 31/12/abcd 1,00",
      "x".repeat(5000),
      "CNPJ 00.000.000/0000-00",
    ]);
    expect(parsed.payerTaxId).toBeNull();
    expect(parsed.lines.every((line) => !line.amount.isNegative())).toBe(true);
  });

  it("the checklist lists informes and receipts", () => {
    const f = salarySetup();
    const ledger = f.ledger;
    let items = new Map(checklist.expected(ledger, Y).map((i) => [i.key, i]));
    expect(items.has(`informe:conta:${f.bank}`) && items.has(`informe:fonte:${f.salary}`)).toBe(true);
    expect(items.get(`informe:conta:${f.bank}`)!.received).toBe(false);
    records.saveReport(ledger, Y, ReportSource.CATEGORY, f.salary, [
      ReportLineSchema.parse({ field: ReportField.TAXABLE, amount: "9000.00" }),
    ]);
    items = new Map(checklist.expected(ledger, Y).map((i) => [i.key, i]));
    expect(items.get(`informe:fonte:${f.salary}`)!.received).toBe(true);
    records.setMark(ledger, Y, `informe:conta:${f.bank}`, true);
    items = new Map(checklist.expected(ledger, Y).map((i) => [i.key, i]));
    const mark = items.get(`informe:conta:${f.bank}`)!;
    expect(mark.received && mark.by_hand).toBe(true);
  });
});

function stockSetup() {
  const f = family();
  const ledger = f.ledger;
  ledger.recordOpeningBalance(f.bank, "100000.00", d(`${Y - 1}-12-01`));
  const pos = inv.createPosition(ledger, "PETR4", AssetClass.STOCK, d(`${Y}-01-02`), {
    mode: TrackingMode.QUANTITY,
    holder_id: f.ana,
  });
  trades.buy(ledger, pos.id, d(`${Y}-01-02`), "1000", "20.00", f.bank);
  return { f, pos };
}

describe("variable income", () => {
  it("exemption, losses and day trade", () => {
    const { f, pos } = stockSetup();
    const ledger = f.ledger;
    records.setVariableRules(
      ledger,
      d("2000-01-01"),
      [
        BucketRuleSchema.parse({ bucket: Bucket.COMMON, rate: "0.15", exempt_sales_limit: "20000.00" }),
        BucketRuleSchema.parse({ bucket: Bucket.DAY_TRADE, rate: "0.20" }),
      ],
      "teste",
    );
    trades.sell(ledger, pos.id, d(`${Y}-02-10`), "100", "25.00", f.bank); // 2.500 in sales, +500: exempt
    trades.sell(ledger, pos.id, d(`${Y}-03-10`), "500", "18.00", f.bank); // -1.000: loss carried
    trades.sell(ledger, pos.id, d(`${Y}-04-10`), "400", "70.00", f.bank); // 28.000 sales, +20.000 taxable
    trades.buy(ledger, pos.id, d(`${Y}-05-05`), "100", "10.00", f.bank);
    trades.sell(ledger, pos.id, d(`${Y}-05-05`), "100", "12.00", f.bank); // day trade +200
    const months = variableIncome.months(ledger, Y);
    const rows = new Map(months.map((r) => [`${r.month.month}|${r.bucket}`, r]));
    const feb = rows.get("2|common")!;
    const mar = rows.get("3|common")!;
    const apr = rows.get("4|common")!;
    expect(feb.exempt_gain.eq("500.00") && feb.tax!.isZero()).toBe(true);
    expect(mar.result.eq("-1000.00") && mar.loss_carried.eq("1000.00")).toBe(true);
    expect(apr.compensated.eq("1000.00") && apr.base.eq("19000.00")).toBe(true);
    expect(apr.tax!.eq("2850.00")).toBe(true);
    expect(apr.due_date).toBe(`${Y}-05-30`);
    const day = rows.get("5|day_trade")!;
    expect(day.result.eq("200.00") && day.tax!.eq("40.00") && day.approximate).toBe(true);
    let due = variableIncome.dueByMonth(months);
    expect(due.get(`${Y}-04`)!.due.eq("2850.00")).toBe(true);
    records.recordPayment(
      ledger,
      PaymentPurpose.VARIABLE_INCOME,
      { year: Y, month: 4 },
      "2850.00",
      d(`${Y}-05-20`),
      f.bank,
    );
    due = variableIncome.dueByMonth(variableIncome.months(ledger, Y));
    expect(due.get(`${Y}-04`)!.paid.eq("2850.00")).toBe(true);
  });

  it("without a rate the tax is unknown, not zero", () => {
    const { f, pos } = stockSetup();
    trades.sell(f.ledger, pos.id, d(`${Y}-04-10`), "1000", "30.00", f.bank);
    const months = variableIncome.months(f.ledger, Y);
    expect(months).toHaveLength(1);
    const row = months[0]!;
    expect(row.base.eq("10000.00") && row.tax === null && row.due === null).toBe(true);
    expect(variableIncome.missingRate(row)).toBe(true);
    expect(
      issues.issues(f.ledger, Y, null, d(`${Y + 1}-03-01`)).some((i) => i.title === "Alíquotas de renda variável"),
    ).toBe(true);
  });
});

describe("simulation", () => {
  it("simplified and itemized with the user's table", () => {
    const f = salarySetup();
    const ledger = f.ledger;
    const health = category(ledger, "Saúde");
    deductibles.mark(ledger, health, deductibles.DeductibleKind.HEALTH);
    ledger.recordExpense(f.bank, health, "3000.00", d(`${Y}-05-02`), "Hospital", { member_id: f.ana });
    let comparison = simulation.compare(ledger, Y, null);
    expect(comparison.simplified).toBeNull();
    expect(comparison.missing).toContain("a tabela anual de 2025");
    records.setParameters(
      ledger,
      TaxParametersSchema.parse({
        year: Y,
        brackets: [
          BracketSchema.parse({ up_to: "5000.00", rate: "0", deduction: "0" }),
          BracketSchema.parse({ up_to: null, rate: "0.10", deduction: "500.00" }),
        ],
        simplified_rate: "0.20",
        simplified_cap: "1000.00",
      }),
    );
    comparison = simulation.compare(ledger, Y, null);
    expect(comparison.taxable.eq("9000.00") && comparison.withheld.eq("450.00")).toBe(true);
    expect(Object.fromEntries([...comparison.deductions].map(([k, v]) => [k, v.toString()]))).toEqual({
      "Previdência oficial (INSS)": "550.00",
      "Despesas médicas": "3000.00",
    });
    expect(comparison.simplified!.tax!.eq("300.00")).toBe(true); // 8000*10%-500
    expect(comparison.itemized!.tax!.eq("45.00")).toBe(true); // 5450*10%-500
    expect(simulation.best(comparison)).toBe(comparison.itemized);
    expect(simulation.balanceOf(comparison, comparison.itemized)!.eq("-405.00")).toBe(true);
    expect(() =>
      records.setParameters(
        ledger,
        TaxParametersSchema.parse({
          year: Y,
          brackets: [
            BracketSchema.parse({ up_to: null, rate: "0.1", deduction: "0" }),
            BracketSchema.parse({ up_to: "1", rate: "0", deduction: "0" }),
          ],
        }),
      ),
    ).toThrow(DomainError);
  });

  it("tax records survive save", () => {
    const f = salarySetup();
    const restored = Ledger.fromRecords(JSON.parse(JSON.stringify(f.ledger.toRecords())));
    expect(declaration.income(restored, Y).taxable[0]!.tax_id).toBe("11222333000181");
  });

  it("tax reminders reach the attention panel", () => {
    const f = family();
    const rent = f.ledger.addAccount(
      LedgerAccountSchema.parse({
        name: "Aluguel recebido",
        type: AccountType.INCOME,
        subtype: AccountSubtype.CATEGORY,
      }),
    );
    records.classify(f.ledger, NatureSubject.CATEGORY, rent.id, IncomeNature.CARNE_LEAO);
    f.ledger.recordIncome(f.bank, rent.id, "1500.00", d("2026-08-01"), "Aluguel", { member_id: f.ana });
    const found = alerts.alerts(f.ledger, d("2026-09-25")).filter((a) => a.target === alerts.Target.TAX);
    expect(found.map((a) => a.title)).toEqual(["Carnê-Leão 08/2026: Ana"]);
    expect(found[0]!.dueOn).toBe("2026-09-30");
  });

  it("the report for the return lists the sheets", () => {
    const f = salarySetup();
    const html = exporting.taxReportHtml(f.ledger, Y, TODAY, null);
    expect(html).toContain("Empresa Exemplo Ltda");
    expect(html).toContain("11.222.333/0001-81");
    expect(html).toContain("Bens e direitos");
    expect(html).toContain("Pendências");
  });
});
