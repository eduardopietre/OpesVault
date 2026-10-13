/**
 * Tabela completa de Investimentos: every open investment and every savings account in one table, to read on
 * screen, print (`/imprimir/investimentos`) or save as CSV. Where each is held (bank account, bank, branch,
 * number), what it is, its dates, what was put in, its last value and when, its income in money and in %, and the
 * same income as a rate per year and per month. The rates come from the internal rate of return from the start to
 * the last value (money-weighted, days/365), solved in a worker one investment at a time; a savings account has
 * none (it follows Livro). Unknown is never zero: it shows as a dash.
 */
import {
  Dec,
  dom,
  exporting,
  formatDateBr,
  formatDecimalBr,
  investments,
  type Id,
  type IsoDate,
  type Ledger,
} from "@opesvault/domain";
import { csvRow } from "../../data/csv.ts";
import { DASH } from "../../data/money.ts";
import type { ReportCell, ReportTable } from "../visao-geral/report.ts";
import { heldAt } from "./rows.ts";
import { planXirr, type XirrPlan } from "./xirr.ts";

const { service, performance, profile: prof, returns, savings, model } = investments;

export interface FullRow {
  id: Id;
  savings: boolean;
  /** The bank account (how the project calls it), its bank, branch and number; a dash when not said. */
  account: string;
  bank: string;
  branch: string;
  number: string;
  name: string;
  /** The app's class ("Renda fixa", "Ações"); the IRPF type is too long for a table of this width. */
  kind: string;
  applied: IsoDate | null;
  maturity: IsoDate | null;
  /** The contracted yield ("110% do CDI"), from the characteristics. */
  contracted: string;
  invested: Dec | null;
  value: Dec | null;
  valueOn: IsoDate | null;
  /** Last value less what was put in. */
  income: Dec | null;
  /** `income` over `invested`. */
  incomeRatio: Dec | null;
  /** What the yearly rate is solved from; null when there is nothing to solve (a savings account). */
  xirr: XirrPlan | null;
}

/** The yearly rate of each row, by id, as the worker answers (null: not computable). */
export type Rates = ReadonlyMap<Id, Dec | null>;

const ratio = (part: Dec | null, whole: Dec | null): Dec | null =>
  part === null || whole === null || !whole.isPositive() ? null : part.div(whole);

/** The rows, by bank account and then by name. */
export function fullRows(ledger: Ledger, today: IsoDate): FullRow[] {
  const out: FullRow[] = [];
  const assets = service.assets(ledger);
  for (const pos of service.positions(ledger).values()) {
    if (pos.closed) continue;
    const asset = assets.get(pos.asset_id)!;
    const bank = heldAt(ledger, pos.id);
    const profile = prof.profileOf(ledger, pos.id);
    const observed = performance.valueAt(ledger, pos.id, today);
    const invested = pos.cost_known ? service.remainingCost(ledger, pos.id) : null;
    const income = performance.unrealized(ledger, pos.id, today).value;
    const end = observed?.valuation.on ?? null;
    out.push({
      id: pos.id,
      savings: false,
      account: bank?.name ?? DASH,
      bank: bank?.bank_name ?? DASH,
      branch: bank?.branch ?? DASH,
      number: bank?.number ?? DASH,
      name: asset.name,
      kind: model.ASSET_CLASS_LABELS[asset.asset_class],
      applied: pos.opened_on,
      maturity: profile?.maturity ?? null,
      contracted: prof.yieldText(profile),
      invested,
      value: observed?.valuation.value ?? null,
      valueOn: end,
      income,
      incomeRatio: ratio(income, invested),
      xirr: end !== null && end > pos.opened_on ? planXirr(ledger, pos.id, pos.opened_on, end) : null,
    });
  }
  const banks = [...dom.banking.bankAccounts(ledger).values()];
  for (const account of savings.savingsAccounts(ledger)) {
    const f = savings.savingsFigures(ledger, account.id, today);
    const bank = banks.find((b) => b.savings_id === account.id);
    out.push({
      id: account.id,
      savings: true,
      account: bank?.name ?? account.name,
      bank: bank?.bank_name ?? account.institution ?? DASH,
      branch: bank?.branch ?? DASH,
      number: bank?.number ?? DASH,
      name: "Poupança",
      kind: "Poupança",
      applied: null,
      maturity: null,
      contracted: "Rendimento da poupança",
      invested: f.invested,
      value: f.value,
      valueOn: today,
      income: f.income,
      incomeRatio: ratio(f.income, f.invested),
      xirr: null,
    });
  }
  return out.sort((a, b) => a.account.localeCompare(b.account, "pt-BR") || a.name.localeCompare(b.name, "pt-BR"));
}

export const HEADERS = [
  "Conta",
  "Banco",
  "Agência",
  "Número",
  "Investimento",
  "Classe",
  "Aplicação",
  "Vencimento",
  "Rentabilidade contratada",
  "Total investido",
  "Último valor",
  "Data do último valor",
  "Rendimento",
  "Rendimento (%)",
  "Equivalente ao ano",
  "Equivalente ao mês",
] as const;

/** Money and percentage columns (aligned to the end). */
const NUMERIC = [9, 10, 12, 13, 14, 15];

const pct = (value: Dec | null): string => (value === null ? DASH : `${formatDecimalBr(value.mul(100), 2)}%`);
const date = (value: IsoDate | null): string => (value === null ? DASH : formatDateBr(value));

/** The yearly rate and its monthly equivalent of a row: "calculando…" until the worker answers. */
function rates(row: FullRow, solved: Rates): [string, string] {
  if (row.xirr === null) return [DASH, DASH];
  if (!solved.has(row.id)) return ["calculando…", "calculando…"];
  const yearly = solved.get(row.id) ?? null;
  return [
    pct(yearly),
    pct(yearly === null ? null : returns.equivalentRate(yearly, returns.YEAR_DAYS, returns.MONTH_DAYS)),
  ];
}

/** The total of a money column over the rows that know it; null when none does. */
function total(rows: readonly FullRow[], pick: (row: FullRow) => Dec | null): Dec | null {
  const known = rows.map(pick).filter((v): v is Dec => v !== null);
  return known.length ? Dec.sum(known, Dec.from(0)) : null;
}

export interface Totals {
  invested: Dec | null;
  value: Dec | null;
  income: Dec | null;
}

export function totals(rows: readonly FullRow[]): Totals {
  return {
    invested: total(rows, (r) => r.invested),
    value: total(rows, (r) => r.value),
    income: total(rows, (r) => r.income),
  };
}

/** The table as the print sheet draws it, with a last line of totals. */
export function fullTable(rows: readonly FullRow[], solved: Rates): ReportTable {
  const body: ReportCell[][] = rows.map((row) => {
    const [yearly, monthly] = rates(row, solved);
    return [
      row.account,
      row.bank,
      row.branch,
      row.number,
      row.name,
      row.kind,
      date(row.applied),
      date(row.maturity),
      row.contracted,
      row.invested,
      row.value,
      date(row.valueOn),
      row.income,
      pct(row.incomeRatio),
      yearly,
      monthly,
    ];
  });
  const sum = totals(rows);
  body.push([
    "Total",
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    sum.invested,
    sum.value,
    "",
    sum.income,
    pct(ratio(sum.income, sum.invested)),
    "",
    "",
  ]);
  return { id: "investments", title: "", headers: HEADERS, numeric: NUMERIC, rows: body };
}

/**
 * The same table as CSV (';', decimals with '.', dates as AAAA-MM-DD, rates as fractions), like the Livro's
 * export; free text neutralized against spreadsheet formulas (docs/19 achado 12).
 */
export function fullCsv(rows: readonly FullRow[], solved: Rates): string {
  const text = (value: string) => exporting.spreadsheetText(value === DASH ? "" : value);
  const number = (value: Dec | null) => (value === null ? "" : value.toFixed());
  const lines = rows.map((row) => {
    const yearly = row.xirr !== null ? (solved.get(row.id) ?? null) : null;
    const monthly = yearly === null ? null : returns.equivalentRate(yearly, returns.YEAR_DAYS, returns.MONTH_DAYS);
    return [
      text(row.account),
      text(row.bank),
      text(row.branch),
      text(row.number),
      text(row.name),
      text(row.kind),
      row.applied ?? "",
      row.maturity ?? "",
      text(row.contracted),
      number(row.invested),
      number(row.value),
      row.valueOn ?? "",
      number(row.income),
      number(row.incomeRatio),
      number(yearly),
      number(monthly),
    ];
  });
  return String.fromCharCode(0xfeff) + [[...HEADERS], ...lines].map(csvRow).join("");
}
