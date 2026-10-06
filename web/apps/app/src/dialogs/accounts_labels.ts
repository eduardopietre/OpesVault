/**
 * The words of the registrations (desktop `ui/dialogs.py` `SUBTYPE_LABELS`, `ROLE_LABELS` and the subtype
 * groups): shared by the dialogs and the tables of Contas e cartões.
 */
import { AccountSubtype, MemberRole, cmpStr, type Id, type Ledger } from "@opesvault/domain";
import type { SelectOption } from "@opesvault/ui";

export const SUBTYPE_LABELS: Readonly<Partial<Record<AccountSubtype, string>>> = {
  [AccountSubtype.CHECKING]: "Conta corrente",
  [AccountSubtype.SAVINGS]: "Poupança",
  [AccountSubtype.CASH]: "Dinheiro",
  [AccountSubtype.BROKERAGE_CASH]: "Saldo em corretora",
  [AccountSubtype.INVESTMENT]: "Investimento",
  [AccountSubtype.OTHER_ASSET]: "Outro bem",
  [AccountSubtype.CREDIT_CARD]: "Cartão de crédito",
  [AccountSubtype.LOAN]: "Empréstimo/financiamento",
  [AccountSubtype.OTHER_LIABILITY]: "Outra dívida",
  [AccountSubtype.TAX_PAYABLE]: "Imposto a pagar",
};

export const ASSET_SUBTYPES: readonly AccountSubtype[] = [
  AccountSubtype.CHECKING,
  AccountSubtype.SAVINGS,
  AccountSubtype.CASH,
  AccountSubtype.BROKERAGE_CASH,
  AccountSubtype.INVESTMENT,
  AccountSubtype.OTHER_ASSET,
];

export const LIABILITY_SUBTYPES: readonly AccountSubtype[] = [
  AccountSubtype.LOAN,
  AccountSubtype.OTHER_LIABILITY,
  AccountSubtype.TAX_PAYABLE,
];

export const ROLE_LABELS: Readonly<Record<MemberRole, string>> = {
  [MemberRole.HOLDER]: "Titular",
  [MemberRole.DEPENDENT]: "Dependente",
};

/** The members a form offers as holders: the active ones (by name), and those in `keep` even if inactive. */
export function memberChoices(ledger: Ledger, keep: readonly (Id | null | undefined)[] = []): SelectOption[] {
  return [...ledger.members.values()]
    .filter((m) => m.active || keep.includes(m.id))
    .sort((a, b) => cmpStr(a.name, b.name))
    .map((m) => ({ id: m.id, label: m.name }));
}

/** The label of a subtype, falling back to its code. */
export function subtypeLabel(subtype: AccountSubtype): string {
  return SUBTYPE_LABELS[subtype] ?? subtype;
}
