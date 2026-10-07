/**
 * What the investment dialogs share (desktop `pages/investments/forms.py`): the accounts money comes from or
 * goes to and how a rate reads. Never a float.
 */
import { AccountSubtype, Dec, formatDecimalBr, type Ledger } from "@opesvault/domain";
import type { SelectOption } from "@opesvault/ui";
import { assetAccounts } from "./account_choices.ts";

/** Accounts money comes from or goes to: assets that are not investments themselves. */
export function cashAccounts(ledger: Ledger): SelectOption[] {
  return assetAccounts(ledger).filter(
    (option) => ledger.accounts.get(option.id)?.subtype !== AccountSubtype.INVESTMENT,
  );
}

/** A rate as "12,34%"; "indisponível" when the method could not compute it (never 0%). */
export function percent(value: Dec | null): string {
  return value === null ? "indisponível" : `${formatDecimalBr(value.mul(100), 2)}%`;
}
