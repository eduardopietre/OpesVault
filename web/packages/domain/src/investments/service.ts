/**
 * Investment commands: positions, valuations, flows, redemptions and taxes (docs/06 §1-7).
 * Port of `investments/service.py`.
 *
 * Every money movement is a ledger operation (postings on the position's cost
 * account); valuations live apart and never create flows (docs/04 §3).
 */
import { DomainError, type Ledger } from "../domain/ledger.ts";
import {
  AccountSubtype,
  AccountType,
  LedgerAccountSchema,
  type Operation,
  OperationKind,
  operation,
  type Posting,
} from "../domain/model.ts";
import { roundMoney, toDecimal } from "../domain/money.ts";
import { balance } from "../domain/queries.ts";
import type { IsoDate } from "../lib/dates.ts";
import type { Dec } from "../lib/dec.ts";
import type { Id } from "../lib/ids.ts";
import { sortedBy } from "../lib/text.ts";
import {
  type Asset,
  AssetSchema,
  type AssetClass,
  EventKind,
  EventQuality,
  type InvestmentEvent,
  investmentEvent,
  type Position,
  PositionSchema,
  TrackingMode,
  type Valuation,
  ValuationSchema,
  ValueNature,
} from "./model.ts";
import { valueAt } from "./performance.ts";

export const INCOME_CATEGORY = "Rendimentos de investimentos";
export const LOSS_CATEGORY = "Perdas em investimentos";
export const TAX_CATEGORY = "Impostos e taxas";
export const FEE_CATEGORY = "Custos de investimentos";
export const TAX_PAYABLE = "Imposto a pagar";
export const SUSPENSE = "Resgates a discriminar";

/** Python's `KeyError` on a missing dict key (`assets(ledger)[id]`). */
export class KeyError extends Error {
  constructor(message = "") {
    super(message);
    this.name = "KeyError";
  }
}

/** `mapping[key]` with Python's failure: a KeyError, never `undefined`. */
export function getOrKeyError<K, V>(map: ReadonlyMap<K, V>, key: K): V {
  const value = map.get(key);
  if (value === undefined) throw new KeyError();
  return value;
}

export function assets(ledger: Ledger) {
  return ledger.entities<Asset>("asset");
}

export function positions(ledger: Ledger) {
  return ledger.entities<Position>("position");
}

export function valuations(ledger: Ledger) {
  return ledger.entities<Valuation>("valuation");
}

export function events(ledger: Ledger) {
  return ledger.entities<InvestmentEvent>("investment_event");
}

export function valuationsOf(ledger: Ledger, positionId: Id): Valuation[] {
  return sortedBy(
    [...valuations(ledger).values()].filter((v) => v.position_id === positionId),
    (v) => v.on,
  );
}

export function eventsOf(ledger: Ledger, positionId: Id): InvestmentEvent[] {
  return sortedBy(
    [...events(ledger).values()].filter((e) => e.position_id === positionId),
    (e) => e.on,
  );
}

export function position(ledger: Ledger, positionId: Id): Position {
  const found = positions(ledger).get(positionId);
  if (found === undefined) throw new DomainError("Posição inexistente.");
  return found;
}

function assetName(ledger: Ledger, pos: Position): string {
  return getOrKeyError(assets(ledger), pos.asset_id).name;
}

/** The category with this name, created when missing. Port of `_category`. */
export function category(ledger: Ledger, kind: AccountType, name: string): Id {
  for (const account of ledger.categories(kind)) if (account.name === name) return account.id;
  return ledger.addAccount(LedgerAccountSchema.parse({ name, type: kind, subtype: AccountSubtype.CATEGORY })).id;
}

export function taxPayableAccount(ledger: Ledger): Id {
  for (const account of ledger.accounts.values()) {
    if (account.subtype === AccountSubtype.TAX_PAYABLE && !account.archived) return account.id;
  }
  return ledger.addAccount(
    LedgerAccountSchema.parse({ name: TAX_PAYABLE, type: AccountType.LIABILITY, subtype: AccountSubtype.TAX_PAYABLE }),
  ).id;
}

/** Port of `_require_cash`. */
export function requireCash(ledger: Ledger, accountId: Id): void {
  const account = ledger.account(accountId);
  if (account.type !== AccountType.ASSET || account.subtype === AccountSubtype.INVESTMENT) {
    throw new DomainError("Escolha uma conta de dinheiro (corrente, poupança ou saldo em corretora).");
  }
}

/** Cost of what is still held, kept as the balance of the position's ledger account. */
export function remainingCost(ledger: Ledger, positionId: Id, at: IsoDate | null = null): Dec {
  return balance(ledger, position(ledger, positionId).account_id, at);
}

function posting(account_id: Id, amount: Dec): Posting {
  return { account_id, amount, member_id: null };
}

// ── positions ─────────────────────────────────────

export interface CreatePositionOptions {
  readonly holder_id?: Id | null;
  readonly mode?: TrackingMode;
  readonly ticker?: string | null;
  readonly initial_cost?: unknown;
  readonly from_account?: Id | null;
  readonly reference_value?: unknown;
  readonly reference_nature?: ValueNature;
}

/**
 * Open a position.
 *
 * - `initial_cost` + `from_account`: money leaves a cash account now (aporte).
 * - `initial_cost` alone: an existing investment whose cost is known (opening balance).
 * - `reference_value` without cost: only market value is known (docs/06 §8 F); gain since
 *   acquisition and tax base stay unknown.
 */
export function createPosition(
  ledger: Ledger,
  name: string,
  assetClass: AssetClass,
  openedOn: IsoDate,
  options: CreatePositionOptions = {},
): Position {
  const holderId = options.holder_id ?? null;
  const mode = options.mode ?? TrackingMode.VALUE;
  const fromAccount = options.from_account ?? null;
  const referenceValue = options.reference_value ?? null;
  const referenceNature = options.reference_nature ?? ValueNature.GROSS;
  let initialCost = options.initial_cost ?? null;
  if (mode === TrackingMode.QUANTITY) {
    if (initialCost !== null && !toDecimal(initialCost).isZero()) {
      throw new DomainError("Posições por quantidade começam vazias: registre compras ou uma posição inicial.");
    }
    initialCost = null;
  } else if (initialCost === null && referenceValue === null) {
    throw new DomainError("Informe o custo inicial ou um valor de referência.");
  }
  const asset = ledger.put(
    "asset",
    AssetSchema.parse({ name: name.trim(), asset_class: assetClass, ticker: options.ticker ?? null }),
  );
  const account = ledger.addAccount(
    LedgerAccountSchema.parse({
      name: `Investimento: ${asset.name}`,
      type: AccountType.ASSET,
      subtype: AccountSubtype.INVESTMENT,
      holders: holderId ? [holderId] : [],
    }),
  );
  const pos = ledger.put(
    "position",
    PositionSchema.parse({
      asset_id: asset.id,
      account_id: account.id,
      holder_id: holderId,
      mode,
      opened_on: openedOn,
      cost_known: initialCost !== null || mode === TrackingMode.QUANTITY,
    }),
  );
  if (initialCost !== null && toDecimal(initialCost).isPositive()) {
    const cost = toDecimal(initialCost);
    if (fromAccount !== null) {
      contribute(ledger, pos.id, cost, openedOn, fromAccount);
    } else {
      const op = ledger.recordOpeningBalance(account.id, cost, openedOn);
      ledger.put(
        "investment_event",
        investmentEvent({
          position_id: pos.id,
          kind: EventKind.CONTRIBUTION,
          on: openedOn,
          gross: cost,
          operation_ids: [op.id],
          note: "saldo de abertura",
        }),
      );
    }
    if (referenceValue === null && mode === TrackingMode.VALUE) {
      addValuation(ledger, pos.id, openedOn, cost, ValueNature.GROSS, { source: "custo inicial" });
    }
  } else if (referenceValue !== null) {
    const value = toDecimal(referenceValue);
    if (!value.isZero()) ledger.recordOpeningBalance(account.id, value, openedOn);
  }
  if (referenceValue !== null) {
    addValuation(ledger, pos.id, openedOn, referenceValue, referenceNature, { source: "referência inicial" });
  }
  return pos;
}

// ── valuations ───────────────────────────────────

export interface ValuationOptions {
  readonly source?: string;
  readonly quantity?: unknown;
  readonly unit_price?: unknown;
  readonly note?: string | null;
}

/** A new date adds a point; another source on the same date is kept apart (never averaged). */
export function addValuation(
  ledger: Ledger,
  positionId: Id,
  on: IsoDate,
  value: unknown,
  nature: ValueNature,
  options: ValuationOptions = {},
): Valuation {
  const source = options.source ?? "manual";
  position(ledger, positionId);
  const amount = toDecimal(value);
  if (amount.isNegative()) throw new DomainError("Valor de avaliação não pode ser negativo.");
  const sameDay = valuationsOf(ledger, positionId).filter((v) => v.on === on);
  if (sameDay.some((v) => v.source === source)) {
    throw new DomainError("Já existe avaliação desta fonte nesta data: use 'corrigir observação'.");
  }
  const quantity = options.quantity ?? null;
  const unitPrice = options.unit_price ?? null;
  const valuation = ValuationSchema.parse({
    position_id: positionId,
    on,
    value: amount,
    nature,
    source,
    quantity: quantity !== null ? toDecimal(quantity) : null,
    unit_price: unitPrice !== null ? toDecimal(unitPrice) : null,
    note: options.note ?? null,
    selected: sameDay.length === 0, // the first observation of a date is used until the user picks another
  });
  return ledger.put("valuation", valuation);
}

export function correctValuation(
  ledger: Ledger,
  valuationId: Id,
  value: unknown,
  reason: string,
  nature: ValueNature | null = null,
): Valuation {
  const current = valuations(ledger).get(valuationId);
  if (current === undefined) throw new DomainError("Avaliação inexistente.");
  if (!reason.trim()) throw new DomainError("Correções exigem motivo.");
  const updated: Valuation = { ...current, value: toDecimal(value), ...(nature !== null ? { nature } : {}) };
  return ledger.put("valuation", updated, { reason });
}

export function selectValuation(ledger: Ledger, valuationId: Id): void {
  const chosen = getOrKeyError(valuations(ledger), valuationId);
  for (const other of valuationsOf(ledger, chosen.position_id)) {
    if (other.on === chosen.on && other.selected !== (other.id === valuationId)) {
      ledger.put(
        "valuation",
        { ...other, selected: other.id === valuationId },
        { reason: "escolha da observação usada" },
      );
    }
  }
}

// ── flows ────────────────────────────────────────

export function contribute(
  ledger: Ledger,
  positionId: Id,
  amount: unknown,
  on: IsoDate,
  fromAccount: Id,
): InvestmentEvent {
  const pos = position(ledger, positionId);
  requireCash(ledger, fromAccount);
  const value = toDecimal(amount);
  if (!value.isPositive()) throw new DomainError("Informe um valor positivo.");
  const op = ledger.addOperation(
    operation({
      kind: OperationKind.INVESTMENT_CONTRIBUTION,
      description: `Aporte — ${assetName(ledger, pos)}`,
      postings: [posting(pos.account_id, value), posting(fromAccount, value.negate())],
      occurred_on: on,
      settled_on: on,
    }),
  );
  return ledger.put(
    "investment_event",
    investmentEvent({
      position_id: positionId,
      kind: EventKind.CONTRIBUTION,
      on,
      gross: value,
      net: value,
      cash_account_id: fromAccount,
      operation_ids: [op.id],
    }),
  );
}

/** Provento paid outside the position: income, never a change in cost or value. */
export function distribute(
  ledger: Ledger,
  positionId: Id,
  gross: unknown,
  on: IsoDate,
  toAccount: Id,
  taxWithheld: unknown = "0",
): InvestmentEvent {
  const pos = position(ledger, positionId);
  requireCash(ledger, toAccount);
  const value = toDecimal(gross);
  const tax = toDecimal(taxWithheld);
  if (!value.isPositive() || tax.isNegative() || tax.gt(value)) throw new DomainError("Valores do provento inválidos.");
  const postings: Posting[] = [
    posting(toAccount, value.sub(tax)),
    posting(category(ledger, AccountType.INCOME, INCOME_CATEGORY), value.negate()),
  ];
  if (!tax.isZero()) postings.push(posting(category(ledger, AccountType.EXPENSE, TAX_CATEGORY), tax));
  const op = ledger.addOperation(
    operation({
      kind: OperationKind.INVESTMENT_INCOME,
      description: `Provento — ${assetName(ledger, pos)}`,
      postings,
      occurred_on: on,
      settled_on: on,
    }),
  );
  return ledger.put(
    "investment_event",
    investmentEvent({
      position_id: positionId,
      kind: EventKind.DISTRIBUTION,
      on,
      gross: value,
      tax_withheld: tax,
      net: value.sub(tax),
      cash_account_id: toAccount,
      operation_ids: [op.id],
    }),
  );
}

export interface CostAttribution {
  readonly amount: Dec;
  readonly method: string;
}

/** Average proportional cost: a management choice for homogeneous positions, not a tax rule (docs/06 §6). */
export function proportionalCost(ledger: Ledger, positionId: Id, gross: Dec, on: IsoDate): CostAttribution {
  const pos = position(ledger, positionId);
  if (!pos.cost_known) {
    throw new DomainError("Custo desconhecido: informe o custo atribuído ou registre sem apurar ganho.");
  }
  const observed = valueAt(ledger, positionId, on);
  if (observed === null || observed.valuation.nature !== ValueNature.GROSS || !observed.valuation.value.isPositive()) {
    throw new DomainError("É preciso uma avaliação bruta até a data para atribuir custo proporcional.");
  }
  const cost = remainingCost(ledger, positionId, on);
  const fraction = gross.div(observed.valuation.value);
  if (fraction.gt(1)) throw new DomainError("Resgate maior que o valor avaliado.");
  return { amount: roundMoney(cost.mul(fraction)), method: "custo médio proporcional (hipótese de posição homogênea)" };
}

export interface RedeemOptions {
  readonly cost_attributed?: unknown;
  readonly tax_withheld?: unknown;
  readonly tax_due_later?: unknown;
  readonly fees?: unknown;
  readonly net_informed?: unknown;
  readonly final?: boolean;
  readonly event_id?: Id | null;
  readonly reason?: string | null;
}

/**
 * Resgate: net credited now = gross − withheld tax − fees (docs/06 §6).
 *
 * Tax due later is an obligation (Imposto a pagar), reducing cash only when paid (TA-28).
 */
export function redeem(
  ledger: Ledger,
  positionId: Id,
  on: IsoDate,
  gross: unknown,
  toAccount: Id,
  options: RedeemOptions = {},
): InvestmentEvent {
  const final = options.final ?? false;
  const pos = position(ledger, positionId);
  requireCash(ledger, toAccount);
  const g = toDecimal(gross);
  const tw = toDecimal(options.tax_withheld ?? "0");
  const td = toDecimal(options.tax_due_later ?? "0");
  const fee = toDecimal(options.fees ?? "0");
  if (!g.isPositive() || [tw, td, fee].some((v) => v.isNegative())) {
    throw new DomainError("Valores do resgate inválidos.");
  }
  const net = g.sub(tw).sub(fee);
  if (net.isNegative()) throw new DomainError("Impostos e taxas maiores que o valor bruto.");
  const netInformed = options.net_informed ?? null;
  if (netInformed !== null && !toDecimal(netInformed).eq(net)) {
    throw new DomainError("O líquido informado não confere com bruto − imposto retido − taxas.");
  }
  let attribution: CostAttribution;
  const costAttributed = options.cost_attributed ?? null;
  if (costAttributed === null) {
    attribution = final
      ? { amount: remainingCost(ledger, positionId, on), method: "custo total remanescente (resgate total)" }
      : proportionalCost(ledger, positionId, g, on);
  } else {
    attribution = { amount: toDecimal(costAttributed), method: "custo informado" };
  }
  const cost = attribution.amount;
  if (cost.isNegative() || cost.gt(remainingCost(ledger, positionId, on))) {
    throw new DomainError("Custo atribuído maior que o custo remanescente.");
  }
  const gain = g.sub(cost);
  const postings: Posting[] = [posting(toAccount, net), posting(pos.account_id, cost.negate())];
  if (gain.isPositive()) {
    postings.push(posting(category(ledger, AccountType.INCOME, INCOME_CATEGORY), gain.negate()));
  } else if (gain.isNegative()) {
    postings.push(posting(category(ledger, AccountType.EXPENSE, LOSS_CATEGORY), gain.negate()));
  }
  if (!tw.isZero()) postings.push(posting(category(ledger, AccountType.EXPENSE, TAX_CATEGORY), tw));
  if (!fee.isZero()) postings.push(posting(category(ledger, AccountType.EXPENSE, FEE_CATEGORY), fee));
  const name = assetName(ledger, pos);
  const operations: Operation[] = [
    operation({
      kind: OperationKind.INVESTMENT_WITHDRAWAL,
      description: `Resgate — ${name}`,
      postings,
      occurred_on: on,
      settled_on: on,
    }),
  ];
  if (!td.isZero()) {
    operations.push(
      operation({
        kind: OperationKind.OTHER,
        description: `Imposto devido sobre resgate — ${name}`,
        postings: [
          posting(category(ledger, AccountType.EXPENSE, TAX_CATEGORY), td),
          posting(taxPayableAccount(ledger), td.negate()),
        ],
        occurred_on: on,
      }),
    );
  }
  const created = operations.map((op) => ledger.addOperation(op));
  if (final && cost.eq(remainingCost(ledger, positionId)) && pos.mode === TrackingMode.VALUE) {
    ledger.put("position", { ...pos, closed: true }, { reason: "resgate total" });
  }
  let event = investmentEvent({
    position_id: positionId,
    kind: EventKind.WITHDRAWAL,
    on,
    gross: g,
    cost_attributed: cost,
    cost_method: attribution.method,
    tax_withheld: tw,
    tax_due_later: td,
    fees: fee,
    net,
    cash_account_id: toAccount,
    operation_ids: created.map((o) => o.id),
  });
  if (options.event_id != null) event = { ...event, id: options.event_id };
  return ledger.put("investment_event", event, { reason: options.reason ?? null });
}

/**
 * Only the credited net is known: cash is recorded, deductions stay 'a discriminar' (docs/01 §3).
 *
 * Tax is never inferred as zero; results using this event are flagged incomplete.
 */
export function redeemNetOnly(
  ledger: Ledger,
  positionId: Id,
  on: IsoDate,
  net: unknown,
  toAccount: Id,
): InvestmentEvent {
  const pos = position(ledger, positionId);
  requireCash(ledger, toAccount);
  const value = toDecimal(net);
  if (!value.isPositive()) throw new DomainError("Informe o líquido recebido.");
  // A liability-side suspense keeps income and net worth untouched until the deductions are known.
  const suspense =
    [...ledger.accounts.values()].find((a) => a.name === SUSPENSE && a.type === AccountType.LIABILITY)?.id ??
    ledger.addAccount(
      LedgerAccountSchema.parse({
        name: SUSPENSE,
        type: AccountType.LIABILITY,
        subtype: AccountSubtype.OTHER_LIABILITY,
      }),
    ).id;
  const op = ledger.addOperation(
    operation({
      kind: OperationKind.INVESTMENT_WITHDRAWAL,
      description: `Resgate (líquido, deduções a discriminar) — ${assetName(ledger, pos)}`,
      postings: [posting(toAccount, value), posting(suspense, value.negate())],
      occurred_on: on,
      settled_on: on,
    }),
  );
  return ledger.put(
    "investment_event",
    investmentEvent({
      position_id: positionId,
      kind: EventKind.WITHDRAWAL,
      on,
      net: value,
      cash_account_id: toAccount,
      operation_ids: [op.id],
      quality: EventQuality.INCOMPLETE,
      note: "deduções a discriminar",
    }),
  );
}

export interface CompleteRedemptionOptions {
  readonly cost_attributed?: unknown;
  readonly tax_withheld?: unknown;
  readonly fees?: unknown;
  readonly reason?: string;
}

/** Replace a net-only redemption by its itemized version; the provisional operation is cancelled. */
export function completeRedemption(
  ledger: Ledger,
  eventId: Id,
  gross: unknown,
  options: CompleteRedemptionOptions = {},
): InvestmentEvent {
  const reason = options.reason ?? "complemento do resgate";
  const current = events(ledger).get(eventId);
  if (current === undefined || current.quality !== EventQuality.INCOMPLETE || current.cash_account_id === null) {
    throw new DomainError("Resgate incompleto inexistente.");
  }
  const completed = redeem(ledger, current.position_id, current.on, gross, current.cash_account_id, {
    cost_attributed: options.cost_attributed ?? null,
    tax_withheld: options.tax_withheld ?? "0",
    fees: options.fees ?? "0",
    net_informed: current.net,
    event_id: current.id,
    reason,
  });
  // Only after the itemized version is valid is the provisional net-only entry cancelled.
  for (const opId of current.operation_ids) ledger.cancelOperation(opId, reason);
  return completed;
}

/** Cash leaves only when the tax is paid (TA-28). */
export function payTax(
  ledger: Ledger,
  amount: unknown,
  on: IsoDate,
  fromAccount: Id,
  description = "Pagamento de imposto",
): Operation {
  requireCash(ledger, fromAccount);
  const value = toDecimal(amount);
  return ledger.addOperation(
    operation({
      kind: OperationKind.TAX_PAYMENT,
      description,
      postings: [posting(taxPayableAccount(ledger), value), posting(fromAccount, value.negate())],
      occurred_on: on,
      settled_on: on,
    }),
  );
}
