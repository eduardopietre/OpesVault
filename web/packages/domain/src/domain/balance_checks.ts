/**
 * Manual balance check for accounts without import (docs/09 §1.3 E, RF-08).
 * Port of `domain/balance_checks.py`.
 *
 * The user types the balance the bank shows on a date; the app compares it with its own balance
 * on that date. A difference is shown, never adjusted silently: the fix is to find the missing or
 * wrong operation. The comparison is live, so registering the missing operation clears it.
 */
import { z } from "zod";

import type { IsoDate } from "../lib/dates.ts";
import type { Dec } from "../lib/dec.ts";
import type { Id } from "../lib/ids.ts";
import { zDate, zDec, zId } from "../lib/schema.ts";
import { sortedBy } from "../lib/text.ts";
import * as queries from "./queries.ts";
import { DomainError, Ledger } from "./ledger.ts";
import { AccountType, zEntityId } from "./model.ts";
import { isCents, toDecimal } from "./money.ts";

export const BalanceCheckSchema = z.strictObject({
  id: zEntityId,
  account_id: zId,
  on: zDate,
  // the account's balance as the bank shows it (natural sign: owed amount for debts)
  informed: zDec,
  note: z.string().max(500).nullable().default(null),
});
export type BalanceCheck = Readonly<z.output<typeof BalanceCheckSchema>>;

Ledger.registerKind("balance_check", BalanceCheckSchema);

export function checks(ledger: Ledger) {
  return ledger.entities<BalanceCheck>("balance_check");
}

export function record(
  ledger: Ledger,
  accountId: Id,
  on: IsoDate,
  informed: unknown,
  note: string | null = null,
): BalanceCheck {
  const account = ledger.accounts.get(accountId);
  if (account === undefined || (account.type !== AccountType.ASSET && account.type !== AccountType.LIABILITY)) {
    throw new DomainError("Escolha uma conta.");
  }
  const value = toDecimal(informed);
  if (!isCents(value)) throw new DomainError("Informe o saldo em reais e centavos.");
  return ledger.put(
    "balance_check",
    BalanceCheckSchema.parse({ account_id: accountId, on, informed: value, note: (note ?? "").trim() || null }),
  );
}

export function remove(ledger: Ledger, checkId: Id): void {
  if (checks(ledger).has(checkId)) checks(ledger).delete(checkId);
}

export class CheckResult {
  readonly check: BalanceCheck;
  /** The app's balance at the end of that day. */
  readonly computed: Dec;

  constructor(check: BalanceCheck, computed: Dec) {
    this.check = check;
    this.computed = computed;
  }

  /** Bank minus app: positive means the bank shows more than the app. */
  get difference(): Dec {
    return this.check.informed.sub(this.computed);
  }

  get matches(): boolean {
    return this.difference.isZero();
  }
}

/** Newest first. */
export function results(ledger: Ledger, accountId: Id | null = null): CheckResult[] {
  const out = [...checks(ledger).values()]
    .filter((c) => accountId === null || c.account_id === accountId)
    .map((c) => new CheckResult(c, queries.balance(ledger, c.account_id, c.on)));
  return sortedBy(out, (r) => [r.check.on, r.check.id], true);
}

/** The most recent check of each account. */
export function latest(ledger: Ledger): Map<Id, CheckResult> {
  const out = new Map<Id, CheckResult>();
  for (const result of results(ledger)) if (!out.has(result.check.account_id)) out.set(result.check.account_id, result);
  return out;
}

/** Accounts whose latest check does not match the app (alerts). */
export function divergent(ledger: Ledger): CheckResult[] {
  return [...latest(ledger).values()].filter((r) => !r.matches && ledger.accounts.has(r.check.account_id));
}
