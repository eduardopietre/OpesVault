/**
 * Redemption and tax simulation (RF-17, docs/06 §7, docs/07 §6). Port of `investments/simulation.py`.
 *
 * A simulation never writes to the ledger. Rules are user-parameterized and
 * labeled as simulations; no legal table is built in.
 */
import { DomainError, type Ledger } from "../domain/ledger.ts";
import { roundMoney, toDecimal, ZERO } from "../domain/money.ts";
import type { IsoDate } from "../lib/dates.ts";
import { Dec } from "../lib/dec.ts";
import type { Id } from "../lib/ids.ts";
import { type TaxRule, TaxRuleKind } from "./model.ts";
import { proportionalCost, remainingCost } from "./service.ts";

export interface Simulation {
  readonly gross: Dec;
  readonly cost_attributed: Dec | null;
  readonly cost_method: string;
  readonly gain: Dec | null;
  readonly tax_base: Dec | null;
  readonly rule: string;
  readonly tax: Dec | null;
  readonly fees: Dec;
  readonly net: Dec | null;
  readonly net_gain: Dec | null;
  readonly gross_return: Dec | null;
  readonly net_return: Dec | null;
  readonly estimated_fields: readonly string[];
  readonly remaining_value: Dec | null;
  readonly remaining_cost: Dec | null;
}

export function taxFor(
  rule: TaxRule,
  gain: Dec | null,
  base: Dec | null = null,
  on: IsoDate | null = null,
): Dec | null {
  if (
    on !== null &&
    ((rule.valid_from !== null && on < rule.valid_from) || (rule.valid_to !== null && on > rule.valid_to))
  ) {
    throw new DomainError("Regra fora da vigência na data.");
  }
  // Python's `rule.fixed_amount or ZERO`: a zero amount is replaced by ZERO too.
  if (rule.kind === TaxRuleKind.FIXED) {
    return rule.fixed_amount !== null && !rule.fixed_amount.isZero() ? rule.fixed_amount : ZERO;
  }
  const rate = rule.rate !== null && !rule.rate.isZero() ? rule.rate : ZERO;
  if (rule.kind === TaxRuleKind.RATE_ON_POSITIVE_GAIN) {
    if (gain === null) return null;
    return roundMoney(Dec.max(gain, ZERO).mul(rate));
  }
  if (base === null) return null;
  return roundMoney(base.mul(rate));
}

export interface SimulateOptions {
  readonly fees?: unknown;
  readonly cost_attributed?: unknown;
  readonly current_value?: unknown;
  readonly informed_base?: unknown;
}

export function simulate(
  ledger: Ledger,
  positionId: Id,
  on: IsoDate,
  gross: unknown,
  rule: TaxRule,
  options: SimulateOptions = {},
): Simulation {
  const g = toDecimal(gross);
  const fee = toDecimal(options.fees ?? "0");
  const estimated = ["imposto (simulado: " + rule.name + ")"];
  let cost: Dec | null;
  let method: string;
  const costAttributed = options.cost_attributed ?? null;
  if (costAttributed !== null) {
    cost = toDecimal(costAttributed);
    method = "custo informado";
  } else {
    try {
      const attribution = proportionalCost(ledger, positionId, g, on);
      cost = attribution.amount;
      method = attribution.method;
      estimated.push("custo atribuído");
    } catch (error) {
      if (!(error instanceof DomainError)) throw error;
      cost = null;
      method = error.message;
    }
  }
  const gain = cost !== null ? g.sub(cost) : null;
  const informedBase = options.informed_base ?? null;
  const base = informedBase !== null ? toDecimal(informedBase) : gain;
  const tax = taxFor(rule, gain, base, on);
  const net = tax !== null ? g.sub(tax).sub(fee) : null;
  const netGain = gain !== null && tax !== null ? gain.sub(tax).sub(fee) : null;
  const grossReturn = gain !== null && cost !== null && !cost.isZero() ? gain.div(cost) : null;
  const netReturn = netGain !== null && cost !== null && !cost.isZero() ? netGain.div(cost) : null;
  const currentValue = options.current_value ?? null;
  const value = currentValue !== null ? toDecimal(currentValue) : null;
  const heldCost = remainingCost(ledger, positionId, on);
  return {
    gross: g,
    cost_attributed: cost,
    cost_method: method,
    gain,
    tax_base: rule.kind !== TaxRuleKind.FIXED ? base : null,
    rule: `${rule.name} v${rule.version} (${rule.source})`,
    tax,
    fees: fee,
    net,
    net_gain: netGain,
    gross_return: grossReturn,
    net_return: netReturn,
    estimated_fields: estimated,
    remaining_value: value !== null ? value.sub(g) : null,
    remaining_cost: cost !== null ? heldCost.sub(cost) : null,
  };
}
