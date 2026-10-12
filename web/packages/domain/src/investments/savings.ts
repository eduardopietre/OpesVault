/**
 * Savings accounts (poupança) shown beside the investments. A savings account stays a cash account of the ledger:
 * deposits, withdrawals and interest are operations in Livro. Its figures are read from them: the value is the
 * balance, the income is what was credited to it from income categories (the interest), and what was put in is
 * the balance less that income. Nothing here is a position; nothing is written.
 */
import type { Ledger } from "../domain/ledger.ts";
import { AccountSubtype, AccountType, cashDate, isActive, type LedgerAccount } from "../domain/model.ts";
import { ZERO } from "../domain/money.ts";
import { balance } from "../domain/queries.ts";
import { bankAccounts } from "../domain/banking.ts";
import type { IsoDate } from "../lib/dates.ts";
import type { Dec } from "../lib/dec.ts";
import type { Id } from "../lib/ids.ts";

/** The savings accounts in use (not archived), in the ledger's order. */
export function savingsAccounts(ledger: Ledger): LedgerAccount[] {
  return [...ledger.accounts.values()].filter(
    (a) => a.type === AccountType.ASSET && a.subtype === AccountSubtype.SAVINGS && !a.archived,
  );
}

/** "Poupança (Itaú da Ana)": the bank account that holds it, else the account's own name. */
export function savingsName(ledger: Ledger, accountId: Id): string {
  const account = ledger.account(accountId);
  const bank = [...bankAccounts(ledger).values()].find((b) => b.savings_id === accountId);
  // "Poupança Bruno" or "Nubank — poupança" say "poupança" already: only the rest goes in parentheses.
  const owner = (bank?.name ?? account.name)
    .replace(/^\s*poupança[\s—–:-]*/iu, "")
    .replace(/[\s—–:-]*poupança\s*$/iu, "")
    .trim();
  return owner ? `Poupança (${owner})` : "Poupança";
}

export interface SavingsFigures {
  /** The balance on the date. */
  readonly value: Dec;
  /** Credited from income categories up to the date: the interest. */
  readonly income: Dec;
  /** The balance less the interest: deposits less withdrawals. */
  readonly invested: Dec;
}

export function savingsFigures(ledger: Ledger, accountId: Id, at: IsoDate): SavingsFigures {
  let income = ZERO;
  for (const op of ledger.operations.values()) {
    if (!isActive(op)) continue;
    const when = cashDate(op);
    if (when === null || when > at) continue;
    const here = op.postings.filter((p) => p.account_id === accountId);
    if (!here.length) continue;
    const fromIncome = op.postings.some(
      (p) => p.account_id !== accountId && ledger.accounts.get(p.account_id)?.type === AccountType.INCOME,
    );
    if (fromIncome) for (const p of here) income = income.add(p.amount);
  }
  const value = balance(ledger, accountId, at);
  return { value, income, invested: value.sub(income) };
}
