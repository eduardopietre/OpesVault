/**
 * The year-end closing as data: the same sections and figures as the domain's `exporting.annualReportHtml`
 * (assets and debts on 31/12, income by category, investments, deductible expenses by person), so the print
 * view can draw them with React instead of injecting HTML. A test compares the two section by section.
 */
import {
  AccountType,
  cashDate,
  dom,
  exporting,
  formatDateBr,
  sortedBy,
  type Dec,
  type Ledger,
} from "@opesvault/domain";
import type { ReportTable } from "../visao-geral/report.ts";

export interface DeductibleGroupData {
  /** "Saúde — Ana", the bold line above the table. */
  title: string;
  total: Dec;
  table: ReportTable;
}

export interface AnnualReportData {
  project: string;
  year: number;
  /** The file leaves the project's protection. */
  warning: string;
  /** What the report is and is not. */
  notice: string;
  balances: ReportTable;
  netWorth: Dec;
  income: ReportTable;
  investments: ReportTable;
  /** Redemptions left out of the gains, in words; null when none. */
  incomplete: string | null;
  deductibleNotice: string;
  deductibles: readonly DeductibleGroupData[];
}

export function annualReportData(ledger: Ledger, year: number): AnnualReportData {
  const summary = dom.annual.annual(ledger, year);
  const balances: ReportTable = {
    id: "bens",
    title: `Bens e dívidas em 31/12/${year}`,
    headers: ["Conta", "Tipo", `31/12/${year - 1}`, `31/12/${year}`],
    numeric: [2, 3],
    rows: summary.balances.map((b) => [
      b.name,
      b.kind === AccountType.ASSET ? "Bem" : "Dívida",
      b.previousYearEnd,
      b.yearEnd,
    ]),
  };
  const income: ReportTable = {
    id: "receitas",
    title: "Receitas do ano por categoria",
    headers: ["Categoria", "Valor"],
    numeric: [1],
    rows: sortedBy([...summary.income], ([, value]) => value.negate()).map(([id, value]) => [
      ledger.account(id).name,
      value,
    ]),
  };
  const investments: ReportTable = {
    id: "investimentos",
    title: "Investimentos",
    headers: ["", "Valor"],
    numeric: [1],
    rows: [
      ["Proventos recebidos", summary.investmentIncome],
      ["Imposto retido na fonte", summary.taxWithheld],
      ["Ganhos realizados (resgates e vendas)", summary.realizedGains],
    ],
  };
  const deductibles = dom.deductibles.annual(ledger, year).map((group): DeductibleGroupData => {
    const member = group.memberId ? ledger.members.get(group.memberId) : undefined;
    return {
      title: `${dom.deductibles.KIND_LABELS[group.kind]} — ${member ? member.name : "Sem integrante"}`,
      total: group.total,
      table: {
        id: `dedutiveis-${group.kind}-${group.memberId ?? ""}`,
        title: "",
        headers: ["Data", "Descrição", "Valor"],
        numeric: [2],
        rows: group.lines.map((line) => {
          const when = cashDate(line.operation) ?? line.operation.occurred_on;
          return [when ? formatDateBr(when) : "—", line.operation.description, line.amount];
        }),
      },
    };
  });
  return {
    project: ledger.meta.family_name || "Projeto",
    year,
    warning: exporting.WARNING,
    notice: dom.annual.NOTICE,
    balances,
    netWorth: summary.netWorth,
    income,
    investments,
    incomplete: summary.incompleteEvents
      ? `${summary.incompleteEvents} resgate(s) sem valor bruto ou custo ficaram fora dos ganhos.`
      : null,
    deductibleNotice: dom.deductibles.NOTICE,
    deductibles,
  };
}

/** The same report as the domain's HTML file (for the download). */
export function annualReportFile(ledger: Ledger, year: number): string {
  return exporting.annualReportHtml(ledger, year);
}

/** File name of the report ("fechamento-2026.html"). */
export const annualFileName = (year: number, extension: string) => `fechamento-${year}.${extension}`;
