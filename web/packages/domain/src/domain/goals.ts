/**
 * Savings and net-worth goals: a target value, optionally by a date, with progress
 * (docs/09 §1.3 C). Port of `domain/goals.py`.
 *
 * A goal tracks a value the ledger already knows (net worth, or the balance of chosen accounts);
 * it never moves money. "Quanto falta por mês" divides what is missing by the months left; the
 * recent pace is the average monthly change of the last months with records, never a guess.
 */
import { z } from "zod";

import { type IsoDate, ymAdd, ymLastDay, ymOf, type YearMonth } from "../lib/dates.ts";
import { Dec } from "../lib/dec.ts";
import { zDate, zDec, zId } from "../lib/schema.ts";
import { casefold, sortedBy } from "../lib/text.ts";
import { firstActivity } from "./comparisons.ts";
import * as queries from "./queries.ts";
import { DomainError, Ledger } from "./ledger.ts";
import { AccountType, zEntityId } from "./model.ts";
import { isCents, roundMoney, ZERO } from "./money.ts";

export const PACE_MONTHS = 6;

export const GoalKind = {
  NET_WORTH: "net_worth", // patrimônio líquido da família
  ACCOUNTS: "accounts", // saldo somado de contas escolhidas (reserva, viagem…)
} as const;
export type GoalKind = (typeof GoalKind)[keyof typeof GoalKind];

export const KIND_LABELS: Readonly<Record<GoalKind, string>> = {
  net_worth: "Patrimônio líquido",
  accounts: "Saldo de contas escolhidas",
};

export const GoalSchema = z.strictObject({
  id: zEntityId,
  name: z.string().min(1).max(80),
  kind: z.enum(["net_worth", "accounts"]),
  target: zDec,
  target_date: zDate.nullable().default(null),
  account_ids: z.array(zId).readonly().default([]),
  created_on: zDate,
  archived: z.boolean().default(false),
  version: z.number().int().default(1),
});
export type Goal = Readonly<z.output<typeof GoalSchema>>;

Ledger.registerKind("goal", GoalSchema);

export function goals(ledger: Ledger): Goal[] {
  return sortedBy(ledger.entities<Goal>("goal").values(), (g) => [g.archived, casefold(g.name)]);
}

function validate(ledger: Ledger, goal: Goal): void {
  if (!goal.name.trim()) throw new DomainError("Dê um nome à meta.");
  if (!goal.target.isPositive() || !isCents(goal.target)) {
    throw new DomainError("Informe o valor da meta em reais e centavos.");
  }
  if (goal.kind === GoalKind.ACCOUNTS) {
    if (!goal.account_ids.length) throw new DomainError("Escolha as contas que formam a meta.");
    for (const accountId of goal.account_ids) {
      const account = ledger.accounts.get(accountId);
      if (account === undefined || account.type !== AccountType.ASSET) {
        throw new DomainError("Metas somam contas de ativo (conta, poupança, investimento).");
      }
    }
  }
  if (goal.target_date !== null && goal.target_date <= goal.created_on) {
    throw new DomainError("A data da meta precisa ser futura.");
  }
}

export function addGoal(ledger: Ledger, goal: Goal): Goal {
  validate(ledger, goal);
  return ledger.put("goal", goal);
}

export function updateGoal(ledger: Ledger, goal: Goal, reason: string): Goal {
  const current = ledger.entities<Goal>("goal").get(goal.id);
  if (current === undefined) throw new DomainError("Meta inexistente.");
  validate(ledger, goal);
  return ledger.put("goal", { ...goal, version: current.version + 1 }, { reason });
}

export function valueOf(ledger: Ledger, goal: Goal, at: IsoDate): Dec {
  if (goal.kind === GoalKind.NET_WORTH) return queries.netWorth(ledger, at).net;
  return Dec.sum(
    goal.account_ids.filter((a) => ledger.accounts.has(a)).map((a) => queries.balance(ledger, a, at)),
    ZERO,
  );
}

export class Progress {
  readonly goal: Goal;
  readonly current: Dec;
  /** 0.42 = 42% (capped at 1) */
  readonly share: Dec;
  /** Zero when reached. */
  readonly missing: Dec;
  readonly monthsLeft: number | null;
  /** null without a date, or when already reached. */
  readonly neededPerMonth: Dec | null;
  /** Average monthly change over the last months with records. */
  readonly pace: Dec | null;
  /** When the recent pace reaches the target; null if it does not grow. */
  readonly reachedOnPace: YearMonth | null;

  constructor(
    goal: Goal,
    current: Dec,
    share: Dec,
    missing: Dec,
    monthsLeft: number | null,
    neededPerMonth: Dec | null,
    pace: Dec | null,
    reachedOnPace: YearMonth | null,
  ) {
    this.goal = goal;
    this.current = current;
    this.share = share;
    this.missing = missing;
    this.monthsLeft = monthsLeft;
    this.neededPerMonth = neededPerMonth;
    this.pace = pace;
    this.reachedOnPace = reachedOnPace;
  }

  get reached(): boolean {
    return this.missing.isZero();
  }
}

/** Python's `progress(..., today=None)` used `date.today()`; here `today` is explicit. */
export function progress(ledger: Ledger, goal: Goal, today: IsoDate): Progress {
  const current = valueOf(ledger, goal, today);
  const missing = Dec.max(goal.target.sub(current), ZERO);
  const share = current.isPositive() ? Dec.min(current.div(goal.target), Dec.from(1)) : ZERO;
  let monthsLeft: number | null = null;
  let needed: Dec | null = null;
  if (goal.target_date !== null) {
    const now = ymOf(today);
    const then = ymOf(goal.target_date);
    monthsLeft = Math.max((then.year - now.year) * 12 + then.month - now.month, 0);
    if (missing.isPositive()) needed = monthsLeft ? roundMoney(missing.div(monthsLeft)) : missing;
  }
  let pace: Dec | null = null;
  let reachedOn: YearMonth | null = null;
  const first = firstActivity(ledger);
  if (first !== null) {
    const thisMonth = ymOf(today);
    const span = Math.min(PACE_MONTHS, (thisMonth.year - first.year) * 12 + thisMonth.month - first.month);
    if (span > 0) {
      const past = valueOf(ledger, goal, ymLastDay(ymAdd(thisMonth, -span)));
      pace = roundMoney(current.sub(past).div(span));
      if (missing.isPositive() && pace.isPositive()) {
        const months = missing.div(pace).toIntegral("ROUND_CEILING").toInt();
        reachedOn = ymAdd(thisMonth, months);
      }
    }
  }
  return new Progress(goal, current, share.quantize("0.0001"), missing, monthsLeft, needed, pace, reachedOn);
}
