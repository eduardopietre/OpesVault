/** Finding a project's accounts, categories and members by name; a missing name fails with that name. */
import { AccountType, type Ledger, type LedgerAccount, type Member } from "@opesvault/domain";

type Named = Pick<Ledger, "accounts" | "members" | "categories">;

/** An account of any kind (bank, card, category) by its name. */
export function accountNamed(ledger: Pick<Ledger, "accounts">, name: string): LedgerAccount {
  const found = [...ledger.accounts.values()].find((account) => account.name === name);
  if (!found) throw new Error(`no account named ${name}`);
  return found;
}

/** A category of that type (an expense by default) by its name. */
export function categoryNamed(
  ledger: Pick<Named, "categories">,
  name: string,
  type: AccountType | `${AccountType}` = AccountType.EXPENSE,
): LedgerAccount {
  const found = ledger.categories(type as AccountType).find((account) => account.name === name);
  if (!found) throw new Error(`no ${type} category named ${name}`);
  return found;
}

/** A member of the project by name. */
export function memberNamed(ledger: Pick<Named, "members">, name: string): Member {
  const found = [...ledger.members.values()].find((member) => member.name === name);
  if (!found) throw new Error(`no member named ${name}`);
  return found;
}
