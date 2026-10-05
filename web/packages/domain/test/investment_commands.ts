/** The investment commands of scripts/golden/cases_investments.py (`INVESTMENT_COMMANDS`), shared by the W5 golden tests. */
import { type AssetClass, type TaxRule, TaxRuleSchema, type ValueNature } from "../src/investments/model.ts";
import * as service from "../src/investments/service.ts";
import * as simulation from "../src/investments/simulation.ts";
import * as trades from "../src/investments/trades.ts";
import { golden, j } from "./golden.ts";
import { asDate, type CommandTable, Raw } from "./w5_golden.ts";

/** The simulation rules of cases_investments.py (`RULES`). */
export const RULES: TaxRule[] = golden<{ rules: unknown[] }>("investments").rules.map((r) => TaxRuleSchema.parse(r));

const s = (v: unknown) => v as string;

export const INVESTMENT_COMMANDS: CommandTable = {
  create_position: (l, [name, cls, on], o) =>
    service.createPosition(l, s(name), cls as AssetClass, asDate(on), o as service.CreatePositionOptions),
  add_valuation: (l, [pos, on, value, nature], o) =>
    service.addValuation(l, s(pos), asDate(on), value, nature as ValueNature, o as service.ValuationOptions),
  correct_valuation: (l, [val, value, reason, nature]) =>
    service.correctValuation(l, s(val), value, s(reason), (nature as ValueNature | undefined) || null),
  select_valuation: (l, [val]) => service.selectValuation(l, s(val)),
  contribute: (l, [pos, amount, on, src]) => service.contribute(l, s(pos), amount, asDate(on), s(src)),
  distribute: (l, [pos, gross, on, dst, tax]) =>
    service.distribute(l, s(pos), gross, asDate(on), s(dst), tax === undefined ? "0" : tax),
  redeem: (l, [pos, on, gross, dst], o) => service.redeem(l, s(pos), asDate(on), gross, s(dst), o),
  redeem_net_only: (l, [pos, on, net, dst]) => service.redeemNetOnly(l, s(pos), asDate(on), net, s(dst)),
  complete_redemption: (l, [event, gross], o) => service.completeRedemption(l, s(event), gross, o),
  pay_tax: (l, [amount, on, src]) => service.payTax(l, amount, asDate(on), s(src)),
  buy: (l, [pos, on, qty, price, src], o) =>
    trades.buy(l, s(pos), asDate(on), qty, price, s(src), o as trades.TradeOptions),
  sell: (l, [pos, on, qty, price, dst], o) =>
    trades.sell(l, s(pos), asDate(on), qty, price, s(dst), o as trades.SellOptions),
  split: (l, [pos, on, factor]) => trades.split(l, s(pos), asDate(on), factor),
  bonus: (l, [pos, on, qty, cost]) => trades.bonus(l, s(pos), asDate(on), qty, cost === undefined ? "0" : cost),
  opening_lot: (l, [pos, on, qty, cost]) => trades.openingLot(l, s(pos), asDate(on), qty, cost),
  simulate: (l, [pos, on, gross, rule], o) =>
    new Raw(j(simulation.simulate(l, s(pos), asDate(on), gross, RULES[rule as number]!, o))),
};
