/**
 * More demonstration data for the web app only (docs/18 W12). The domain's `demoSession` has golden parity with the
 * desktop demo and stays as it is; the paths it leaves empty are filled here, applied on top of it, so that the
 * end-to-end tests walk the real code instead of an empty state:
 *
 * - Reembolsos e acertos: a debt between members (a card purchase of Ana's that is Bruno's expense);
 * - Recorrências: a rule with an operation that can be linked to its due date, and a charge that repeats for three
 *   months and has no rule yet;
 * - Investimentos: a stock bought and partly sold (renda variável, with realized result);
 * - Contas e cartões: a card bill that falls due in the current month.
 *
 * Dates that must follow the clock (the current month) take `today`; the others are fixed 2026 dates, like the rest
 * of the demonstration.
 */
import {
  AccountType,
  dom,
  investments,
  makeDate,
  ymAdd,
  ymOf,
  type Id,
  type IsoDate,
  type Ledger,
  type session as sessions,
} from "@opesvault/domain";

function category(ledger: Ledger, name: string, kind: AccountType = AccountType.EXPENSE): Id {
  const found = ledger.categories(kind).find((account) => account.name === name);
  if (found === undefined) throw new Error(`no category ${name}`);
  return found.id;
}

function named<T extends { id: Id; name: string }>(items: Iterable<T>, name: string): T {
  for (const item of items) if (item.name === name) return item;
  throw new Error(`no ${name}`);
}

export function applyDemoExtras(session: sessions.Session, today: IsoDate): void {
  const ledger = session.ledger;
  const bruno = named(ledger.members.values(), "Bruno");
  const bank = named(ledger.accounts.values(), "Banco A");
  const card = named(ledger.cards.values(), "Cartão X");
  const previous = ymAdd(ymOf(today), -1);

  // A debt between members: the card is Ana's, the expense is Bruno's, so Bruno owes Ana its amount.
  ledger.recordCardPurchase(
    card.id,
    category(ledger, "Lazer"),
    "180.00",
    makeDate(2026, 3, 18),
    "Presente do Bruno",
    null,
    {
      member_id: bruno.id,
    },
  );

  // A bill that falls due in the current month: a purchase of the previous month's day 15 closes on the 3rd
  // and falls due on the 10th of this month (closing day 3, due day 10).
  ledger.recordCardPurchase(
    card.id,
    category(ledger, "Alimentação"),
    "329.90",
    makeDate(previous.year, previous.month, 15),
    "Supermercado do cartão",
  );

  // A rule whose due date is today, with the operation that realizes it, still to be linked by the person.
  const condo = category(ledger, "Moradia");
  dom.recurrence.addRule(
    ledger,
    dom.recurrence.RecurrenceRuleSchema.parse({
      description: "Condomínio",
      account_id: bank.id,
      counterpart_id: condo,
      amount: "780.00",
      tolerance: "0",
      day: Math.min(Number(today.slice(8, 10)), 28),
      start: makeDate(2026, 1, 1),
    }),
  );
  ledger.recordExpense(bank.id, condo, "780.00", today, "Condomínio");

  // A charge that repeats for three months in a row (the three months before this one), with no rule yet.
  for (const back of [3, 2, 1]) {
    const month = ymAdd(ymOf(today), -back);
    ledger.recordExpense(
      bank.id,
      category(ledger, "Lazer"),
      "119.90",
      makeDate(month.year, month.month, 5),
      "Academia Fit",
    );
  }

  // Variable income: 100 shares bought, 40 sold with a gain (average cost 30.00, sold at 36.50).
  const shares = investments.service.createPosition(
    ledger,
    "PETR4",
    investments.model.AssetClass.STOCK,
    makeDate(2026, 2, 10),
    {
      mode: investments.model.TrackingMode.QUANTITY,
      ticker: "PETR4",
    },
  );
  investments.trades.buy(ledger, shares.id, makeDate(2026, 2, 10), "100", "30.00", bank.id, { fees: "4.90" });
  investments.trades.sell(ledger, shares.id, makeDate(2026, 3, 20), "40", "36.50", bank.id, { fees: "4.90" });
}
