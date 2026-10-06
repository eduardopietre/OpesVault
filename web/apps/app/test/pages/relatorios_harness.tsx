/** Mounting Relatórios on the demonstration project (or an empty one) for the component tests. */
import { charts, ymOf, type Dec, type Ledger, type YearMonth } from "@opesvault/domain";
import { formatValue } from "@opesvault/ui";
import { act as reactAct, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect } from "vitest";
import { chooseMonth } from "../../src/data/month.ts";
import { buildChart, type Params, type ReportKey } from "../../src/pages/relatorios/reports.ts";
import { setViewport } from "./livro_harness.tsx";
import { mountPage, type MountOptions } from "./overview_calendar_helpers.tsx";

export type User = ReturnType<typeof userEvent.setup>;

export const flat = (text: string | null | undefined) => (text ?? "").replace(/\s+/g, " ").trim();

/** The page open on the demonstration project, on the project's current month. */
export async function openReports(
  path = "/relatorios",
  options: MountOptions & { month?: YearMonth; width?: number } = {},
) {
  setViewport(options.width ?? 1600);
  const mounted = await mountPage(path, options);
  const now = ymOf(mounted.workspace.today());
  reactAct(() => chooseMonth(options.month ?? now));
  await screen.findByRole("heading", { level: 1, name: "Relatórios" });
  return { ...mounted, ledger: mounted.workspace.ledger, now, user: userEvent.setup() };
}

/** A print route (outside the shell), mounted on the demonstration project or an empty one. */
export async function openPrint(path: string, options: MountOptions = {}) {
  const mounted = await mountPage(path, options);
  return { ...mounted, ledger: mounted.workspace.ledger, user: userEvent.setup() };
}

export const paramsOf = (now: YearMonth, today: string, extra: Partial<Params> = {}): Params => ({
  end: now,
  months: 12,
  scope: null,
  today: today as Params["today"],
  ...extra,
});

/** A domain value as the table shows it. */
export const cell = (value: Dec | null, unit: string) =>
  value === null ? "—" : flat(formatValue(value.toFixed(), unit === "BRL" ? "money" : "percent"));

export const chartOf = (ledger: Ledger, key: ReportKey, params: Params) => buildChart(ledger, key, params);

/** The table of values of the open report. */
export async function valuesTable(title: string | RegExp) {
  return await screen.findByRole("table", { name: typeof title === "string" ? `Valores de ${title}` : title });
}

/** The table's body rows as [first column, ...cells]. */
export function bodyOf(table: HTMLElement): string[][] {
  return within(table)
    .getAllByRole("row")
    .slice(1)
    .map((row) => [
      flat(within(row).getByRole("rowheader").textContent),
      ...within(row)
        .getAllByRole("cell")
        .map((c) => flat(c.textContent)),
    ]);
}

/** Waits until the table of values on screen is exactly the domain's table for this chart. */
export async function expectTable(chart: ReturnType<typeof buildChart>) {
  const [names, rows] = charts.data.tableRows(chart);
  await waitFor(async () => {
    const table = await valuesTable(chart.title);
    expect(
      within(table)
        .getAllByRole("columnheader")
        .map((c) => c.textContent),
    ).toEqual([expect.any(String), ...names]);
    expect(bodyOf(table).map((r) => r.slice(1))).toEqual(rows.map((row) => row.values.map((v) => cell(v, chart.unit))));
  });
}

/** Opens a report from the list (wide viewport) and waits for it. */
export async function openReport(user: User, label: string) {
  const list = () =>
    within(screen.getByRole("navigation", { name: "Relatórios" })).getByRole("button", { name: label });
  await user.click(list());
  await waitFor(() => expect(list().getAttribute("aria-current")).toBe("true"));
}
