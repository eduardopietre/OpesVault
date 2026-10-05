import { describe, expect, it } from "vitest";
import { tableRows } from "../src/chart/model.ts";
import {
  addMonths,
  formatDecimalBR,
  formatMonth,
  meanDecimals,
  normalizeMoneyInput,
  parseBrDate,
  searchKey,
  sumDecimals,
} from "../src/format.ts";

describe("normalizeMoneyInput", () => {
  it.each([
    ["1.234,56", "1234.56"],
    ["1234,56", "1234.56"],
    ["R$ 1.234,56", "1234.56"],
    ["-1.234,5", "-1234.5"],
    ["(12,00)", "-12.00"],
    ["1.234", "1234"],
    ["1.234.567", "1234567"],
    ["12.5", "12.5"],
    ["1234.56", "1234.56"],
    [",5", "0.5"],
    ["0007", "7"],
    ["-0,00", "0.00"],
  ])("reads %s as %s", (raw, expected) => {
    expect(normalizeMoneyInput(raw)).toBe(expected);
  });

  it.each(["", "abc", "1,2,3", "12.34,5.6", "1.23,00", "1,234", "12.3456", "--1", "1e5"])("rejects %s", (raw) => {
    expect(normalizeMoneyInput(raw)).toBeNull();
  });

  it("allows more places when asked (quantities)", () => {
    expect(normalizeMoneyInput("0,123456", 8)).toBe("0.123456");
  });
});

describe("decimal display", () => {
  it("groups thousands and keeps the sign", () => {
    expect(formatDecimalBR("-1234567.5")).toBe("-1.234.567,5");
    expect(formatDecimalBR("1234.5", { places: 2, currency: true })).toBe("R$ 1.234,50");
    expect(formatDecimalBR("0.005", { places: 2 })).toBe("0,01");
    expect(formatDecimalBR("-0.005", { places: 2 })).toBe("-0,01");
  });

  it("sums and averages exactly, rounding half away from zero", () => {
    expect(sumDecimals(["0.1", "0.2", "-0.30"])).toBe("0.00");
    expect(meanDecimals(["1.00", "2.00", "2.00"])).toBe("1.67");
    expect(meanDecimals(["0.005", "0.005"])).toBe("0.01");
    expect(meanDecimals(["-0.005"])).toBe("-0.01");
    expect(meanDecimals([])).toBeNull();
  });
});

describe("dates and months", () => {
  it("reads dd/mm/aaaa and rejects impossible dates", () => {
    expect(parseBrDate("05/10/2026")).toBe("2026-10-05");
    expect(parseBrDate("5/1/2026")).toBe("2026-01-05");
    expect(parseBrDate("05102026")).toBe("2026-10-05");
    expect(parseBrDate("29/02/2025")).toBeNull();
    expect(parseBrDate("29/02/2024")).toBe("2024-02-29");
    expect(parseBrDate("31/04/2026")).toBeNull();
  });

  it("spells and steps months", () => {
    expect(formatMonth({ year: 2026, month: 10 })).toBe("outubro de 2026");
    expect(addMonths({ year: 2026, month: 12 }, 1)).toEqual({ year: 2027, month: 1 });
    expect(addMonths({ year: 2026, month: 1 }, -1)).toEqual({ year: 2025, month: 12 });
  });

  it("searches without accents", () => {
    expect(searchKey("Orçamento")).toBe("orcamento");
  });
});

describe("chart table", () => {
  it("adds Total and Média to flows and keeps unknown as a dash", () => {
    const rows = tableRows({
      title: "Entradas e saídas",
      categories: ["ago/26", "set/26", "out/26"],
      series: [
        { id: "in", name: "Entradas", values: ["100.00", "200.00", null] },
        { id: "out", name: "Saídas", values: ["-50.10", "-49.90", "-0.01"] },
      ],
      unit: "money",
      flow: true,
    });
    expect(rows.map((row) => row.label)).toEqual(["ago/26", "set/26", "out/26", "Total", "Média"]);
    expect(rows[2]?.cells[0]).toBe("—");
    expect(rows[3]?.cells).toEqual(["R$ 300,00", "R$ -100,01"]);
    expect(rows[4]?.cells).toEqual(["R$ 150,00", "R$ -33,34"]);
  });

  it("does not add up positions", () => {
    const rows = tableRows({
      title: "Saldo",
      categories: ["a", "b"],
      series: [{ id: "s", name: "Saldo", values: ["1", "2"], kind: "line" }],
    });
    expect(rows).toHaveLength(2);
  });
});
