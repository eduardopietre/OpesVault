/**
 * The internal rate of return, split in two so the slow half can leave the main thread. The domain's `xirr`
 * reads the ledger (the values at both ends and the flows between them) and then solves for the rate over
 * ~600 trial rates at 40 digits, which takes seconds on a long history. `planXirr` is the first half, on the
 * ledger, with the very same checks and sign convention (the investor's view: the initial value and the
 * contributions are outflows); `finishXirr` assembles the result from the rate the solver found. A test keeps
 * both equal to `investments.returns.xirr`.
 */
import { Dec, daysBetween, investments, type Id, type IsoDate, type Ledger } from "@opesvault/domain";

const { performance } = investments;

const METHOD = "XIRR (taxa anualizada, dias corridos/365)";

export interface XirrPlan {
  /** Set when the data do not allow the method: the result is final and nothing is solved. */
  readonly settled: investments.performance.Result | null;
  readonly dated: readonly (readonly [IsoDate, Dec])[];
  readonly start: IsoDate;
  readonly end: IsoDate;
  readonly incomplete: boolean;
}

export function planXirr(ledger: Ledger, positionId: Id, start: IsoDate, end: IsoDate): XirrPlan {
  const points = performance.selectedSeries(ledger, positionId);
  const values = new Map(points.map((v) => [v.on, v.value]));
  const natures = new Set(points.map((v) => v.nature));
  const settled = (reason: string): XirrPlan => ({
    settled: performance.unavailable(METHOD, reason, start, end, "ratio"),
    dated: [],
    start,
    end,
    incomplete: false,
  });
  const first = values.get(start);
  const last = values.get(end);
  if (first === undefined || last === undefined) return settled("Faltam avaliações no início e no fim.");
  if (natures.size > 1) return settled("Série mistura valores brutos e líquidos.");
  const flows = new Map<IsoDate, Dec>();
  let incomplete = false;
  for (const flow of performance.externalFlows(ledger, positionId, start, end)) {
    flows.set(flow.on, (flows.get(flow.on) ?? Dec.from(0)).add(flow.amount));
    incomplete = incomplete || flow.event.quality === investments.model.EventQuality.INCOMPLETE;
  }
  const dated: [IsoDate, Dec][] = [[start, first.negate()]];
  for (const [when, amount] of flows) dated.push([when, amount.negate()]);
  dated.push([end, last]);
  return { settled: null, dated, start, end, incomplete };
}

export function finishXirr(plan: XirrPlan, rate: Dec | null, reason: string): investments.performance.Result {
  if (plan.settled) return plan.settled;
  if (rate === null) return performance.unavailable(METHOD, reason, plan.start, plan.end, "ratio");
  const notes = ["taxa anualizada", "tolerância 1e-12"];
  if (daysBetween(plan.end, plan.start) < 365) {
    notes.push("período menor que um ano: taxa anualizada a partir de período curto");
  }
  return performance.result(
    rate,
    "ratio",
    METHOD,
    plan.start,
    plan.end,
    plan.incomplete ? performance.Quality.INCOMPLETE : performance.Quality.OBSERVED,
    notes,
  );
}
