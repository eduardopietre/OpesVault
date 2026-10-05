/** Shared builders for domain tests. Port of `tests/domain_fixtures.py`. */
import { Ledger } from "../src/domain/ledger.ts";
import { AccountSubtype, AccountType, CardSchema, LedgerAccountSchema } from "../src/domain/model.ts";
import type { Id } from "../src/lib/ids.ts";

export interface Family {
  ledger: Ledger;
  ana: Id;
  bruno: Id;
  bank: Id;
  savings: Id;
  joint: Id;
  card_account: Id;
  card: Id;
  groceries: Id;
  salary: Id;
}

export function category(ledger: Ledger, name: string, kind: AccountType = AccountType.EXPENSE): Id {
  const found = ledger.categories(kind).find((a) => a.name === name);
  if (!found) throw new Error(`no category ${name}`);
  return found.id;
}

export function family(): Family {
  const ledger = Ledger.new("Projeto Teste");
  const ana = ledger.addMember("Ana").id;
  const bruno = ledger.addMember("Bruno").id;
  const acc = (name: string, type: AccountType, subtype: AccountSubtype, holders: Id[] = []) =>
    ledger.addAccount(LedgerAccountSchema.parse({ name, type, subtype, holders })).id;
  const bank = acc("Banco A", AccountType.ASSET, AccountSubtype.CHECKING, [ana]);
  const savings = acc("Poupança", AccountType.ASSET, AccountSubtype.SAVINGS, [ana]);
  const joint = acc("Conjunta", AccountType.ASSET, AccountSubtype.CHECKING, [ana, bruno]);
  const card_account = acc("Cartão X", AccountType.LIABILITY, AccountSubtype.CREDIT_CARD);
  const card = ledger.addCard(
    CardSchema.parse({
      name: "Cartão X",
      liability_account_id: card_account,
      holder_id: ana,
      last4: "1234",
      closing_day: 3,
      due_day: 10,
      settlement_account_id: bank,
    }),
  ).id;
  return {
    ledger,
    ana,
    bruno,
    bank,
    savings,
    joint,
    card_account,
    card,
    groceries: category(ledger, "Alimentação"),
    salary: category(ledger, "Salário", AccountType.INCOME),
  };
}
