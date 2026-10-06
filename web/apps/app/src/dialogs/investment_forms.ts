/**
 * What the investment dialogs share (desktop `pages/investments/forms.py`): the accounts money comes from or
 * goes to, a quantity typed the Brazilian way and a percentage. Never a float.
 */
import { AccountSubtype, DomainError, Dec, formatDecimalBr, type Ledger } from "@opesvault/domain";
import type { SelectOption } from "@opesvault/ui";
import { assetAccounts } from "./account_choices.ts";

/** Accounts money comes from or goes to: assets that are not investments themselves. */
export function cashAccounts(ledger: Ledger): SelectOption[] {
  return assetAccounts(ledger).filter(
    (option) => ledger.accounts.get(option.id)?.subtype !== AccountSubtype.INVESTMENT,
  );
}

/** A quantity typed the Brazilian way ("1.234,5"); never a float. */
export function readQuantity(text: string, name = "Quantidade"): Dec {
  const typed = text.trim().replace(/\./g, "").replace(",", ".");
  if (!/^\d+(\.\d+)?$/.test(typed)) throw new DomainError(`${name} inválida.`);
  return Dec.from(typed);
}

/** A percentage typed as "15" or "17,5"; empty is unknown. */
export function readPercent(text: string, name = "Alíquota"): Dec | null {
  const typed = text.trim().replace("%", "").replace(/\./g, "").replace(",", ".");
  if (!typed) return null;
  if (!/^\d+(\.\d+)?$/.test(typed)) throw new DomainError(`${name} inválida. Use um número como 15 ou 17,5.`);
  return Dec.from(typed).div(Dec.from(100));
}

/** A rate as "12,34%"; "indisponível" when the method could not compute it (never 0%). */
export function percent(value: Dec | null): string {
  return value === null ? "indisponível" : `${formatDecimalBr(value.mul(100), 2)}%`;
}
