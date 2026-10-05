/**
 * The demonstration project: invented data in the main features, for development, screenshots and
 * end-to-end tests (the web counterpart of tests/demo_vault.py). Dates follow the current month so the
 * demo always looks alive. Nothing here is real.
 */
import {
  AccountSubtype,
  AccountType,
  addDays,
  CardSchema,
  type IsoDate,
  Ledger,
  LedgerAccountSchema,
  makeDate,
  monthOf,
  today as localToday,
  yearOf,
} from "@opesvault/domain";

/** "123.45" from a whole number of cents: the demo never builds money from floats. */
function cents(value: number): string {
  return `${Math.floor(value / 100)}.${String(value % 100).padStart(2, "0")}`;
}

export function demoLedger(name = "Casa", today: IsoDate = localToday()): Ledger {
  const ledger = Ledger.new(name);
  const ana = ledger.addMember("Ana").id;
  const bruno = ledger.addMember("Bruno").id;
  const account = (
    n: string,
    type: AccountType,
    subtype: AccountSubtype,
    holders: string[] = [],
    institution: string | null = null,
  ) => ledger.addAccount(LedgerAccountSchema.parse({ name: n, type, subtype, holders, institution })).id;
  const bank = account("Conta corrente", AccountType.ASSET, AccountSubtype.CHECKING, [ana], "Banco Azul");
  const savings = account("Poupança", AccountType.ASSET, AccountSubtype.SAVINGS, [ana], "Banco Azul");
  const joint = account("Conta conjunta", AccountType.ASSET, AccountSubtype.CHECKING, [ana, bruno], "Banco Verde");
  const cardAccount = account("Cartão Azul", AccountType.LIABILITY, AccountSubtype.CREDIT_CARD);
  const card = ledger.addCard(
    CardSchema.parse({
      name: "Cartão Azul",
      liability_account_id: cardAccount,
      holder_id: ana,
      last4: "4821",
      closing_day: 3,
      due_day: 10,
      settlement_account_id: bank,
    }),
  ).id;
  const category = (n: string, kind: AccountType = AccountType.EXPENSE) =>
    ledger.categories(kind).find((a) => a.name === n)!.id;
  const salary = category("Salário", AccountType.INCOME);

  // Six months back from the current one.
  const year = yearOf(today);
  const month = monthOf(today);
  const start = makeDate(month > 6 ? year : year - 1, ((month - 7 + 12) % 12) + 1, 1);
  ledger.recordOpeningBalance(bank, "8450.00", start);
  ledger.recordOpeningBalance(joint, "2300.00", start);
  ledger.recordOpeningBalance(savings, "12000.00", start);
  const shops: [string, string][] = [
    ["Mercado Pão de Açúcar", "Alimentação"],
    ["Farmácia São Paulo", "Saúde"],
    ["Posto Shell", "Transporte"],
    ["Restaurante Bom Prato", "Alimentação"],
    ["Padaria Real", "Alimentação"],
    ["Cinema Center", "Lazer"],
  ];
  for (let m = 0; m < 7; m++) {
    const first = addDays(start, 0);
    const base = makeDate(
      yearOf(first) + Math.floor((monthOf(first) - 1 + m) / 12),
      ((monthOf(first) - 1 + m) % 12) + 1,
      1,
    );
    const day = (d: number) => addDays(base, d - 1);
    if (day(5) > today) break;
    ledger.recordIncome(bank, salary, "7800.00", day(5), "Salário Ana");
    ledger.recordIncome(joint, salary, "5200.00", day(5), "Salário Bruno", { member_id: bruno });
    ledger.recordExpense(bank, category("Moradia"), "2350.00", day(10), "Aluguel");
    ledger.recordExpense(joint, category("Serviços e assinaturas"), "189.90", day(12), "Internet e streaming");
    shops.forEach(([shop, cat], i) => {
      const when = day(3 + i * 4);
      if (when <= today) ledger.recordCardPurchase(card, category(cat), cents(3700 + 2317 * i + 311 * m), when, shop);
    });
    if (day(10) <= today && m > 0) ledger.recordCardPayment(card, bank, `${420 + m * 15}.00`, day(10));
    if (day(20) <= today) ledger.recordTransfer(bank, savings, "500.00", day(20), "Reserva");
  }
  ledger.markClean(ledger.changeCount);
  return ledger;
}
