/**
 * Investments: evolution with flows, accumulated result, composition and returns by method.
 * Port of `charts/data/investments.py`.
 */
import { formatDateBr, type IsoDate } from "../../lib/dates.ts";
import type { Id } from "../../lib/ids.ts";
import { getOrKeyError } from "../../lib/py.ts";
import type { Ledger } from "../../domain/ledger.ts";
import { ASSET_CLASS_LABELS, EventKind, NATURE_LABELS, ValueNature } from "../../investments/model.ts";
import { composition, periodResult, selectedSeries } from "../../investments/performance.ts";
import { allMethods } from "../../investments/returns.ts";
import { assets, eventsOf, position } from "../../investments/service.ts";
import { type Chart, chart, datePoint, point, series } from "./model.ts";

export function investmentEvolution(ledger: Ledger, positionId: Id): Chart {
  const seriesList = [];
  for (const nature of Object.values(ValueNature)) {
    const points = selectedSeries(ledger, positionId, nature).map((v) =>
      datePoint(v.on, v.value, { natureza: NATURE_LABELS[v.nature], fonte: v.source, origem: "observado" }),
    );
    if (points.length) {
      seriesList.push(
        series(`Valor ${NATURE_LABELS[nature].toLowerCase()}`, points, { style: "line", markerPoints: true }),
      );
    }
  }
  const labels: [EventKind, string][] = [
    [EventKind.CONTRIBUTION, "Aporte"],
    [EventKind.WITHDRAWAL, "Resgate"],
    [EventKind.DISTRIBUTION, "Provento"],
  ];
  for (const [kind, label] of labels) {
    const markers = eventsOf(ledger, positionId)
      .filter((e) => e.kind === kind)
      .map((e) => datePoint(e.on, e.gross !== null ? e.gross : e.net, { evento: label, qualidade: e.quality }));
    if (markers.length) seriesList.push(series(label, markers, { style: "scatter" }));
  }
  return chart("Evolução do investimento", "BRL", seriesList, [
    "Linhas ligam observações; não são preços diários. Bruto e líquido em séries separadas.",
  ]);
}

/** Cumulative monetary result at each observed date: capital contributed never counts as gain. */
export function investmentResult(ledger: Ledger, positionId: Id): Chart {
  const points = [];
  const gross = selectedSeries(ledger, positionId, ValueNature.GROSS);
  if (gross.length) {
    const first = gross[0]!;
    for (const v of gross) {
      const result = periodResult(ledger, positionId, first.on, v.on);
      points.push(datePoint(v.on, result.value, { método: result.method, qualidade: result.quality }));
    }
  }
  return chart("Resultado acumulado do investimento", "BRL", [
    series("Resultado", points, { style: "line", markerPoints: true }),
  ]);
}

export function portfolioComposition(ledger: Ledger, at: IsoDate): Chart {
  const portfolio = composition(ledger, at);
  const points = [];
  for (const line of portfolio.lines) {
    const pos = position(ledger, line.position_id);
    const asset = getOrKeyError(assets(ledger), pos.asset_id);
    const info: Record<string, string> = { classe: ASSET_CLASS_LABELS[asset.asset_class] };
    if (line.as_of) info["data-base"] = `${formatDateBr(line.as_of)} (${line.age_days} dias)`;
    else info["situação"] = "sem avaliação";
    points.push(point(asset.name, line.value, info));
  }
  const notes = [`Data-base ${formatDateBr(at)}; último valor conhecido até a data.`];
  if (portfolio.lines.some((line) => line.value === null)) notes.push("Total parcial: há ativos sem avaliação.");
  return chart("Composição da carteira", "BRL", [series("Valor", points)], notes);
}

/** Percentages by method; unavailable methods appear in notes with their reason, never as zero. */
export function returnsChart(ledger: Ledger, positionId: Id, start: IsoDate, end: IsoDate): Chart {
  const points = [];
  const notes = [];
  for (const result of allMethods(ledger, positionId, start, end)) {
    const label = result.method.split(" (")[0]!;
    if (result.value === null) {
      notes.push(`${label}: indisponível — ${result.notes.length ? result.notes[0] : ""}`);
    }
    points.push(
      point(label, result.value, {
        método: result.method,
        qualidade: result.quality,
        ...(result.notes.length ? { notas: result.notes.join("; ") } : {}),
      }),
    );
  }
  return chart(`Rentabilidade ${formatDateBr(start)} a ${formatDateBr(end)}`, "%", [series("Retorno", points)], notes);
}
