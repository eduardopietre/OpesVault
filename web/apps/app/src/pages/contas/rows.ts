/**
 * Contas e cartões without React: the rows of every table, the labels and the references other screens use
 * to reach an object here (the desktop keeps these in each tab; here they are testable on their own, like
 * `pages/tax/rows.py`).
 */
import {
  AccountType,
  Dec,
  dom,
  formatBrl,
  formatDateBr,
  formatDecimalBr,
  importing,
  investments,
  queries,
  ymOf,
  ymParse,
  ymStr,
  type Id,
  type IsoDate,
  type Ledger,
  type LedgerAccount,
  type YearMonth,
  catalogs,
} from "@opesvault/domain";
import { ROLE_LABELS, subtypeLabel } from "../../dialogs/accounts_labels.ts";

const { banking, balanceChecks, cards, loans } = dom;
const { profile: prof } = investments;

const DASH = "—";

/** Exact cents for sorting a money column. */
export function cents(value: Dec | null): bigint | null {
  return value === null ? null : BigInt(value.quantize("0.01", "ROUND_HALF_UP").toFixed().replace(".", ""));
}

export const money = (value: Dec | null): string => (value === null ? DASH : formatBrl(value));

/** How many, with the right plural ("1 conta", "2 contas"). */
export function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

// ── tabs ─────────────────────────────────────────

export const TAB_IDS = [
  "bancarias",
  "contas",
  "cartoes",
  "faturas",
  "financiamentos",
  "categorias",
  "regras",
  "integrantes",
] as const;
export type TabId = (typeof TAB_IDS)[number];

export const TAB_LABELS: Readonly<Record<TabId, string>> = {
  bancarias: "Contas bancárias",
  contas: "Todas as contas",
  cartoes: "Cartões",
  faturas: "Faturas",
  financiamentos: "Financiamentos",
  categorias: "Categorias",
  regras: "Regras",
  integrantes: "Integrantes",
};

// ── what a link points to ────────────────────────

export type Reveal =
  | { kind: "bill"; cardId: Id; month: YearMonth | null }
  | { kind: "loan"; planId: Id; number: number | null }
  | { kind: "check"; accountId: Id }
  | { kind: "account"; accountId: Id }
  | { kind: "card"; cardId: Id }
  | { kind: "bank"; bankId: Id };

/**
 * The `ref` of a link (docs `data/links.ts`): "<cardId>:<YYYY-MM>" a bill, "loan:<planId>:<number>" an
 * installment, "check:<accountId>" an account with a balance that differs from the bank, "conta:<id>" an
 * account, "cartao:<id>" a card; a bare id is looked up (a card, a financing, a bank account, an account).
 */
export function parseReveal(ref: string | undefined, ledger: Ledger): Reveal | null {
  if (!ref) return null;
  const [head, second, third] = ref.split(":");
  if (head === "loan" && second) {
    const number = third === undefined ? null : Number(third);
    return { kind: "loan", planId: second, number: number !== null && Number.isInteger(number) ? number : null };
  }
  if (head === "check" && second) return { kind: "check", accountId: second };
  if (head === "conta" && second) return { kind: "account", accountId: second };
  if (head === "cartao" && second) return { kind: "card", cardId: second };
  if (head === "banco" && second) return { kind: "bank", bankId: second };
  if (head && second && /^\d{4}-(0[1-9]|1[0-2])$/.test(second)) {
    return { kind: "bill", cardId: head, month: ymParse(second) };
  }
  if (head && second === undefined) {
    if (ledger.cards.has(head)) return { kind: "bill", cardId: head, month: null };
    if (loans.plans(ledger).has(head)) return { kind: "loan", planId: head, number: null };
    if (banking.bankAccounts(ledger).has(head)) return { kind: "bank", bankId: head };
    if (ledger.accounts.has(head)) return { kind: "account", accountId: head };
  }
  return null;
}

// ── members, cards, categories ───────────────────

export interface MemberRow {
  id: Id;
  name: string;
  role: string;
  status: string;
}

export function memberRows(ledger: Ledger): MemberRow[] {
  return [...ledger.members.values()].map((m) => ({
    id: m.id,
    name: m.name,
    role: ROLE_LABELS[m.role],
    status: m.active ? "Ativo" : "Inativo",
  }));
}

export interface CardRow {
  id: Id;
  name: string;
  holder: string;
  last4: string;
  closing: number;
  due: number;
  open: Dec;
}

export function cardRows(ledger: Ledger): CardRow[] {
  const balances = queries.balances(ledger);
  const names = new Map([...ledger.members.values()].map((m) => [m.id, m.name]));
  return [...ledger.cards.values()].map((c) => ({
    id: c.id,
    name: c.name,
    holder: names.get(c.holder_id) ?? "?",
    last4: c.last4,
    closing: c.closing_day,
    due: c.due_day,
    open: balances.get(c.liability_account_id) ?? Dec.from(0),
  }));
}

export function deductibleLabel(ledger: Ledger, account: LedgerAccount): string {
  if (account.type !== AccountType.EXPENSE) return "";
  const kind = dom.deductibles.kindOf(ledger, account.id);
  return kind === null ? "" : dom.deductibles.KIND_LABELS[kind];
}

export interface CategoryRow {
  id: Id;
  name: string;
  kind: string;
  parent: string;
  deductible: string;
}

export function categoryRows(ledger: Ledger): CategoryRow[] {
  return [AccountType.EXPENSE, AccountType.INCOME].flatMap((kind) =>
    ledger.categories(kind).map((a) => ({
      id: a.id,
      name: a.name,
      kind: kind === AccountType.INCOME ? "Receita" : "Despesa",
      parent: (a.parent_id !== null ? ledger.accounts.get(a.parent_id)?.name : undefined) ?? "",
      deductible: deductibleLabel(ledger, a),
    })),
  );
}

/** The line under the title. */
export function summaryLine(ledger: Ledger): string {
  const accounts = [...ledger.accounts.values()].filter(
    (a) => a.type === AccountType.ASSET || a.type === AccountType.LIABILITY,
  ).length;
  return `${plural(accounts, "conta", "contas")} · ${plural(ledger.cards.size, "cartão", "cartões")} · ${plural(ledger.members.size, "integrante", "integrantes")}`;
}

// ── all accounts ─────────────────────────────────

export interface AccountRow {
  id: Id;
  name: string;
  type: string;
  institution: string;
  holders: string;
  balance: Dec;
  checked: string;
  diverges: boolean;
}

export function checkLabel(result: dom.balanceChecks.CheckResult | undefined): string {
  if (result === undefined) return "nunca";
  const when = formatDateBr(result.check.on);
  return result.matches ? `${when}: confere` : `${when}: diferença de ${formatBrl(result.difference)}`;
}

export function accountRows(ledger: Ledger): AccountRow[] {
  const names = new Map([...ledger.members.values()].map((m) => [m.id, m.name]));
  const balances = queries.balances(ledger);
  const latest = balanceChecks.latest(ledger);
  return [...ledger.accounts.values()]
    .filter((a) => a.type === AccountType.ASSET || a.type === AccountType.LIABILITY)
    .sort((a, b) => a.name.localeCompare(b.name, "pt-BR", { sensitivity: "base" }))
    .map((a) => ({
      id: a.id,
      name: a.name,
      type: subtypeLabel(a.subtype),
      institution: a.institution ?? "",
      holders: a.holders.map((h) => names.get(h) ?? "?").join(", "),
      balance: balances.get(a.id) ?? Dec.from(0),
      checked: checkLabel(latest.get(a.id)),
      diverges: latest.get(a.id)?.matches === false,
    }));
}

export interface CheckRow {
  id: Id;
  on: string;
  bank: string;
  app: string;
  difference: string;
  matches: boolean;
  note: string;
}

export function checkRows(ledger: Ledger, accountId: Id): CheckRow[] {
  return balanceChecks.results(ledger, accountId).map((r) => ({
    id: r.check.id,
    on: formatDateBr(r.check.on),
    bank: formatBrl(r.check.informed),
    app: formatBrl(r.computed),
    difference: r.matches ? "confere" : formatBrl(r.difference),
    matches: r.matches,
    note: r.check.note ?? "",
  }));
}

// ── bank accounts ────────────────────────────────

export interface BankRow {
  id: Id;
  name: string;
  bank: string;
  branch: string;
  number: string;
  holders: string;
  checking: string;
  savings: string;
  investments: string;
  total: string;
  totalCents: bigint | null;
}

export function bankLabel(item: dom.banking.BankAccount): string {
  const listed = catalogs.bank(item.bank_code);
  return listed ? `${listed.code} — ${listed.short_name}` : item.bank_name;
}

export function holderNames(ledger: Ledger, item: dom.banking.BankAccount): string {
  const name = (id: Id | null) => (id === null ? "?" : (ledger.members.get(id)?.name ?? "?"));
  return name(item.holder_id) + (banking.joint(item) ? ` e ${name(item.co_holder_id)} (conjunta)` : "");
}

/** The bank accounts that are still open, by name. */
export function openBankAccounts(ledger: Ledger): dom.banking.BankAccount[] {
  return [...banking.bankAccounts(ledger).values()]
    .filter((b) => !b.archived)
    .sort((a, b) => a.name.localeCompare(b.name, "pt-BR", { sensitivity: "base" }));
}

export function bankRows(ledger: Ledger, today: IsoDate): BankRow[] {
  return openBankAccounts(ledger).map((item) => {
    const values = banking.valuesAt(ledger, item.id, today);
    const byKind = new Map(values.filter((v) => v.kind !== "investment").map((v) => [v.kind, v.value]));
    const invested = values.filter((v) => v.kind === "investment");
    const known = invested.flatMap((v) => (v.value === null ? [] : [v.value]));
    const total = banking.total(values);
    return {
      id: item.id,
      name: item.name,
      bank: bankLabel(item),
      branch: item.branch ?? DASH,
      number: item.number ?? DASH,
      holders: holderNames(ledger, item),
      checking: byKind.has("checking") ? money(byKind.get("checking") ?? null) : DASH,
      savings: byKind.has("savings") ? money(byKind.get("savings") ?? null) : DASH,
      investments: (known.length ? formatBrl(Dec.sum(known)) : DASH) + (known.length < invested.length ? " *" : ""),
      total: money(total),
      totalCents: cents(total),
    };
  });
}

export interface PartRow {
  /** The ledger account or the position. */
  id: Id;
  kind: string;
  label: string;
  irpf: string;
  yield: string;
  maturity: string;
  tax: string;
  today: string;
  lastBank: string;
}

export function partRows(ledger: Ledger, item: dom.banking.BankAccount, today: IsoDate): PartRow[] {
  const latest = balanceChecks.latest(ledger);
  return banking.valuesAt(ledger, item.id, today).map((value) => {
    if (value.kind === "investment") {
      const profile = prof.profileOf(ledger, value.ref);
      const observed = investments.performance.valueAt(ledger, value.ref, today);
      return {
        id: value.ref,
        kind: value.kind,
        label: value.label,
        irpf: profile ? catalogs.irpf.assetLabel(profile.irpf_group, profile.irpf_code) : "a definir",
        yield: prof.yieldText(profile),
        maturity: profile?.maturity ? formatDateBr(profile.maturity) : DASH,
        tax: profile?.tax ? prof.TAX_LABELS[profile.tax] : DASH,
        today: money(value.value),
        lastBank: observed ? `${formatBrl(observed.valuation.value)} em ${formatDateBr(observed.valuation.on)}` : DASH,
      };
    }
    const code = value.kind === "checking" ? catalogs.irpf.CHECKING : catalogs.irpf.SAVINGS;
    const check = latest.get(value.ref);
    return {
      id: value.ref,
      kind: value.kind,
      label: value.label,
      irpf: catalogs.irpf.assetLabel(code[0], code[1]),
      yield: DASH,
      maturity: DASH,
      tax: DASH,
      today: money(value.value),
      lastBank: check ? `${formatBrl(check.check.informed)} em ${formatDateBr(check.check.on)}` : DASH,
    };
  });
}

/** "Banco X (341), ag. 0001, conta 12345-6 · titular Ana, segundo titular Bruno". */
export function whereLine(ledger: Ledger, item: dom.banking.BankAccount): string {
  const name = (id: Id | null) => (id === null ? "?" : (ledger.members.get(id)?.name ?? "?"));
  return (
    `${banking.where(item)} · titular ${name(item.holder_id)}` +
    (banking.joint(item) ? `, segundo titular ${name(item.co_holder_id)}` : "")
  );
}

// ── bills ────────────────────────────────────────

export const BILL_LABELS: Readonly<Record<dom.cards.BillStatus, string>> = {
  [cards.BillStatus.OPEN]: "Aberta",
  [cards.BillStatus.CLOSED]: "Fechada",
  [cards.BillStatus.PAID]: "Paga",
  [cards.BillStatus.PARTIAL]: "Paga parcialmente",
  [cards.BillStatus.OVERDUE]: "Vencida",
};

export const MONTHS_AROUND = 6;

export interface BillRow {
  /** The bill's month "YYYY-MM". */
  id: string;
  month: YearMonth;
  due: IsoDate;
  closing: IsoDate;
  charges: Dec;
  installments: Dec;
  credits: Dec;
  total: Dec;
  paid: Dec;
  remaining: Dec;
  document: string;
  status: dom.cards.BillStatus;
  statusLabel: string;
}

/** The bills of a card around today: those with movement or a document, oldest first. */
export function billRows(ledger: Ledger, cardId: Id, today: IsoDate): BillRow[] {
  const here = ymOf(today);
  const months: YearMonth[] = [];
  for (let offset = -MONTHS_AROUND; offset <= MONTHS_AROUND; offset++) {
    const total = here.year * 12 + (here.month - 1) + offset;
    months.push({ year: Math.floor(total / 12), month: (total % 12) + 1 });
  }
  const imported = new Map<string, Dec>();
  for (const batch of importing.importStore.batches(ledger).values()) {
    if (batch.card_id === cardId && batch.header.due_on !== null && batch.header.total !== null) {
      imported.set(ymStr(ymOf(batch.header.due_on)), batch.header.total);
    }
  }
  const rows: BillRow[] = [];
  for (const bill of cards.bills(ledger, cardId, months)) {
    const month = bill.cycle.month;
    const documentTotal = imported.get(ymStr(month)) ?? null;
    if (bill.total.isZero() && bill.payments.isZero() && documentTotal === null) continue;
    let document = documentTotal === null ? DASH : formatBrl(documentTotal);
    if (documentTotal !== null && !documentTotal.eq(bill.total)) document += " (diverge)";
    const status = bill.status(today);
    rows.push({
      id: ymStr(month),
      month,
      due: bill.cycle.due,
      closing: bill.cycle.closing,
      charges: bill.charges,
      installments: bill.installments,
      credits: bill.credits,
      total: bill.total,
      paid: bill.payments,
      remaining: bill.remaining,
      document,
      status,
      statusLabel: BILL_LABELS[status],
    });
  }
  return rows;
}

/** The bill to pay without a click: the oldest one that still has a balance. */
export function defaultBill(rows: readonly BillRow[]): BillRow | null {
  return rows.find((r) => r.remaining.isPositive()) ?? rows[0] ?? null;
}

// ── loans ────────────────────────────────────────

export function rateLabel(monthly: Dec): string {
  return `${formatDecimalBr(monthly.mul(100), 4)}% ao mês`;
}

export interface LoanRow {
  id: Id;
  name: string;
  system: string;
  rate: string;
  paid: string;
  next: string;
  outstanding: Dec;
  inLedger: Dec;
}

export function loanRows(ledger: Ledger, today: IsoDate): LoanRow[] {
  return [...loans.plans(ledger).values()]
    .sort((a, b) => a.name.localeCompare(b.name, "pt-BR", { sensitivity: "base" }))
    .map((plan) => {
      const current = loans.status(ledger, plan.id, today);
      const following = current.nextDue;
      return {
        id: plan.id,
        name: plan.name,
        system: (loans.SYSTEM_LABELS[plan.system] ?? plan.system).split(" (")[0] ?? plan.system,
        rate: rateLabel(plan.monthly_rate),
        paid: `${current.paid} de ${current.installments.length}`,
        next: following ? `${formatDateBr(following.due)} · ${formatBrl(following.payment)}` : "quitado",
        outstanding: current.outstanding,
        inLedger: current.ledgerBalance,
      };
    });
}

export interface InstallmentRow {
  /** The installment number as text. */
  id: string;
  number: number;
  due: string;
  payment: Dec;
  amortization: Dec;
  interest: Dec;
  fees: Dec;
  balanceAfter: Dec;
  state: dom.loans.InstallmentState;
  stateLabel: string;
}

export function installmentRows(ledger: Ledger, planId: Id, today: IsoDate): InstallmentRow[] {
  const current = loans.status(ledger, planId, today);
  return current.installments.map((item) => {
    const state = loans.stateOf(ledger, planId, item, today);
    let label = loans.STATE_LABELS[state];
    if (!item.prepaidAfter.isZero()) label += ` · amortização antecipada de ${formatBrl(item.prepaidAfter)}`;
    return {
      id: String(item.number),
      number: item.number,
      due: formatDateBr(item.due),
      payment: item.payment,
      amortization: item.amortization,
      interest: item.interest,
      fees: item.fees,
      balanceAfter: item.balanceAfter,
      state,
      stateLabel: label,
    };
  });
}

/** The installment to show without a click: the first that is not paid. */
export function nextInstallment(rows: readonly InstallmentRow[]): InstallmentRow | null {
  return rows.find((r) => r.state !== loans.InstallmentState.PAID) ?? null;
}

// ── rules ────────────────────────────────────────

export interface RuleRow {
  id: Id;
  pattern: string;
  category: string;
  scope: string;
  uses: number;
  state: string;
  active: boolean;
  contradicted: boolean;
}

export function ruleRows(ledger: Ledger): RuleRow[] {
  const contradicted = importing.learning.contradictions(ledger);
  return [...importing.rules.rules(ledger).values()]
    .sort((a, b) => Number(!a.active) - Number(!b.active) || a.pattern.localeCompare(b.pattern))
    .map((rule) => {
      const target = ledger.accounts.get(rule.target_account_id);
      const scope = rule.account_id ? ledger.accounts.get(rule.account_id) : undefined;
      let state = rule.active ? "Ativa" : "Desativada";
      const found = contradicted.get(rule.id);
      if (found) {
        state += ` · contrariada ${found.contrary} de ${found.matched} vezes`;
        const usual = ledger.accounts.get(found.usual_category_id);
        if (usual) state += ` (vocês escolhem ${usual.name})`;
      }
      return {
        id: rule.id,
        pattern: rule.pattern,
        category: target?.name ?? "?",
        scope: scope?.name ?? "Qualquer conta",
        uses: importing.rules.usage(ledger, rule.id),
        state,
        active: rule.active,
        contradicted: found !== undefined,
      };
    });
}

export const SHOWN_PROPOSALS = 12;

export interface ProposalRow {
  /** "<pattern>\u0000<category>": a proposal is the pair. */
  id: string;
  pattern: string;
  categoryId: Id;
  category: string;
  count: number;
}

export function proposalRows(ledger: Ledger): ProposalRow[] {
  return importing.learning
    .proposals(ledger)
    .slice(0, SHOWN_PROPOSALS)
    .flatMap((p) => {
      const category = ledger.accounts.get(p.category_id);
      return category
        ? [
            {
              id: `${p.pattern}\u0000${p.category_id}`,
              pattern: p.pattern,
              categoryId: p.category_id,
              category: category.name,
              count: p.count,
            },
          ]
        : [];
    });
}
