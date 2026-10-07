/**
 * The accounts, cards and categories a form offers (desktop `ui/dialogs.py` helpers `liquid_accounts`,
 * `asset_accounts`, `balance_accounts`, `category_items` and `operation_edit.account_choices`) and the members
 * a form offers, as options whose value is the id.
 */
import {
  AccountSubtype,
  AccountType,
  isLiquid,
  sortedBy,
  type Id,
  type Ledger,
  type LedgerAccount,
} from "@opesvault/domain";
import { compareLabels, type SelectOption } from "@opesvault/ui";

const byName = (accounts: Iterable<LedgerAccount>) => sortedBy(accounts, (a) => a.name);

export function liquidAccounts(ledger: Ledger): SelectOption[] {
  return byName(ledger.accounts.values())
    .filter((a) => isLiquid(a) && !a.archived)
    .map((a) => ({ id: a.id, label: a.name }));
}

export function assetAccounts(ledger: Ledger): SelectOption[] {
  return byName(ledger.accounts.values())
    .filter((a) => a.type === AccountType.ASSET && !a.archived)
    .map((a) => ({ id: a.id, label: a.name }));
}

export function balanceAccounts(ledger: Ledger): SelectOption[] {
  return byName(ledger.accounts.values())
    .filter((a) => (a.type === AccountType.ASSET || a.type === AccountType.LIABILITY) && !a.archived)
    .map((a) => ({ id: a.id, label: a.name }));
}

/** Categories of one kind, "Parent › Child" when there is a parent. */
export function categoryItems(ledger: Ledger, kind: AccountType): SelectOption[] {
  const label = (account: LedgerAccount): string => {
    const parent = account.parent_id ? ledger.accounts.get(account.parent_id) : undefined;
    return parent ? `${parent.name} › ${account.name}` : account.name;
  };
  return ledger
    .categories(kind)
    .map((a) => ({ id: a.id, label: label(a) }))
    .sort((a, b) => compareLabels(a.label, b.label));
}

/** The active members (and `keep`, even if it was deactivated), in the project's order. */
export function memberItems(ledger: Ledger, keep: Id | null = null): SelectOption[] {
  return [...ledger.members.values()]
    .filter((m) => m.active || m.id === keep)
    .map((m) => ({ id: m.id, label: m.name }));
}

export function cardItems(ledger: Ledger): SelectOption[] {
  return [...ledger.cards.values()].map((c) => ({ id: c.id, label: c.name }));
}

const TYPE_PREFIX: Record<AccountType, string> = {
  [AccountType.ASSET]: "Conta",
  [AccountType.LIABILITY]: "Dívida",
  [AccountType.EQUITY]: "Patrimônio",
  [AccountType.INCOME]: "Receita",
  [AccountType.EXPENSE]: "Despesa",
};

/** Every postable account, labelled by type; archived ones only when already used (`keep`). */
export function postableAccounts(ledger: Ledger, keep: ReadonlySet<Id>): SelectOption[] {
  const items: SelectOption[] = [];
  for (const account of ledger.accounts.values()) {
    if (account.archived && !keep.has(account.id)) continue;
    let label = account.name;
    const parent = account.parent_id ? ledger.accounts.get(account.parent_id) : undefined;
    if (account.subtype === AccountSubtype.CATEGORY && parent !== undefined) label = `${parent.name} › ${label}`;
    items.push({ id: account.id, label: `${TYPE_PREFIX[account.type] ?? account.type}: ${label}` });
  }
  return items.sort((a, b) => compareLabels(a.label, b.label));
}

/** `current` when it is not among `options` (an archived account): shown by its own name. */
export function withCurrent(ledger: Ledger, options: SelectOption[], current: Id): SelectOption[] {
  if (options.some((o) => o.id === current)) return options;
  const account = ledger.accounts.get(current);
  return [{ id: current, label: account ? account.name : "?" }, ...options];
}
