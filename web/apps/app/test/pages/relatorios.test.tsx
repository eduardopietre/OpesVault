import { charts, dom, ymAdd } from "@opesvault/domain";
import { screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { REPORTS, buildChart, isEmpty } from "../../src/pages/relatorios/reports.ts";
import { bodyOf, cell, openReport, openReports, paramsOf, valuesTable } from "./relatorios_harness.tsx";
import { flat } from "../dom.ts";

describe("Relatórios: every report with the table of its values", () => {
  it("lists the thirteen reports of the desktop, the first one open", async () => {
    await openReports();
    const list = screen.getByRole("navigation", { name: "Relatórios" });
    expect(
      within(list)
        .getAllByRole("button")
        .map((b) => b.textContent),
    ).toEqual(REPORTS.map((r) => r.label));
    expect(within(list).getByRole("button", { name: "Entradas e saídas mensais" }).getAttribute("aria-current")).toBe(
      "true",
    );
  });

  it.each(REPORTS.map((r) => [r.label, r.key] as const))(
    "%s: the table equals the domain's values",
    async (label, key) => {
      const { ledger, now, workspace, user } = await openReports();
      await openReport(user, label);
      const chart = buildChart(ledger, key, paramsOf(now, workspace.today()));
      if (isEmpty(chart)) {
        expect(await screen.findByText("Sem dados neste relatório")).toBeTruthy();
        return;
      }
      const table = await valuesTable(chart.title);
      const [names, rows] = charts.data.tableRows(chart);
      expect(
        within(table)
          .getAllByRole("columnheader")
          .map((c) => c.textContent),
      ).toEqual([expect.any(String), ...names]);
      const body = bodyOf(table);
      expect(body.length).toBe(rows.length);
      rows.forEach((row, index) => {
        expect(body[index]!.slice(1), `${chart.title}: ${row.label}`).toEqual(
          row.values.map((v) => cell(v, chart.unit)),
        );
      });
      void dom;
      void ymAdd;
      void flat;
    },
  );
});
