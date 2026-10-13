/** The domain's chart as the design system's: the provenance of each point reaches the tooltip (docs/07 §5). */
import { Dec, charts, makeDate } from "@opesvault/domain";
import { chartOption, detailLines } from "@opesvault/ui";
import { describe, expect, it } from "vitest";
import { pointDetails, toChartData } from "../src/data/chart_data.ts";

const { chart, datePoint, series } = charts.data;

describe("toChartData", () => {
  it("carries each point's origin, nature and quality, with the codes of quality in words", () => {
    const valued = series(
      "Valor bruto",
      [
        datePoint(makeDate(2026, 3, 31), Dec.from("1000"), {
          natureza: "Bruto",
          fonte: "extrato",
          origem: "observado",
        }),
        datePoint(makeDate(2026, 6, 30), Dec.from("1040"), {}),
      ],
      { style: "line", markerPoints: true },
    );
    const events = series(
      "Aporte",
      [datePoint(makeDate(2026, 6, 30), Dec.from("500"), { evento: "Aporte", qualidade: "incomplete" })],
      { style: "scatter" },
    );
    const data = toChartData(chart("Evolução do investimento", "BRL", [valued, events]));
    expect(data.series[0]!.details).toEqual([{ natureza: "Bruto", fonte: "extrato", origem: "observado" }, null]);
    expect(data.series[1]!.details).toEqual([null, { evento: "Aporte", qualidade: "incompleto" }]);
    expect(detailLines(data, 1)).toEqual(["Evento: Aporte", "Qualidade: incompleto"]);
    const tip = (chartOption(data, true).tooltip as { formatter: (params: unknown) => string }).formatter([
      { dataIndex: 0, seriesIndex: 0 },
    ]);
    expect(tip).toContain("Fonte: extrato");
    expect(tip).toContain("Origem: observado");
  });

  it("keeps an unknown code of quality as it is and drops empty details", () => {
    const point = datePoint(makeDate(2026, 1, 1), null, { qualidade: "observed", método: "TWR", notas: "" });
    expect(pointDetails(point)).toEqual({ qualidade: "observado", método: "TWR" });
    expect(pointDetails(datePoint(makeDate(2026, 1, 1), null, { qualidade: "nova" }))).toEqual({ qualidade: "nova" });
    expect(pointDetails(datePoint(makeDate(2026, 1, 1), null))).toBeNull();
    expect(pointDetails(undefined)).toBeNull();
  });
});
