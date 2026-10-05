/**
 * Return methods conditioned on available data (docs/06 §5): TWR, XIRR and Modified Dietz.
 * Port of `investments/returns.py`.
 *
 * - Valuations on a flow date follow the closing-of-day convention: they already include
 *   that day's flow (docs/07 §3).
 * - No interpolation: missing valuations make TWR unavailable, never "approximately exact".
 * - XIRR without a unique solution is unavailable, never zero or an arbitrary root.
 * - Sign conventions stay inside each method: in Dietz a contribution is positive (Cᵢ > 0);
 *   in XIRR, the investor's view, it is negative.
 */
import type { Ledger } from "../domain/ledger.ts";
import { ZERO } from "../domain/money.ts";
import { daysBetween, formatDateBr, type IsoDate } from "../lib/dates.ts";
import { Dec, withContext } from "../lib/dec.ts";
import type { Id } from "../lib/ids.ts";
import { EventQuality } from "./model.ts";
import {
  externalFlows,
  Quality,
  type Result,
  result,
  selectedSeries,
  simpleReturn,
  unavailable,
} from "./performance.ts";

export const XIRR_TOLERANCE = Dec.from("1e-12");
export const XIRR_MAX_ITERATIONS = 400;
/** Dense grid so two nearby roots are never hidden inside one bracket. */
export const XIRR_BRACKETS: readonly Dec[] = [
  Dec.from("-0.9999"),
  ...Array.from({ length: 599 }, (_, i) => Dec.from("-0.99").add(Dec.from("0.005").mul(i))),
  ...["2", "2.5", "3", "4", "5", "7", "10", "20", "50", "100"].map((x) => Dec.from(x)),
];

function valueMap(ledger: Ledger, positionId: Id): [Map<IsoDate, Dec>, Set<string>] {
  const points = selectedSeries(ledger, positionId);
  return [new Map(points.map((v) => [v.on, v.value])), new Set(points.map((v) => v.nature))];
}

function netFlowByDate(ledger: Ledger, positionId: Id, start: IsoDate, end: IsoDate): [Map<IsoDate, Dec>, boolean] {
  const flows = new Map<IsoDate, Dec>();
  let incomplete = false;
  for (const flow of externalFlows(ledger, positionId, start, end)) {
    flows.set(flow.on, (flows.get(flow.on) ?? ZERO).add(flow.amount));
    incomplete = incomplete || flow.event.quality === EventQuality.INCOMPLETE;
  }
  return [flows, incomplete];
}

export function twr(ledger: Ledger, positionId: Id, start: IsoDate, end: IsoDate): Result {
  const method = "TWR (retorno ponderado pelo tempo, subperíodos delimitados pelos fluxos)";
  const [values, natures] = valueMap(ledger, positionId);
  if (natures.size > 1) return unavailable(method, "Série mistura valores brutos e líquidos.", start, end, "ratio");
  const [flows, incomplete] = netFlowByDate(ledger, positionId, start, end);
  const boundaries = [...new Set([start, end, ...flows.keys()])].sort();
  const missing = boundaries.filter((d) => !values.has(d));
  if (missing.length) {
    const listed = missing.slice(0, 5).map(formatDateBr).join(", ");
    return unavailable(
      method,
      `Faltam avaliações nas datas de fluxo ou extremos (${listed}); não há interpolação.`,
      start,
      end,
      "ratio",
    );
  }
  let growth = Dec.from(1);
  for (let i = 0; i + 1 < boundaries.length; i++) {
    const a = boundaries[i]!;
    const b = boundaries[i + 1]!;
    const va = values.get(a)!;
    if (!va.isPositive()) return unavailable(method, `Valor não positivo em ${formatDateBr(a)}.`, start, end, "ratio");
    growth = growth.mul(
      values
        .get(b)!
        .sub(flows.get(b) ?? ZERO)
        .div(va),
    );
  }
  const notes = ["sem anualização", "avaliação na data do fluxo considerada após o movimento"];
  const quality = incomplete ? Quality.INCOMPLETE : Quality.OBSERVED;
  return result(growth.sub(1), "ratio", method, start, end, quality, notes);
}

export function modifiedDietz(ledger: Ledger, positionId: Id, start: IsoDate, end: IsoDate): Result {
  const method = "Modified Dietz (estimativa)";
  const [values, natures] = valueMap(ledger, positionId);
  const first = values.get(start);
  const last = values.get(end);
  if (first === undefined || last === undefined) {
    return unavailable(method, "Faltam avaliações no início e no fim.", start, end, "ratio");
  }
  if (natures.size > 1) return unavailable(method, "Série mistura valores brutos e líquidos.", start, end, "ratio");
  const days = daysBetween(end, start);
  if (days <= 0) return unavailable(method, "Período de duração zero.", start, end, "ratio");
  const [flows, incomplete] = netFlowByDate(ledger, positionId, start, end);
  // Here contributions are positive (C > 0) and withdrawals negative, as in docs/06 §5.
  const totalFlows = Dec.sum(flows.values(), ZERO);
  const weighted = Dec.sum(
    [...flows].map(([when, amount]) => amount.mul(Dec.from(daysBetween(end, when))).div(Dec.from(days))),
    ZERO,
  );
  const denominator = first.add(weighted);
  if (!denominator.isPositive()) {
    return unavailable(method, "Denominador zero ou negativo: estimativa inadequada.", start, end, "ratio");
  }
  const value = last.sub(first).sub(totalFlows).div(denominator);
  const notes = ["estimativa", "dias corridos", "fluxo no fechamento do dia", "sem anualização"];
  return result(value, "ratio", method, start, end, incomplete ? Quality.INCOMPLETE : Quality.ESTIMATE, notes);
}

function npv(rate: Dec, flows: readonly (readonly [Dec, Dec])[]): Dec {
  const base = Dec.from(1).add(rate).ln();
  return Dec.sum(
    flows.map(([exponent, amount]) => amount.div(exponent.mul(base).exp_())),
    ZERO,
  );
}

/** Solve Σ Fᵢ / (1 + r)^((tᵢ − t₀)/365) = 0 for r > −1. Returns (rate, reason when null). */
export function xirrFromFlows(dated: readonly (readonly [IsoDate, Dec])[]): [Dec | null, string] {
  if (!dated.some(([, a]) => a.isNegative()) || !dated.some(([, a]) => a.isPositive())) {
    return [null, "É preciso ao menos um fluxo negativo e um positivo."];
  }
  return withContext({ prec: 40 }, (): [Dec | null, string] => {
    const t0 = dated.map(([d]) => d).reduce((a, b) => (b < a ? b : a));
    const flows = dated.map(([d, a]) => [Dec.from(daysBetween(d, t0)).div(Dec.from(365)), a] as const);
    const samples = XIRR_BRACKETS.map((r) => [r, npv(r, flows)] as const);
    const brackets: [Dec, Dec][] = [];
    for (let i = 0; i + 1 < samples.length; i++) {
      const [a, fa] = samples[i]!;
      const [b, fb] = samples[i + 1]!;
      if (fa.isZero() || fa.isNegative() !== fb.isNegative()) brackets.push([a, b]);
    }
    if (!brackets.length) return [null, "Sem solução no domínio r > −100%."];
    if (brackets.length > 1) return [null, "Múltiplas raízes possíveis; taxa não escolhida arbitrariamente."];
    let [low, high] = brackets[0]!;
    let fLow = npv(low, flows);
    for (let i = 0; i < XIRR_MAX_ITERATIONS; i++) {
      const mid = low.add(high).div(2);
      const fMid = npv(mid, flows);
      if (fMid.abs().lt(XIRR_TOLERANCE) || high.sub(low).lt(XIRR_TOLERANCE)) return [mid, ""];
      if (fMid.isNegative() === fLow.isNegative()) {
        low = mid;
        fLow = fMid;
      } else {
        high = mid;
      }
    }
    return [null, "Sem convergência numérica."];
  });
}

export function xirr(ledger: Ledger, positionId: Id, start: IsoDate, end: IsoDate): Result {
  const method = "XIRR (taxa anualizada, dias corridos/365)";
  const [values, natures] = valueMap(ledger, positionId);
  const first = values.get(start);
  const last = values.get(end);
  if (first === undefined || last === undefined) {
    return unavailable(method, "Faltam avaliações no início e no fim.", start, end, "ratio");
  }
  if (natures.size > 1) return unavailable(method, "Série mistura valores brutos e líquidos.", start, end, "ratio");
  const [flows, incomplete] = netFlowByDate(ledger, positionId, start, end);
  // Investor's view: initial value and contributions are outflows (negative).
  const dated: [IsoDate, Dec][] = [[start, first.negate()]];
  for (const [when, amount] of flows) dated.push([when, amount.negate()]);
  dated.push([end, last]);
  const [rate, reason] = xirrFromFlows(dated);
  if (rate === null) return unavailable(method, reason, start, end, "ratio");
  const notes = ["taxa anualizada", "tolerância 1e-12"];
  if (daysBetween(end, start) < 365) notes.push("período menor que um ano: taxa anualizada a partir de período curto");
  return result(rate, "ratio", method, start, end, incomplete ? Quality.INCOMPLETE : Quality.OBSERVED, notes);
}

export function allMethods(ledger: Ledger, positionId: Id, start: IsoDate, end: IsoDate): Result[] {
  return [
    simpleReturn(ledger, positionId, start, end),
    twr(ledger, positionId, start, end),
    xirr(ledger, positionId, start, end),
    modifiedDietz(ledger, positionId, start, end),
  ];
}
