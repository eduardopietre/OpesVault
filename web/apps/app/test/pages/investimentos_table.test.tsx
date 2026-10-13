/** Investimentos: where each investment is held, and the full table (a print view, also saved as CSV). */
import { Dec, formatBrl, formatDecimalBr, investments } from "@opesvault/domain";
import { screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fullCsv, fullRows } from "../../src/pages/investimentos/full_table.ts";
import { solveXirr } from "../../src/pages/investimentos/xirr_client.ts";
import { flat, rowOf, table } from "../dom.ts";
import { cdbOf, openInvestimentos } from "./investimentos_harness.tsx";

const { performance, returns } = investments;
const pct = (value: Dec) => `${formatDecimalBr(value.mul(100), 2)}%`;

afterEach(() => vi.restoreAllMocks());

describe("Investimentos: conta de cada investimento", () => {
  it("names each investment with the bank account that holds it, in parentheses", async () => {
    const { workspace } = await openInvestimentos();
    const grid = await table("Investimentos");
    expect(flat(rowOf(grid, "CDB Banco X 2028").textContent)).toContain("CDB Banco X 2028 (Itaú da Ana)");
    // an investment whose characteristics name no bank account keeps its own name
    workspace!.act((l) =>
      investments.service.createPosition(
        l,
        "Tesouro Selic",
        investments.model.AssetClass.TREASURY,
        workspace!.today(),
        {
          initial_cost: "100.00",
        },
      ),
    );
    await waitFor(() => expect(within(grid).getAllByText("Tesouro Selic").length).toBe(1));
    expect(within(rowOf(grid, "Tesouro Selic")).getAllByRole("gridcell")[0]!.textContent).toBe("Tesouro Selic");
  });
});

describe("Investimentos: tabela completa", () => {
  it("opens every investment and savings account with all their figures, ready to print", async () => {
    const print = vi.fn();
    vi.stubGlobal("print", print);
    const { user, ledger, workspace, router } = await openInvestimentos();
    await user.click(screen.getByRole("button", { name: "Tabela completa" }));
    await screen.findByRole("heading", { level: 1, name: /— investimentos$/ });
    expect(router.state.location.pathname).toBe("/imprimir/investimentos");
    const region = screen.getByRole("region", { name: "Tabela completa de investimentos" });
    const grid = within(region).getByRole("table");
    const headers = within(grid)
      .getAllByRole("columnheader")
      .map((cell) => cell.textContent);
    expect(headers).toEqual([
      "Conta",
      "Banco",
      "Agência",
      "Número",
      "Investimento",
      "Classe",
      "Aplicação",
      "Vencimento",
      "Rentabilidade contratada",
      "Total investido",
      "Último valor",
      "Data do último valor",
      "Rendimento",
      "Rendimento (%)",
      "Equivalente ao ano",
      "Equivalente ao mês",
    ]);
    // the rates come from the worker: the table says so meanwhile, then shows them
    await waitFor(() => expect(within(grid).queryByText("calculando…")).toBeNull(), { timeout: 15_000 });

    const id = cdbOf(ledger!);
    const today = workspace!.today();
    const observed = performance.valueAt(ledger!, id, today)!;
    const cdb = within(grid)
      .getAllByRole("row")
      .find((row) => row.textContent?.includes("CDB Banco X 2028"))!;
    const text = flat(cdb.textContent);
    for (const expected of ["Itaú da Ana", "0123", "45678-9", "110% do CDI", formatBrl(observed.valuation.value)]) {
      expect(text).toContain(expected);
    }
    const start = investments.service.position(ledger!, id).opened_on;
    const yearly = returns.xirr(ledger!, id, start, observed.valuation.on).value!;
    expect(text).toContain(pct(yearly));
    expect(text).toContain(pct(returns.equivalentRate(yearly, returns.YEAR_DAYS, returns.MONTH_DAYS)!));
    // the savings account and the totals
    expect(
      within(grid)
        .getAllByRole("row")
        .some((row) => row.textContent?.includes("Rendimento da poupança")),
    ).toBe(true);
    expect(flat(within(grid).getAllByRole("row").at(-1)!.textContent)).toMatch(/^Total/);

    await user.click(screen.getByRole("button", { name: "Imprimir ou salvar em PDF" }));
    expect(print).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole("button", { name: "Voltar a Investimentos" }));
    await screen.findByRole("heading", { level: 1, name: "Investimentos" });
  });

  it("writes the CSV with fractions, ISO dates and free text safe from spreadsheet formulas", async () => {
    const { ledger, workspace } = await openInvestimentos();
    workspace!.act((l) =>
      investments.service.createPosition(l, "=HYPERLINK(1)", investments.model.AssetClass.OTHER, workspace!.today(), {
        initial_cost: "100.00",
      }),
    );
    const rows = fullRows(ledger!, workspace!.today());
    const solved = new Map<string, Dec | null>();
    for (const row of rows)
      if (row.xirr) solved.set(row.id, row.xirr.settled?.value ?? (await solveXirr(row.xirr.dated))[0]);
    const csv = fullCsv(rows, solved);
    expect(csv.charCodeAt(0)).toBe(0xfeff); // a BOM, so spreadsheets read it as UTF-8
    const lines = csv.slice(1).trim().split(/\r?\n/);
    expect(lines[0]).toBe(
      "Conta;Banco;Agência;Número;Investimento;Classe;Aplicação;Vencimento;Rentabilidade contratada;Total investido;" +
        "Último valor;Data do último valor;Rendimento;Rendimento (%);Equivalente ao ano;Equivalente ao mês",
    );
    expect(csv).toContain("'=HYPERLINK(1)");
    const cdb = lines.find((line) => line.includes("CDB Banco X 2028"))!.split(";");
    expect(cdb[6]).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(cdb[13]).toMatch(/^-?\d+(\.\d+)?$/);
  });
});
