/**
 * Results and returns from valuations and flows (docs/06 §3-5, §9). Port of `investments/performance.py`.
 *
 * Every result carries its method, period, inputs and quality; when the data do not
 * support a figure, the answer is "unavailable" with a reason, never zero.
 */
import type { Ledger } from "../domain/ledger.ts";
import { ZERO } from "../domain/money.ts";
import { daysBetween, formatDateBr, type IsoDate } from "../lib/dates.ts";
import { Dec } from "../lib/dec.ts";
import type { Id } from "../lib/ids.ts";
import { EventKind, EventQuality, type InvestmentEvent, realizedGain, type Valuation, ValueNature } from "./model.ts";
import { eventsOf, position, positions, remainingCost, valuationsOf } from "./service.ts";

export const CALC_VERSION = "1";

export const Quality = {
  OBSERVED: "observed",
  ESTIMATE: "estimate",
  INCOMPLETE: "incomplete",
  UNAVAILABLE: "unavailable",
} as const;
export type Quality = (typeof Quality)[keyof typeof Quality];

/** A figure with its method, period and quality; `value` null means unavailable (the reason is in `notes`). */
export interface Result {
  readonly value: Dec | null;
  readonly unit: string; // "BRL" or "ratio"
  readonly method: string;
  readonly start: IsoDate | null;
  readonly end: IsoDate | null;
  readonly quality: Quality;
  readonly notes: readonly string[];
  readonly version: string;
}

export function result(
  value: Dec | null,
  unit: string,
  method: string,
  start: IsoDate | null,
  end: IsoDate | null,
  quality: Quality,
  notes: readonly string[] = [],
  version: string = CALC_VERSION,
): Result {
  return { value, unit, method, start, end, quality, notes, version };
}

/** Python's `Result.available` property. */
export function available(r: Result): boolean {
  return r.value !== null;
}

export function unavailable(
  method: string,
  reason: string,
  start: IsoDate | null = null,
  end: IsoDate | null = null,
  unit = "BRL",
): Result {
  return result(null, unit, method, start, end, Quality.UNAVAILABLE, [reason]);
}

/** Observed points actually used (one per date); natures are never mixed silently. */
export function selectedSeries(ledger: Ledger, positionId: Id, nature: ValueNature | null = null): Valuation[] {
  let out = valuationsOf(ledger, positionId).filter((v) => v.selected);
  if (nature !== null) out = out.filter((v) => v.nature === nature);
  return out;
}

export interface Observed {
  readonly valuation: Valuation;
  readonly age_days: number;
}

/** Last known value up to `at` (never a future price), with its age (docs/07 §5). */
export function valueAt(
  ledger: Ledger,
  positionId: Id,
  at: IsoDate,
  nature: ValueNature | null = null,
): Observed | null {
  const points = selectedSeries(ledger, positionId, nature).filter((v) => v.on <= at);
  const last = points[points.length - 1];
  if (last === undefined) return null;
  return { valuation: last, age_days: daysBetween(at, last.on) };
}

export interface Flow {
  readonly on: IsoDate;
  readonly amount: Dec; // + money into the perimeter, − money out (gross)
  readonly kind: EventKind;
  readonly event: InvestmentEvent;
}

/** Flows strictly after `after` and up to `until` (closing-of-day convention, docs/06 §4). */
export function externalFlows(ledger: Ledger, positionId: Id, after: IsoDate, until: IsoDate): Flow[] {
  const out: Flow[] = [];
  for (const event of eventsOf(ledger, positionId)) {
    if (!(after < event.on && event.on <= until)) continue;
    if ((event.kind === EventKind.CONTRIBUTION || event.kind === EventKind.BUY) && event.gross !== null) {
      out.push({ on: event.on, amount: event.gross, kind: event.kind, event });
    } else if (
      event.kind === EventKind.WITHDRAWAL ||
      event.kind === EventKind.SELL ||
      event.kind === EventKind.DISTRIBUTION
    ) {
      const amount = event.gross ?? event.net;
      if (amount !== null) out.push({ on: event.on, amount: amount.negate(), kind: event.kind, event });
    }
  }
  return out;
}

function endpoint(ledger: Ledger, positionId: Id, on: IsoDate): Valuation | null {
  return selectedSeries(ledger, positionId).find((v) => v.on === on) ?? null;
}

/** Result = final − initial − contributions + gross withdrawals + external gross distributions. */
export function periodResult(ledger: Ledger, positionId: Id, start: IsoDate, end: IsoDate): Result {
  const method = "resultado antes de imposto e taxas de saída informados";
  const first = endpoint(ledger, positionId, start);
  const last = endpoint(ledger, positionId, end);
  if (first === null || last === null) {
    return unavailable(method, "Faltam avaliações exatamente no início e no fim do período.", start, end);
  }
  if (first.nature !== last.nature) {
    return unavailable(method, "Valores inicial e final de naturezas diferentes (bruto × líquido).", start, end);
  }
  const flows = externalFlows(ledger, positionId, start, end);
  const notes: string[] = [`valores ${first.nature}`];
  let quality: Quality = Quality.OBSERVED;
  if (flows.some((f) => f.event.quality === EventQuality.INCOMPLETE)) {
    quality = Quality.INCOMPLETE;
    notes.push("há resgate só com líquido conhecido: resultado incompleto");
  }
  const value = last.value.sub(first.value).sub(
    Dec.sum(
      flows.map((f) => f.amount),
      ZERO,
    ),
  );
  return result(value, "BRL", method, start, end, quality, notes);
}

/** Only without contributions/withdrawals in the period; balance growth is not a return otherwise. */
export function simpleReturn(
  ledger: Ledger,
  positionId: Id,
  start: IsoDate,
  end: IsoDate,
  includeDistributions = true,
): Result {
  const method = "retorno simples do período";
  const first = endpoint(ledger, positionId, start);
  const last = endpoint(ledger, positionId, end);
  if (first === null || last === null) {
    return unavailable(method, "Faltam avaliações no início e no fim.", start, end, "ratio");
  }
  if (first.nature !== last.nature)
    return unavailable(method, "Naturezas diferentes nos extremos.", start, end, "ratio");
  if (!first.value.isPositive()) return unavailable(method, "Valor inicial não positivo.", start, end, "ratio");
  const flows = externalFlows(ledger, positionId, start, end);
  if (flows.some((f) => f.kind !== EventKind.DISTRIBUTION)) {
    return unavailable(method, "Há aportes ou retiradas no período: use TWR, XIRR ou Dietz.", start, end, "ratio");
  }
  let distributions = Dec.sum(
    flows.map((f) => f.amount),
    ZERO,
  ).negate();
  const notes = ["sem anualização"];
  if (!distributions.isZero() && includeDistributions) {
    notes.push("inclui distribuições externas, sem hipótese de reinvestimento");
  } else {
    distributions = ZERO;
  }
  return result(
    last.value.add(distributions).div(first.value).sub(1),
    "ratio",
    method,
    start,
    end,
    Quality.OBSERVED,
    notes,
  );
}

export function unrealized(ledger: Ledger, positionId: Id, at: IsoDate): Result {
  const method = "resultado não realizado (valor observado − custo remanescente)";
  const pos = position(ledger, positionId);
  if (!pos.cost_known) return unavailable(method, "Custo de aquisição desconhecido.", null, at);
  const observed = valueAt(ledger, positionId, at);
  if (observed === null) return unavailable(method, "Sem avaliação até a data.", null, at);
  if (observed.valuation.nature !== ValueNature.GROSS) {
    return unavailable(method, "Última avaliação não é bruta; sem decomposição não há lucro bruto.", null, at);
  }
  const notes = [`avaliação de ${formatDateBr(observed.valuation.on)} (${observed.age_days} dias)`];
  const quality = observed.age_days <= 45 ? Quality.OBSERVED : Quality.ESTIMATE;
  if (quality === Quality.ESTIMATE) notes.push("avaliação antiga");
  return result(
    observed.valuation.value.sub(remainingCost(ledger, positionId, at)),
    "BRL",
    method,
    null,
    at,
    quality,
    notes,
  );
}

export function realized(ledger: Ledger, positionId: Id, until: IsoDate | null = null): Result {
  const method = "resultado realizado (bruto do resgate − custo atribuído)";
  let total = ZERO;
  const notes: string[] = [];
  let quality: Quality = Quality.OBSERVED;
  for (const event of eventsOf(ledger, positionId)) {
    if (until !== null && event.on > until) continue;
    if (event.kind !== EventKind.WITHDRAWAL && event.kind !== EventKind.SELL) continue;
    const gain = realizedGain(event);
    if (gain === null) {
      quality = Quality.INCOMPLETE;
      notes.push(`resgate de ${formatDateBr(event.on)} sem decomposição`);
      continue;
    }
    total = total.add(gain);
  }
  return result(total, "BRL", method, null, until, quality, notes);
}

export interface CompositionLine {
  readonly position_id: Id;
  readonly value: Dec | null;
  readonly as_of: IsoDate | null;
  readonly age_days: number | null;
}

export interface Composition {
  readonly at: IsoDate;
  readonly lines: CompositionLine[];
}

/** Python's `Composition.total` property. */
export function compositionTotal(c: Composition): Dec {
  return Dec.sum(
    c.lines.flatMap((line) => (line.value !== null ? [line.value] : [])),
    ZERO,
  );
}

/** Python's `Composition.partial` property. */
export function compositionPartial(c: Composition): boolean {
  return c.lines.some((line) => line.value === null);
}

/** Portfolio at a date: last known value of each open position; missing ones make the total partial. */
export function composition(ledger: Ledger, at: IsoDate): Composition {
  const out: Composition = { at, lines: [] };
  for (const pos of positions(ledger).values()) {
    if (pos.opened_on > at) continue;
    const observed = valueAt(ledger, pos.id, at);
    if (pos.closed && (observed === null || observed.valuation.value.isZero())) continue;
    out.lines.push({
      position_id: pos.id,
      value: observed ? observed.valuation.value : null,
      as_of: observed ? observed.valuation.on : null,
      age_days: observed ? observed.age_days : null,
    });
  }
  return out;
}
