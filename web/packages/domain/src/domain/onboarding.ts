/**
 * First-use setup: members, accounts with opening balances and cards, applied in one go.
 * Port of `domain/onboarding.py`.
 *
 * The wizard only collects a `SetupPlan`; everything is validated here first, so a bad entry
 * never leaves a half-configured project.
 */
import type { IsoDate } from "../lib/dates.ts";
import type { Dec } from "../lib/dec.ts";
import type { Id } from "../lib/ids.ts";
import { casefold } from "../lib/text.ts";
import { DomainError, Ledger } from "./ledger.ts";
import { AccountSubtype, AccountType, CardSchema, LedgerAccountSchema } from "./model.ts";

export const ASSET_SUBTYPES: ReadonlySet<AccountSubtype> = new Set([
  AccountSubtype.CHECKING,
  AccountSubtype.SAVINGS,
  AccountSubtype.CASH,
  AccountSubtype.BROKERAGE_CASH,
  AccountSubtype.INVESTMENT,
  AccountSubtype.OTHER_ASSET,
]);
export const LIABILITY_SUBTYPES: ReadonlySet<AccountSubtype> = new Set([
  AccountSubtype.LOAN,
  AccountSubtype.OTHER_LIABILITY,
  AccountSubtype.TAX_PAYABLE,
]);

export interface AccountPlan {
  readonly name: string;
  readonly subtype: AccountSubtype;
  /** Member names. */
  readonly holders: readonly string[];
  readonly institution: string | null;
  /** null = not informed (not zero). */
  readonly openingBalance: Dec | null;
  readonly openingDate: IsoDate | null;
}

/** `AccountPlan(name, subtype, holders=(), institution=None, opening_balance=None, opening_date=None)` */
export function accountPlan(
  name: string,
  subtype: AccountSubtype,
  holders: readonly string[] = [],
  institution: string | null = null,
  openingBalance: Dec | null = null,
  openingDate: IsoDate | null = null,
): AccountPlan {
  return { name, subtype, holders, institution, openingBalance, openingDate };
}

export interface CardPlan {
  readonly name: string;
  readonly holder: string;
  readonly last4: string;
  readonly closingDay: number;
  readonly dueDay: number;
  /** Account name from the plan or the ledger. */
  readonly settlementAccount: string | null;
  readonly institution: string | null;
}

/** `CardPlan(name, holder, last4, closing_day, due_day, settlement_account=None, institution=None)` */
export function cardPlan(
  name: string,
  holder: string,
  last4: string,
  closingDay: number,
  dueDay: number,
  settlementAccount: string | null = null,
  institution: string | null = null,
): CardPlan {
  return { name, holder, last4, closingDay, dueDay, settlementAccount, institution };
}

export interface SetupPlan {
  readonly members: readonly string[];
  readonly accounts: readonly AccountPlan[];
  readonly cards: readonly CardPlan[];
}

export function setupPlan(changes: Partial<SetupPlan> = {}): SetupPlan {
  return { members: [], accounts: [], cards: [], ...changes };
}

export interface SetupResult {
  readonly members: number;
  readonly accounts: number;
  readonly cards: number;
  readonly openingBalances: number;
}

/** Raises DomainError with a user-facing message for the first problem found. */
function checkPlan(ledger: Ledger, plan: SetupPlan): void {
  const existingMembers = new Set([...ledger.members.values()].map((m) => casefold(m.name)));
  const names = plan.members.map((m) => m.trim());
  if (names.some((n) => !n)) throw new DomainError("Há um integrante sem nome.");
  const folded = names.map(casefold);
  if (new Set(folded).size !== folded.length || folded.some((n) => existingMembers.has(n))) {
    throw new DomainError("Há integrantes com o mesmo nome.");
  }
  const members = new Set([...existingMembers, ...folded]);
  const accountNames = new Set([...ledger.accounts.values()].map((a) => casefold(a.name)));
  for (const account of plan.accounts) {
    const name = account.name.trim();
    if (!name) throw new DomainError("Há uma conta sem nome.");
    if (accountNames.has(casefold(name))) throw new DomainError(`Conta repetida: ${name}.`);
    accountNames.add(casefold(name));
    if (!ASSET_SUBTYPES.has(account.subtype) && !LIABILITY_SUBTYPES.has(account.subtype)) {
      throw new DomainError("Tipo de conta inválido.");
    }
    if (account.holders.some((h) => !members.has(casefold(h)))) {
      throw new DomainError(`Titular desconhecido na conta ${name}.`);
    }
    if (account.openingBalance !== null && account.openingDate === null) {
      throw new DomainError(`Informe a data do saldo de abertura de ${name}.`);
    }
  }
  for (const card of plan.cards) {
    const name = card.name.trim();
    if (!name) throw new DomainError("Há um cartão sem nome.");
    if (accountNames.has(casefold(name))) throw new DomainError(`Nome repetido: ${name}.`);
    accountNames.add(casefold(name));
    if (!members.has(casefold(card.holder))) throw new DomainError(`Escolha o portador do cartão ${name}.`);
    if (!/^\d{4}$/.test(card.last4)) throw new DomainError(`Informe os 4 últimos dígitos do cartão ${name}.`);
    if (!(card.closingDay >= 1 && card.closingDay <= 31 && card.dueDay >= 1 && card.dueDay <= 31)) {
      throw new DomainError("Dias de fechamento e vencimento vão de 1 a 31.");
    }
    if (card.settlementAccount !== null && !accountNames.has(casefold(card.settlementAccount))) {
      throw new DomainError(`Conta de pagamento desconhecida no cartão ${name}.`);
    }
  }
}

export function applySetup(ledger: Ledger, plan: SetupPlan): SetupResult {
  checkPlan(ledger, plan);
  // Dry run on a copy: any rule the checks above miss fails there, not halfway here.
  apply(Ledger.fromRecords(ledger.toRecords()), plan);
  return apply(ledger, plan);
}

function apply(ledger: Ledger, plan: SetupPlan): SetupResult {
  const memberIds = new Map<string, Id>([...ledger.members.values()].map((m) => [casefold(m.name), m.id]));
  for (const name of plan.members) {
    const member = ledger.addMember(name.trim());
    memberIds.set(casefold(member.name), member.id);
  }
  const accountIds = new Map<string, Id>([...ledger.accounts.values()].map((a) => [casefold(a.name), a.id]));
  let balances = 0;
  for (const planAccount of plan.accounts) {
    const kind = ASSET_SUBTYPES.has(planAccount.subtype) ? AccountType.ASSET : AccountType.LIABILITY;
    const account = ledger.addAccount(
      LedgerAccountSchema.parse({
        name: planAccount.name.trim(),
        type: kind,
        subtype: planAccount.subtype,
        institution: (planAccount.institution ?? "").trim() || null,
        holders: planAccount.holders.map((h) => memberIds.get(casefold(h))),
      }),
    );
    accountIds.set(casefold(account.name), account.id);
    if (planAccount.openingBalance !== null && !planAccount.openingBalance.isZero()) {
      ledger.recordOpeningBalance(account.id, planAccount.openingBalance, planAccount.openingDate!);
      balances += 1;
    }
  }
  for (const planCard of plan.cards) {
    const holder = memberIds.get(casefold(planCard.holder))!;
    const liability = ledger.addAccount(
      LedgerAccountSchema.parse({
        name: planCard.name.trim(),
        type: AccountType.LIABILITY,
        subtype: AccountSubtype.CREDIT_CARD,
        institution: (planCard.institution ?? "").trim() || null,
        masked_number: `final ${planCard.last4}`,
        holders: [holder],
      }),
    );
    const settlement = planCard.settlementAccount ? accountIds.get(casefold(planCard.settlementAccount))! : null;
    ledger.addCard(
      CardSchema.parse({
        name: planCard.name.trim(),
        liability_account_id: liability.id,
        holder_id: holder,
        last4: planCard.last4,
        closing_day: planCard.closingDay,
        due_day: planCard.dueDay,
        settlement_account_id: settlement,
      }),
    );
  }
  return {
    members: plan.members.length,
    accounts: plan.accounts.length,
    cards: plan.cards.length,
    openingBalances: balances,
  };
}
