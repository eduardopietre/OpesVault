/**
 * A large, realistic project for the performance measurements (docs/18 W12): about 50 000 operations over
 * five years, with history, cards, recurrences, budgets, investments, tags and import batches.
 * Built only through the domain API, with a fixed seed, so every run measures the same project.
 * Used by the perf entry (browser) and by tools/perf_report.ts (Node).
 */
import {
  AccountSubtype,
  AccountType,
  CardSchema,
  Ledger,
  LedgerAccountSchema,
  addDays,
  dom,
  importing,
  investments,
  makeDate,
  session as sessions,
  type Id,
  type IsoDate,
} from "@opesvault/domain";

export interface BigProjectOptions {
  readonly operations?: number;
  readonly years?: number;
  /** Last day of the generated period. */
  readonly end?: IsoDate;
}

export interface BigProject {
  readonly session: sessions.Session;
  readonly operations: number;
}

function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const MERCHANTS = [
  "Mercado Pão de Açúcar",
  "Padaria Real",
  "Posto Shell",
  "Farmácia São Paulo",
  "Restaurante Bom Prato",
  "Uber",
  "Cinema Centro",
  "Livraria Cultura",
  "Pet Shop Amigo",
  "Loja de Roupas Moda",
  "Supermercado Extra",
  "Lanchonete do Zé",
  "Estacionamento Central",
  "Papelaria Escolar",
  "Oficina Mecânica Silva",
];
const CATEGORY_NAMES = ["Alimentação", "Saúde", "Transporte", "Lazer", "Moradia", "Educação"];

function cents(value: number): string {
  const c = Math.max(100, Math.round(value));
  return `${Math.floor(c / 100)}.${String(c % 100).padStart(2, "0")}`;
}

export async function buildBigProject(options: BigProjectOptions = {}): Promise<BigProject> {
  const total = options.operations ?? 50_000;
  const years = options.years ?? 5;
  const end = options.end ?? makeDate(2026, 9, 30);
  const firstYear = Number(end.slice(0, 4)) - years + 1;
  const start = makeDate(firstYear, 1, 1);
  const days = Math.round((Date.parse(end) - Date.parse(start)) / 86_400_000) + 1;
  const rnd = prng(20261006);
  const session = sessions.Session.new("Projeto Grande");
  const ledger = Ledger.new("Projeto Grande");
  session.ledger = ledger;
  const ana = ledger.addMember("Ana").id;
  const bruno = ledger.addMember("Bruno").id;
  const account = (name: string, type: AccountType, subtype: AccountSubtype, holders: Id[] = []) =>
    ledger.addAccount(LedgerAccountSchema.parse({ name, type, subtype, holders })).id;
  const bank = account("Banco A", AccountType.ASSET, AccountSubtype.CHECKING, [ana]);
  const joint = account("Conjunta", AccountType.ASSET, AccountSubtype.CHECKING, [ana, bruno]);
  const savings = account("Poupança", AccountType.ASSET, AccountSubtype.SAVINGS, [ana]);
  const cardAccounts = [0, 1, 2].map((i) =>
    account(`Cartão ${i + 1}`, AccountType.LIABILITY, AccountSubtype.CREDIT_CARD),
  );
  const cards = cardAccounts.map(
    (liability, i) =>
      ledger.addCard(
        CardSchema.parse({
          name: `Cartão ${i + 1}`,
          liability_account_id: liability,
          holder_id: i === 1 ? bruno : ana,
          last4: String(1000 + i),
          closing_day: 3 + i,
          due_day: 10 + i,
          settlement_account_id: bank,
        }),
      ).id,
  );
  const find = (name: string, kind: AccountType = AccountType.EXPENSE): Id => {
    const found = ledger.categories(kind).find((a) => a.name === name);
    if (found === undefined) throw new Error(`no category ${name}`);
    return found.id;
  };
  const cats = CATEGORY_NAMES.map((n) => find(n));
  const salary = find("Salário", AccountType.INCOME);
  ledger.recordOpeningBalance(bank, "8450.00", start);
  ledger.recordOpeningBalance(joint, "2300.00", start);

  const monthly = years * 12;
  const bulk = Math.max(0, total - monthly * 6);
  for (let i = 0; i < bulk; i++) {
    const day = addDays(start, Math.floor(rnd() * days));
    const merchant = MERCHANTS[Math.floor(rnd() * MERCHANTS.length)]!;
    const amount = cents(500 + rnd() * rnd() * 60_000);
    const category = cats[Math.floor(rnd() * cats.length)]!;
    const description = `${merchant} ${i % 97}`;
    const roll = rnd();
    if (roll < 0.35) {
      ledger.recordCardPurchase(cards[Math.floor(rnd() * cards.length)]!, category, amount, day, description);
    } else if (roll < 0.97) {
      ledger.recordExpense(roll < 0.8 ? bank : joint, category, amount, day, description);
    } else {
      ledger.recordTransfer(bank, savings, amount, day, "Reserva mensal");
    }
  }
  const housing = find("Moradia");
  for (let m = 0; m < monthly; m++) {
    const year = firstYear + Math.floor(m / 12);
    const month = (m % 12) + 1;
    ledger.recordIncome(bank, salary, "7800.00", makeDate(year, month, 5), "Salário");
    ledger.recordExpense(bank, housing, "2350.00", makeDate(year, month, 10), "Aluguel");
    for (const card of cards.slice(0, 2)) {
      ledger.recordCardPayment(card, bank, cents(150_000 + rnd() * 80_000), makeDate(year, month, 12));
    }
    ledger.recordExpense(joint, housing, cents(18_000 + rnd() * 6000), makeDate(year, month, 15), "Condomínio");
    ledger.recordIncome(joint, salary, "4200.00", makeDate(year, month, 6), "Salário Bruno");
  }

  for (const [description, counter, amount, day] of [
    ["Aluguel", housing, "2350.00", 10],
    ["Salário", salary, "7800.00", 5],
  ] as const) {
    dom.recurrence.addRule(
      ledger,
      dom.recurrence.RecurrenceRuleSchema.parse({
        description,
        account_id: bank,
        counterpart_id: counter,
        amount,
        tolerance: "0",
        day,
        start,
      }),
    );
  }
  for (let y = 0; y < years; y++) {
    for (let month = 1; month <= 12; month++) {
      for (const c of cats) {
        dom.budget.setBudget(ledger, c, { year: firstYear + y, month }, cents(40_000 + (c.charCodeAt(0) % 7) * 20_000));
      }
    }
  }
  for (let p = 0; p < 4; p++) {
    const pos = investments.service.createPosition(
      ledger,
      `CDB Banco ${p + 1}`,
      investments.model.AssetClass.FIXED_INCOME,
      start,
      { initial_cost: "5000", from_account: bank },
    );
    for (let m = 0; m < monthly; m++) {
      investments.service.addValuation(
        ledger,
        pos.id,
        makeDate(firstYear + Math.floor(m / 12), (m % 12) + 1, 28),
        cents(500_000 * (1 + 0.009 * (m + 1))),
        investments.model.ValueNature.GROSS,
      );
    }
  }
  const sample = [...ledger.activeOperations()].filter((_, i) => i % 997 === 7);
  dom.tags.addTag(
    ledger,
    sample.slice(0, 40).map((o) => o.id),
    "Viagem",
  );
  dom.tags.addTag(
    ledger,
    sample.slice(40, 65).map((o) => o.id),
    "Reforma",
  );
  // A few import batches (OFX needs no PDF engine), each with some items.
  const noPdf = { extract: () => Promise.reject(new Error("no pdf")) };
  for (let b = 0; b < 3; b++) {
    const lines = Array.from({ length: 40 }, (_, i) => {
      const d = addDays(end, -(b * 40 + i)).replaceAll("-", "");
      return `<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>${d}<TRNAMT>-${(10 + i * 3.7).toFixed(2)}<FITID>B${b}-${i}<MEMO>${MERCHANTS[i % MERCHANTS.length]}</STMTTRN>`;
    }).join("\n");
    const ofx = `OFXHEADER:100\nDATA:OFXSGML\nVERSION:102\n\n<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><CURDEF>BRL<BANKACCTFROM><BANKID>341<ACCTID>${b}</BANKACCTFROM><BANKTRANLIST>\n${lines}\n</BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`;
    await importing.pipeline
      .importDocument(
        session,
        {
          name: `extrato-${b}.ofx`,
          data: new TextEncoder().encode(ofx),
          parser_id: null,
          account_id: bank,
          card_id: null,
        },
        noPdf,
      )
      .catch(() => undefined);
  }
  return { session, operations: [...ledger.activeOperations()].length };
}
