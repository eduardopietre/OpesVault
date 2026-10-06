/**
 * A project with synthetic data in every feature: the web app's demo, screenshots and the
 * every-screen test use it. Port of `tests/demo_vault.py` (and the `family()` fixture of
 * `tests/domain_fixtures.py` it starts from).
 *
 * Development and demonstration only: names, documents and numbers are invented, and nothing is
 * stored anywhere. The dates are the desktop's fixed 2026 dates; the operations the desktop dated
 * `date.today()` (a recent expense pair and the budget of the current month) take `today`.
 *
 * The project is named "Projeto Teste", as on the desktop: `demo_session` created a session called
 * "Projeto Silva" and then replaced its ledger with the fixture's.
 */
import * as balanceChecks from "./domain/balance_checks.ts";
import * as banking from "./domain/banking.ts";
import * as budget from "./domain/budget.ts";
import { recordInstallmentPurchase } from "./domain/cards.ts";
import * as deductibles from "./domain/deductibles.ts";
import * as goals from "./domain/goals.ts";
import { Ledger } from "./domain/ledger.ts";
import * as loans from "./domain/loans.ts";
import * as merchants from "./domain/merchants.ts";
import { AccountSubtype, AccountType, CardSchema, LedgerAccountSchema } from "./domain/model.ts";
import { addRule, RecurrenceRuleSchema } from "./domain/recurrence.ts";
import * as sharing from "./domain/sharing.ts";
import * as tags from "./domain/tags.ts";
import { NUBANK_CARD_PDF } from "./demo_docs/index.ts";
import { importDocument } from "./importing/pipeline.ts";
import * as importRules from "./importing/rules.ts";
import { type PdfTextExtractor, PdfJsExtractor } from "./importing/source.ts";
import * as profile from "./investments/profile.ts";
import { AssetClass, ValueNature } from "./investments/model.ts";
import { addValuation, createPosition, positions } from "./investments/service.ts";
import { type IsoDate, makeDate, today as localToday, ymOf } from "./lib/dates.ts";
import { Dec } from "./lib/dec.ts";
import type { Id } from "./lib/ids.ts";
import { Session } from "./session.ts";
import {
  IncomeKind,
  IncomeNature,
  NatureSubject,
  ReportField,
  ReportLineSchema,
  ReportSource,
  TaxSubject,
} from "./tax/model.ts";
import * as taxRecords from "./tax/records.ts";

export interface Family {
  readonly ledger: Ledger;
  readonly ana: Id;
  readonly bruno: Id;
  readonly bank: Id;
  readonly savings: Id;
  readonly joint: Id;
  readonly card_account: Id;
  readonly card: Id;
  readonly groceries: Id;
  readonly salary: Id;
}

function category(ledger: Ledger, name: string, kind: AccountType = AccountType.EXPENSE): Id {
  const found = ledger.categories(kind).find((a) => a.name === name);
  if (found === undefined) throw new Error(`no category ${name}`);
  return found.id;
}

/** `family()` of `tests/domain_fixtures.py`. */
function family(): Family {
  const ledger = Ledger.new("Projeto Teste");
  const ana = ledger.addMember("Ana").id;
  const bruno = ledger.addMember("Bruno").id;
  const account = (name: string, type: AccountType, subtype: AccountSubtype, holders: Id[] = []) =>
    ledger.addAccount(LedgerAccountSchema.parse({ name, type, subtype, holders })).id;
  const bank = account("Banco A", AccountType.ASSET, AccountSubtype.CHECKING, [ana]);
  const savings = account("Poupança", AccountType.ASSET, AccountSubtype.SAVINGS, [ana]);
  const joint = account("Conjunta", AccountType.ASSET, AccountSubtype.CHECKING, [ana, bruno]);
  const card_account = account("Cartão X", AccountType.LIABILITY, AccountSubtype.CREDIT_CARD);
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

export interface DemoOptions {
  /** The current date; the desktop used `date.today()`. */
  readonly today?: IsoDate;
  /** Reads the synthetic card statement the demo imports. */
  readonly extractor?: PdfTextExtractor;
}

export async function demoSession(options: DemoOptions = {}): Promise<Session> {
  const today = options.today ?? localToday();
  const extractor = options.extractor ?? new PdfJsExtractor();
  const f = family();
  const ledger = f.ledger;
  const session = Session.new("Projeto Silva");
  session.ledger = ledger;
  ledger.recordOpeningBalance(f.bank, "8450.00", makeDate(2026, 1, 1));
  ledger.recordOpeningBalance(f.joint, "2300.00", makeDate(2026, 1, 1));
  const names = ["Mercado Pão de Açúcar", "Farmácia São Paulo", "Posto Shell", "Restaurante Bom Prato", "Padaria Real"];
  const cats = ["Alimentação", "Saúde", "Transporte", "Alimentação", "Alimentação"];
  for (let month = 1; month <= 3; month++) {
    ledger.recordIncome(f.bank, f.salary, "7800.00", makeDate(2026, month, 5), "Salário");
    names.forEach((name, i) => {
      ledger.recordCardPurchase(
        f.card,
        category(ledger, cats[i]!),
        Dec.from(37 + 23 * i + month),
        makeDate(2026, month, 3 + i * 4),
        name,
      );
    });
    ledger.recordExpense(f.bank, category(ledger, "Moradia"), "2350.00", makeDate(2026, month, 10), "Aluguel");
  }
  recordInstallmentPurchase(ledger, f.card, category(ledger, "Lazer"), "2400.00", makeDate(2026, 2, 14), "TV 55", 6);
  addRule(
    ledger,
    RecurrenceRuleSchema.parse({
      description: "Aluguel",
      account_id: f.bank,
      counterpart_id: category(ledger, "Moradia"),
      amount: "2350.00",
      tolerance: "0",
      day: 10,
      start: makeDate(2026, 1, 1),
    }),
  );
  const pos = createPosition(ledger, "CDB Banco X 2028", AssetClass.FIXED_INCOME, makeDate(2026, 1, 2), {
    initial_cost: "5000",
    from_account: f.bank,
  });
  for (const [month, value] of [
    [1, "5040"],
    [2, "5085"],
    [3, "5131"],
  ] as const) {
    addValuation(ledger, pos.id, makeDate(2026, month, 28), value, ValueNature.GROSS);
  }
  await importDocument(
    session,
    { name: "fatura-nubank-03.pdf", data: NUBANK_CARD_PDF, parser_id: null, account_id: null, card_id: null },
    extractor,
  );
  const current = ymOf(today);
  for (const [name, value] of [
    ["Alimentação", "600.00"],
    ["Moradia", "2350.00"],
    ["Transporte", "120.00"],
    ["Saúde", "60.00"],
  ] as const) {
    for (const month of [{ year: 2026, month: 3 }, current]) {
      budget.setBudget(ledger, category(ledger, name), month, value);
    }
  }
  ledger.recordExpense(f.bank, category(ledger, "Transporte"), "145.00", today, "Posto Shell");
  ledger.recordExpense(f.bank, category(ledger, "Alimentação"), "560.00", today, "Mercado do mês");
  importRules.addRule(ledger, "padaria", category(ledger, "Alimentação"));
  demoPlanning(f, ledger);
  demoTax(f, ledger, today);
  demoBanking(f, ledger, today);
  return session;
}

/** Loans, tags, reimbursements, bank checks, deductibles and a subscription (review of 03/10/2026). */
function demoPlanning(f: Family, ledger: Ledger): void {
  const debt = ledger.addAccount(
    LedgerAccountSchema.parse({
      name: "Financiamento do carro",
      type: AccountType.LIABILITY,
      subtype: AccountSubtype.LOAN,
    }),
  );
  const plan = loans.createLoan(
    ledger,
    loans.LoanPlanSchema.parse({
      name: "Financiamento do carro",
      liability_account_id: debt.id,
      payment_account_id: f.bank,
      interest_category_id: category(ledger, "Juros e encargos"),
      principal: "38000.00",
      monthly_rate: "0.0149",
      term: 36,
      system: loans.AmortizationSystem.PRICE,
      first_due: makeDate(2026, 1, 20),
    }),
    loans.Opening.OPENING_BALANCE,
    { on: makeDate(2025, 12, 20) },
  );
  for (const [number, day] of [
    [1, makeDate(2026, 1, 20)],
    [2, makeDate(2026, 2, 20)],
  ] as const) {
    loans.payInstallment(ledger, plan.id, number, day);
  }
  for (let month = 1; month <= 3; month++) {
    ledger.recordCardPurchase(
      f.card,
      category(ledger, "Serviços e assinaturas"),
      "55.90",
      makeDate(2026, month, 12),
      "NETFLIX.COM",
    );
  }
  const trip = [
    ledger.recordCardPurchase(f.card, category(ledger, "Lazer"), "1380.00", makeDate(2026, 2, 2), "Pousada Serra"),
    ledger.recordCardPurchase(f.card, category(ledger, "Alimentação"), "412.30", makeDate(2026, 2, 3), "Restaurante"),
    ledger.recordCardPurchase(
      f.card,
      category(ledger, "Transporte"),
      "260.00",
      makeDate(2026, 2, 4),
      "Pedágio e posto",
    ),
  ];
  tags.addTag(
    ledger,
    trip.map((op) => op.id),
    "Viagem Serra 2026",
  );
  const consult = ledger.recordExpense(
    f.bank,
    category(ledger, "Saúde"),
    "450.00",
    makeDate(2026, 3, 6),
    "Consulta pediatra",
    { member_id: f.bruno },
  );
  const reimbursement = sharing.request(ledger, consult.id, "Plano de saúde", "300.00", makeDate(2026, 3, 7));
  sharing.receive(ledger, reimbursement.id, f.bank, "150.00", makeDate(2026, 3, 25));
  deductibles.mark(ledger, category(ledger, "Saúde"), deductibles.DeductibleKind.HEALTH);
  deductibles.mark(ledger, category(ledger, "Educação"), deductibles.DeductibleKind.EDUCATION);
  balanceChecks.record(ledger, f.bank, makeDate(2026, 3, 31), "9000.00", "extrato do aplicativo");
  goals.addGoal(
    ledger,
    goals.GoalSchema.parse({
      name: "Reserva de emergência",
      kind: goals.GoalKind.ACCOUNTS,
      target: "30000.00",
      target_date: makeDate(2027, 12, 31),
      account_ids: [f.bank, f.savings],
      created_on: makeDate(2026, 1, 1),
    }),
  );
  merchants.nameMerchant(ledger, "NETFLIX.COM", "Netflix");
}

/** CPF/CNPJ, natures, a payslip and an informe, so the Imposto de renda page has content. */
function demoTax(f: Family, ledger: Ledger, today: IsoDate): void {
  taxRecords.setMemberInfo(
    ledger,
    f.ana,
    { cpf: "529.982.247-25", birth_date: makeDate(1985, 4, 2), declared_by: null },
    today,
  );
  taxRecords.setMemberInfo(
    ledger,
    f.bruno,
    { cpf: "111.444.777-35", birth_date: makeDate(2016, 8, 9), declared_by: f.ana, relation: "Filho(a)" },
    today,
  );
  taxRecords.classify(ledger, NatureSubject.CATEGORY, f.salary, IncomeNature.TAXABLE_PJ);
  taxRecords.setIdentity(ledger, TaxSubject.CATEGORY, f.salary, "11.222.333/0001-81", "Empresa Exemplo Ltda");
  const first = [...ledger.activeOperations()].find((op) => op.description === "Salário")!;
  taxRecords.setIncomeDetail(ledger, first.id, IncomeKind.SALARY, "9600.00", "1210.00", "908.86");
  taxRecords.setIdentity(ledger, TaxSubject.ACCOUNT, f.bank, "11.222.333/0001-81", "Banco A S.A.");
  taxRecords.saveReport(
    ledger,
    2026,
    ReportSource.ACCOUNT,
    f.bank,
    [ReportLineSchema.parse({ field: ReportField.BALANCE_END, amount: "16052.00", label: "Saldo em 31/12/2026" })],
    { payer_tax_id: "11.222.333/0001-81" },
  );
}

/** The demo's bank and savings as one bank account, the CDB held there, and an LCA. */
function demoBanking(f: Family, ledger: Ledger, today: IsoDate): void {
  const built = banking.build({
    name: "Itaú da Ana",
    bank_code: "341",
    bank_name: null,
    branch: "0123",
    number: "45678-9",
    holder_id: f.ana,
    co_holder_id: f.bruno,
  });
  const item = banking.create(ledger, built, { checking: f.bank, savings: f.savings });
  const cdb = positions(ledger).values().next().value!;
  profile.saveProfile(
    ledger,
    profile.InvestmentProfileSchema.parse({
      position_id: cdb.id,
      bank_account_id: item.id,
      irpf_group: "04",
      irpf_code: "02",
      issuer: "Banco X S.A.",
      indexer: profile.Indexer.CDI,
      rate: "110",
      applied_on: makeDate(2026, 1, 2),
      maturity: makeDate(2028, 1, 3),
      liquidity: profile.Liquidity.AT_MATURITY,
      tax: profile.TaxTreatment.WITHHELD,
      income_code: "exclusivo:06",
      fgc: true,
    }),
  );
  const nubank = banking.create(
    ledger,
    banking.build({
      name: "Nubank do Bruno",
      bank_code: "260",
      bank_name: null,
      branch: "0001",
      number: "9876543-2",
      holder_id: f.bruno,
    }),
    {
      checking: true,
      opening: new Map([[banking.Part.CHECKING, [Dec.from("640.00"), makeDate(2026, 1, 1)] as const]]),
    },
  );
  if (nubank.checking_id === null) throw new Error("the checking account was not created");
  banking.recordValues(ledger, nubank.id, makeDate(2026, 3, 31), new Map([[nubank.checking_id, "712.40"]]), today, {
    adjust: new Set(),
  });
}
