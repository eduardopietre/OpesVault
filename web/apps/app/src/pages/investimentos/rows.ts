/**
 * Investimentos without React (desktop `pages/investments/page.py` and `detail.py`): the rows of every table,
 * the key figures, the labels and the reference other screens use to reach a position. Unknown is never zero:
 * a figure the domain could not compute is "indisponível" (or "sem avaliação", "desconhecido") with its reason.
 */
import {
  Dec,
  catalogs,
  daysBetween,
  dom,
  formatBrl,
  formatDateBr,
  formatDecimalBr,
  importing,
  investments,
  type Id,
  type IsoDate,
  type Ledger,
} from "@opesvault/domain";
import { percent } from "../../dialogs/investment_forms.ts";
import { plural } from "../contas/rows.ts";
import { planXirr, type XirrPlan } from "./xirr.ts";
import { cents, moneyOr, dateOr, DASH } from "../../data/money.ts";

const { service, model, performance, profile: prof, trades, returns, benchmarks } = investments;
const { banking } = dom;
const { importModel, importStore } = importing;

export const MATURITY_WARNING_DAYS = 30;

export const EVENT_LABELS: Readonly<Record<investments.model.EventKind, string>> = {
  contribution: "Aporte",
  withdrawal: "Resgate",
  distribution: "Provento",
  buy: "Compra",
  sell: "Venda",
  split: "Desdobramento",
  bonus: "Bonificação",
  tax_payment: "Imposto pago",
};

export const QUALITY_LABELS: Readonly<Record<investments.performance.Quality, string>> = {
  observed: "observado",
  estimate: "estimado",
  incomplete: "incompleto",
  unavailable: "indisponível",
};

const toneOf = (value: Dec | null): "positive" | "negative" | null =>
  value === null ? null : value.isPositive() ? "positive" : value.isNegative() ? "negative" : null;

export function daysText(days: number): string {
  if (days === 0) return "hoje";
  if (days > 0) return `em ${days} dia${days === 1 ? "" : "s"}`;
  return `há ${-days} dia${days === -1 ? "" : "s"}`;
}

// ── the portfolio ────────────────────────────────

export interface PortfolioRow {
  id: Id;
  name: string;
  assetClass: string;
  mode: string;
  cost: string;
  costSort: bigint | null;
  value: string;
  valueSort: bigint | null;
  base: string;
  unrealized: string;
  unrealizedSort: bigint | null;
  unrealizedTone: "positive" | "negative" | null;
  realized: string;
  realizedSort: bigint | null;
  closed: boolean;
}

export function portfolioRows(ledger: Ledger, today: IsoDate): PortfolioRow[] {
  const assets = service.assets(ledger);
  const out: PortfolioRow[] = [];
  for (const pos of service.positions(ledger).values()) {
    const asset = assets.get(pos.asset_id)!;
    const observed = performance.valueAt(ledger, pos.id, today);
    const gain = performance.unrealized(ledger, pos.id, today);
    const done = performance.realized(ledger, pos.id);
    const cost = pos.cost_known ? service.remainingCost(ledger, pos.id) : null;
    out.push({
      id: pos.id,
      name: asset.name + (pos.closed ? " (encerrado)" : ""),
      assetClass: model.ASSET_CLASS_LABELS[asset.asset_class],
      mode: pos.mode === model.TrackingMode.QUANTITY ? "Quantidade" : "Valor",
      cost: cost ? formatBrl(cost) : "desconhecido",
      costSort: cents(cost),
      value: observed ? formatBrl(observed.valuation.value) : "sem avaliação",
      valueSort: observed ? cents(observed.valuation.value) : null,
      base: observed
        ? `${formatDateBr(observed.valuation.on)} (${model.NATURE_LABELS[observed.valuation.nature]})`
        : DASH,
      unrealized: gain.value !== null ? formatBrl(gain.value) : "indisponível",
      unrealizedSort: cents(gain.value),
      unrealizedTone: toneOf(gain.value),
      realized: moneyOr(done.value) + (done.quality === performance.Quality.INCOMPLETE ? " (incompleto)" : ""),
      realizedSort: cents(done.value),
      closed: pos.closed,
    });
  }
  return out;
}

/** "3 em carteira" or "3 em carteira · 4 no total". */
export function summaryLine(ledger: Ledger): string {
  const all = [...service.positions(ledger).values()];
  const open = all.filter((p) => !p.closed).length;
  return `${open} em carteira${all.length !== open ? ` · ${all.length} no total` : ""}`;
}

// ── the selected investment ──────────────────────

/** Type, where it is held, yield and tax treatment, from the investment's characteristics. */
export function profileSummary(ledger: Ledger, positionId: Id): string[] {
  const found = prof.profileOf(ledger, positionId);
  if (found === null) return ["Sem características (Mais › Características…)"];
  const out = [catalogs.irpf.assetLabel(found.irpf_group, found.irpf_code)];
  const bank = found.bank_account_id ? banking.bankAccounts(ledger).get(found.bank_account_id) : undefined;
  if (bank) out.push(banking.where(bank));
  if (found.indexer !== null) out.push(prof.yieldText(found));
  if (found.tax !== null) out.push(prof.TAX_LABELS[found.tax]);
  return out;
}

export interface Figures {
  value: string;
  /** The exact amounts (for the animated figures); null when unknown. */
  valueRaw: string | null;
  cost: string;
  costRaw: string | null;
  unrealized: string;
  unrealizedRaw: string | null;
  unrealizedTone: "positive" | "negative" | null;
  maturity: string;
  maturityTone: "warning" | null;
  /** The method of the unrealized result and its notes: how the figure was obtained. */
  method: string;
  /** Why the unrealized result is unavailable (or null). */
  reason: string | null;
}

/** The key figures; a missing one says so instead of showing zero. */
export function figures(ledger: Ledger, positionId: Id, today: IsoDate): Figures {
  const position = service.position(ledger, positionId);
  const observed = performance.valueAt(ledger, positionId, today);
  const gain = performance.unrealized(ledger, positionId, today);
  const found = prof.profileOf(ledger, positionId);
  const maturity = found?.maturity ?? null;
  let due = DASH;
  let dueTone: "warning" | null = null;
  if (maturity !== null) {
    const days = daysBetween(maturity, today);
    due = formatDateBr(maturity) + (position.closed ? "" : ` (${daysText(days)})`);
    dueTone = !position.closed && days <= MATURITY_WARNING_DAYS ? "warning" : null;
  }
  return {
    value: observed ? formatBrl(observed.valuation.value) : "sem avaliação",
    valueRaw: observed ? observed.valuation.value.toFixed() : null,
    cost: position.cost_known ? formatBrl(service.remainingCost(ledger, positionId)) : "desconhecido",
    costRaw: position.cost_known ? service.remainingCost(ledger, positionId).toFixed() : null,
    unrealized: gain.value !== null ? formatBrl(gain.value) : "indisponível",
    unrealizedRaw: gain.value !== null ? gain.value.toFixed() : null,
    unrealizedTone: toneOf(gain.value),
    maturity: due,
    maturityTone: dueTone,
    method: [gain.method, ...gain.notes].join(" · "),
    reason: gain.value === null ? (gain.notes[0] ?? null) : null,
  };
}

export interface ValuationRow {
  id: Id;
  on: IsoDate;
  date: string;
  value: string;
  valueSort: bigint | null;
  nature: string;
  source: string;
  used: boolean;
  quantity: string;
  note: string;
}

export function valuationRows(ledger: Ledger, positionId: Id): ValuationRow[] {
  return service.valuationsOf(ledger, positionId).map((v) => ({
    id: v.id,
    on: v.on,
    date: formatDateBr(v.on),
    value: formatBrl(v.value),
    valueSort: cents(v.value),
    nature: model.NATURE_LABELS[v.nature],
    source: v.source,
    used: v.selected,
    quantity: v.quantity !== null ? formatDecimalBr(v.quantity) : DASH,
    note: v.note ?? "",
  }));
}

export interface EventRow {
  id: Id;
  on: IsoDate;
  date: string;
  kind: string;
  incomplete: boolean;
  gross: string;
  grossSort: bigint | null;
  cost: string;
  tax: string;
  fees: string;
  net: string;
  quality: string;
  note: string;
}

export function eventRows(ledger: Ledger, positionId: Id): EventRow[] {
  return service.eventsOf(ledger, positionId).map((e) => ({
    id: e.id,
    on: e.on,
    date: formatDateBr(e.on),
    kind: EVENT_LABELS[e.kind],
    incomplete: e.quality === model.EventQuality.INCOMPLETE,
    gross: moneyOr(e.gross),
    grossSort: cents(e.gross),
    cost: moneyOr(e.cost_attributed),
    tax: e.gross !== null ? formatBrl(e.tax_withheld.add(e.tax_due_later)) : "a discriminar",
    fees: formatBrl(e.fees),
    net: moneyOr(e.net),
    quality: e.quality === model.EventQuality.INCOMPLETE ? "incompleto" : "completo",
    note: e.note ?? "",
  }));
}

export interface LotRow {
  id: Id;
  acquired: string;
  source: string;
  quantity: string;
  cost: string;
  remainingQuantity: string;
  remainingCost: string;
}

export function lotRows(ledger: Ledger, positionId: Id): LotRow[] {
  return trades.lotsOf(ledger, positionId).map((lot) => ({
    id: lot.id,
    acquired: formatDateBr(lot.acquired_on),
    source: lot.source,
    quantity: formatDecimalBr(lot.quantity),
    cost: formatBrl(lot.cost),
    remainingQuantity: formatDecimalBr(lot.remaining_quantity),
    remainingCost: formatBrl(lot.remaining_cost),
  }));
}

/** The dates of the valuations in use, the choices of the period. */
export function periodDates(ledger: Ledger, positionId: Id): IsoDate[] {
  return [
    ...new Set(
      service
        .valuationsOf(ledger, positionId)
        .filter((v) => v.selected)
        .map((v) => v.on),
    ),
  ].sort();
}

export interface ReturnRow {
  id: string;
  method: string;
  value: string;
  quality: string;
  /** Why it is unavailable or what limits it. */
  notes: string;
  available: boolean;
  /** The calculation is still running (the internal rate of return, in a worker). */
  pending: boolean;
}

const XIRR_PENDING: ReturnRow = {
  id: "r2",
  method: "XIRR (taxa anualizada, dias corridos/365)",
  value: "calculando…",
  quality: "—",
  notes: "O cálculo da taxa interna de retorno pode levar alguns segundos; o resto da tela segue disponível.",
  available: true,
  pending: true,
};

/** One row per method; `null` for the internal rate of return that has not finished yet. */
export function returnRows(results: readonly (investments.performance.Result | null)[]): ReturnRow[] {
  return results.map((r, index) =>
    r === null
      ? { ...XIRR_PENDING, id: `r${index}` }
      : {
          id: `r${index}`,
          method: r.method,
          value: percent(r.value),
          quality: QUALITY_LABELS[r.quality],
          notes: r.notes.join("; "),
          available: r.value !== null,
          pending: false,
        },
  );
}

/** The return methods of a period: the quick ones computed, the internal rate of return only planned. */
export interface ReturnsPlan {
  simple: investments.performance.Result;
  twr: investments.performance.Result;
  dietz: investments.performance.Result;
  xirr: XirrPlan;
  bench: investments.performance.Result | null;
}

export function planReturns(
  ledger: Ledger,
  positionId: Id,
  start: IsoDate,
  end: IsoDate,
  benchmarkId: Id | null,
): ReturnsPlan {
  const bench = benchmarkId ? benchmarks.benchmarks(ledger).get(benchmarkId) : undefined;
  return {
    simple: performance.simpleReturn(ledger, positionId, start, end),
    twr: returns.twr(ledger, positionId, start, end),
    dietz: returns.modifiedDietz(ledger, positionId, start, end),
    xirr: planXirr(ledger, positionId, start, end),
    bench: bench ? benchmarks.benchmarkReturn(bench, start, end) : null,
  };
}

/** Every method for the period, in the domain's order, beside the reference index when one is picked. */
export function assembleReturns<T extends investments.performance.Result | null>(
  plan: ReturnsPlan,
  xirr: T,
): (investments.performance.Result | T)[] {
  const all = [plan.simple, plan.twr, xirr, plan.dietz];
  return plan.bench ? [...all, plan.bench] : all;
}

// ── brokerage notes ──────────────────────────────

export interface NoteRow {
  id: string;
  /** The note's number. */
  number: string;
  date: string;
  dateSort: string;
  trades: string;
  gross: string;
  fees: string;
  tax: string;
  /** The assets it touched. */
  assets: string;
  firstPositionId: Id | null;
  pending: boolean;
  batchId: Id | null;
}

const NOTE_PREFIX = "nota ";

/**
 * The brokerage notes of the project: the ones already incorporated (the trades they created, grouped by the
 * note number they carry) and the ones waiting for approval in Importar.
 */
export function noteRows(ledger: Ledger): NoteRow[] {
  const assets = service.assets(ledger);
  const positions = service.positions(ledger);
  const grouped = new Map<
    string,
    { on: IsoDate; buys: number; sells: number; gross: Dec; fees: Dec; tax: Dec; names: Set<string>; first: Id }
  >();
  for (const event of service.events(ledger).values()) {
    if (!event.note?.startsWith(NOTE_PREFIX)) continue;
    if (event.kind !== model.EventKind.BUY && event.kind !== model.EventKind.SELL) continue;
    const entry = grouped.get(event.note) ?? {
      on: event.on,
      buys: 0,
      sells: 0,
      gross: Dec.from(0),
      fees: Dec.from(0),
      tax: Dec.from(0),
      names: new Set<string>(),
      first: event.position_id,
    };
    if (event.kind === model.EventKind.BUY) entry.buys += 1;
    else entry.sells += 1;
    entry.gross = entry.gross.add(event.gross ?? Dec.from(0));
    entry.fees = entry.fees.add(event.fees);
    entry.tax = entry.tax.add(event.tax_withheld);
    const pos = positions.get(event.position_id);
    const asset = pos ? assets.get(pos.asset_id) : undefined;
    if (asset) entry.names.add(asset.ticker ?? asset.name);
    grouped.set(event.note, entry);
  }
  const out: NoteRow[] = [...grouped].map(([note, e]) => ({
    id: note,
    number: note.slice(NOTE_PREFIX.length),
    date: formatDateBr(e.on),
    dateSort: e.on,
    trades: [e.buys ? plural(e.buys, "compra", "compras") : "", e.sells ? plural(e.sells, "venda", "vendas") : ""]
      .filter(Boolean)
      .join(" e "),
    gross: formatBrl(e.gross),
    fees: formatBrl(e.fees),
    tax: formatBrl(e.tax),
    assets: [...e.names].join(", "),
    firstPositionId: e.first,
    pending: false,
    batchId: null,
  }));
  for (const batch of importStore.batches(ledger).values()) {
    if (batch.doc_type !== importModel.DocType.BROKERAGE_NOTE) continue;
    if (batch.status !== importModel.BatchStatus.IN_REVIEW && batch.status !== importModel.BatchStatus.PARTIAL) {
      continue;
    }
    const trading = importStore.itemsOf(ledger, batch.id).filter((i) => i.kind === importModel.ItemKind.TRADE);
    const total = trading.length
      ? Dec.sum(
          trading.map((i) => i.amount ?? Dec.from(0)),
          Dec.from(0),
        )
      : null;
    out.push({
      id: `batch:${batch.id}`,
      number: batch.header.note_number ?? DASH,
      date: dateOr(batch.header.trade_date),
      dateSort: batch.header.trade_date ?? "9999-12-31",
      trades: plural(trading.length, "negócio", "negócios"),
      gross: moneyOr(total),
      fees: DASH,
      tax: DASH,
      assets: [...new Set(trading.map((i) => i.ticker ?? i.description))].join(", "),
      firstPositionId: null,
      pending: true,
      batchId: batch.id,
    });
  }
  return out.sort((a, b) => (a.dateSort < b.dateSort ? 1 : a.dateSort > b.dateSort ? -1 : 0));
}

// ── links ────────────────────────────────────────

/** The position a link names ("<positionId>"), or null when it is not one of this project's. */
export function parseReveal(ref: string | undefined, ledger: Ledger): Id | null {
  return ref && service.positions(ledger).has(ref) ? ref : null;
}
