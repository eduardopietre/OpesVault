/** Imposto de renda without React: the rows of each sheet, the links, the masks and the readers of the dialogs. */
import { Dec, DomainError, demoSession, dom, makeDate, tax } from "@opesvault/domain";
import { describe, expect, it } from "vitest";
import { moneySort } from "../../src/pages/imposto/columns.tsx";
import { yearData } from "../../src/pages/imposto/data.ts";
import {
  assetRows,
  checkRows,
  debtRows,
  documentRows,
  initialYear,
  issueRows,
  parseReveal,
  paymentRows,
  simulationNotes,
  simulationRows,
  summaryLine,
  taxId,
  taxableRows,
  variableNotes,
  yearOptions,
} from "../../src/pages/imposto/rows.ts";
import { maskTaxId, percentText, taxIdProblem, readTaxId } from "../../src/dialogs/tax_fields.tsx";
import { readBrackets } from "../../src/dialogs/tax_parameters.tsx";
import { browserExtractor } from "../../src/data/pdf.ts";
import { readPercent } from "../../src/dialogs/form_readers.ts";

const TODAY = makeDate(2026, 10, 6);
const name = (id: string | null) => (id ? "Ana" : "—");

describe("rows of the sheets", () => {
  it("says a missing tax id, never an empty cell", () => {
    expect(taxId(null)).toBe("falta");
    expect(taxId("11222333000181")).toBe("11.222.333/0001-81");
    expect(taxId("52998224725")).toBe("529.982.247-25");
  });

  it("fills the sheets of the demonstration year and keeps each row's index as its id", async () => {
    const { ledger } = await demoSession({ extractor: browserExtractor() });
    const data = yearData(ledger, 2026, null, TODAY);
    const taxable = taxableRows(data.income, name);
    expect(taxable[0]!.cells[0]).toBe("Empresa Exemplo Ltda");
    expect(taxable[0]!.cells[1]).toBe("11.222.333/0001-81");
    expect(taxable[0]!.cells[3]).toMatch(/\*$/); // deposits counted by their net amount
    expect(taxable.map((r) => r.id)).toEqual(data.income.taxable.map((_, i) => String(i)));
    const payments = paymentRows(data.payments, name);
    expect(payments.length).toBeGreaterThan(0);
    for (const row of payments) expect(row.cells.at(-1)).toMatch(/^\d+ de \d+$/);
    expect(payments.some((r) => r.cells[2] === "falta")).toBe(true);
    expect(issueRows(data.issues)[0]!.cells[0]).toBe("Corrigir");
    expect(documentRows(data.docs).some((r) => r.cells[1] === "Falta")).toBe(true);
    expect(debtRows(data.debts).every((r) => r.id.length > 10)).toBe(true);
  });

  it("marks a group the app only suggested", async () => {
    const { ledger } = await demoSession({ extractor: browserExtractor() });
    const found = tax.declaration.assets(ledger, 2026, null);
    const rows = assetRows(found);
    found.forEach((asset, index) => {
      expect(rows[index]!.cells[0]!.includes("(sugerido)")).toBe(Boolean(asset.suggested && asset.group));
      if (!asset.group) expect(rows[index]!.cells[0]).toBe("a definir");
    });
  });

  it("shows an unknown tax as a dash in both models, with what is missing, never zero", async () => {
    const { ledger } = await demoSession({ extractor: browserExtractor() });
    const comparison = tax.simulation.compare(ledger, 2026, null);
    const rows = Object.fromEntries(simulationRows(comparison).map((r) => [r.id, r.cells]));
    expect(rows["tax"]!.slice(1)).toEqual(["—", "—"]);
    expect(rows["balance"]!.slice(1)).toEqual(["—", "—"]);
    expect(rows["taxable"]![1]).toMatch(/^R\$ 25\.200,00$/);
    const note = simulationNotes(comparison);
    expect(note).toContain("Falta informar a tabela anual de 2026");
    expect(note).not.toContain("menos imposto");
  });

  it("names the cheaper model only when both are known", () => {
    const comparison: tax.simulation.Comparison = {
      year: 2026,
      taxable: Dec.from("50000"),
      withheld: Dec.from("4000"),
      deductions: new Map([["Saúde", Dec.from("12000")]]),
      left_out: new Map(),
      simplified: {
        name: "Simplificada",
        deductions: Dec.from("10000"),
        base: Dec.from("40000"),
        tax: Dec.from("3000"),
      },
      itemized: { name: "Completa", deductions: Dec.from("12000"), base: Dec.from("38000"), tax: Dec.from("2500") },
      missing: [],
    };
    const balance = simulationRows(comparison).find((r) => r.id === "balance")!;
    expect(balance.cells.slice(1)).toEqual(["-R$ 1.000,00", "-R$ 1.500,00"]);
    const note = simulationNotes(comparison);
    expect(note).toContain("a completa resulta em menos imposto");
    expect(note).toContain("Deduções: Saúde R$ 12.000,00.");
  });

  it("always warns that the due date ignores holidays", () => {
    expect(variableNotes([], new Map())).toContain("feriados");
  });

  it("compares an informe with the records: a missing figure is 'sem registro', a match has no difference", async () => {
    const { ledger } = await demoSession({ extractor: browserExtractor() });
    const [report] = tax.records.reportsOf(ledger, 2026);
    const rows = checkRows(tax.statements.check(ledger, report!));
    expect(rows[0]!.cells[0]).toBe("Saldo no fim do ano");
    expect(rows[0]!.cells[3]).toBe("—"); // matches
  });
});

describe("links, years", () => {
  it("reads the three refs this page is sent", () => {
    expect(parseReveal("year:2025")).toEqual({ kind: "year", year: 2025 });
    expect(parseReveal("variable_income:2026-04")).toEqual({
      kind: "darf",
      purpose: "variable_income",
      month: { year: 2026, month: 4 },
      memberId: null,
    });
    expect(parseReveal("carne_leao:2026-03:member-1")).toEqual({
      kind: "darf",
      purpose: "carne_leao",
      month: { year: 2026, month: 3 },
      memberId: "member-1",
    });
    expect(parseReveal("loan:x:1")).toBeNull();
    expect(parseReveal("variable_income:2026-13")).toBeNull();
    expect(parseReveal(undefined)).toBeNull();
  });

  it("offers eight years, newest first, and opens on last year (or the latest with movement)", async () => {
    expect(yearOptions(TODAY)).toEqual([2026, 2025, 2024, 2023, 2022, 2021, 2020, 2019]);
    const { ledger } = await demoSession({ extractor: browserExtractor() });
    expect(initialYear(ledger, TODAY)).toBe(2025);
    expect(initialYear(ledger, makeDate(2028, 1, 5))).toBe(2026); // 2027 has nothing: the latest up to then
    expect(summaryLine(2025, null)).toBe("Declaração de 2026 (ano-calendário 2025) · todo o projeto");
    expect(summaryLine(2025, "Ana")).toBe("Declaração de 2026 (ano-calendário 2025) · Ana");
  });

  it("sorts a money column by its exact value", () => {
    expect(moneySort("R$ 1.234,56")).toBe(123456n);
    expect(moneySort("-R$ 10,00")).toBe(-1000n);
    expect(moneySort("R$ 25.200,00 *")).toBe(2520000n);
    expect(moneySort("—")).toBeNull();
    expect(moneySort("falta")).toBeNull();
  });
});

describe("what the dialogs read", () => {
  it("masks a CPF or CNPJ as it is typed and checks the digits", () => {
    expect(maskTaxId("52998224725", "cpf")).toBe("529.982.247-25");
    expect(maskTaxId("5299", "any")).toBe("529.9");
    expect(maskTaxId("11222333000181", "any")).toBe("11.222.333/0001-81");
    expect(maskTaxId("11222333000181999", "cnpj")).toBe("11.222.333/0001-81");
    expect(maskTaxId("abc", "any")).toBe("");
    expect(taxIdProblem("529.982.247-25", "cpf")).toBeNull();
    expect(taxIdProblem("529.982.247-24", "cpf")).toMatch(/CPF inválido/);
    expect(taxIdProblem("529.98", "cpf")).toBeNull(); // still typing
    expect(taxIdProblem("11.222.333/0001-81", "cpf")).toMatch(/CPF inválido/);
    expect(readTaxId("11.222.333/0001-81", "any")).toBe("11222333000181");
    expect(readTaxId("", "cpf", true)).toBeNull();
    expect(() => readTaxId("", "any")).toThrow(DomainError);
    expect(() => readTaxId("111.111.111-11", "cpf")).toThrow(DomainError);
  });

  it("an error message never carries the number that was typed", () => {
    try {
      readTaxId("529.982.247-24", "any");
    } catch (error) {
      expect((error as Error).message).not.toMatch(/\d{3}/);
    }
  });

  it("reads percentages the Brazilian way and keeps an empty one unknown", () => {
    expect(readPercent("", "Alíquota")).toBeNull();
    expect(readPercent("27,5", "Alíquota")!.eq("0.275")).toBe(true);
    expect(readPercent("15%", "Alíquota")!.eq("0.15")).toBe(true);
    expect(() => readPercent("abc", "Alíquota")).toThrow(/use um percentual/);
    expect(() => readPercent("101", "Alíquota")).toThrow(/entre 0 e 100/);
    expect(() => readPercent("-1", "Alíquota")).toThrow(/entre 0 e 100/);
    expect(percentText(Dec.from("0.075"))).toBe("7,5");
    expect(percentText(null)).toBe("");
  });

  it("reads the table's brackets: empty rows are dropped, a typo says which row", () => {
    const rows = [
      { key: 0, upTo: "28.467,20", rate: "7,5", deduction: "" },
      { key: 1, upTo: "", rate: "", deduction: "" },
      { key: 2, upTo: "", rate: "27,5", deduction: "10.000,00" },
    ];
    const brackets = readBrackets(rows);
    expect(brackets).toHaveLength(2);
    expect(brackets[0]!.up_to!.eq("28467.20") && brackets[0]!.rate.eq("0.075") && brackets[0]!.deduction.isZero()).toBe(
      true,
    );
    expect(brackets[1]!.up_to).toBeNull();
    expect(() => readBrackets([{ key: 0, upTo: "x", rate: "", deduction: "" }])).toThrow(/Faixa 1: use valores como/);
  });

  it("embeds no tax table, rate or limit: a new year has none of them", async () => {
    const { ledger } = await demoSession({ extractor: browserExtractor() });
    expect(tax.records.parameters(ledger, 2026)).toBeNull();
    expect(tax.records.variableRules(ledger)).toBeNull();
    expect(dom.deductibles.KIND_LABELS.health).toBe("Saúde");
  });
});
