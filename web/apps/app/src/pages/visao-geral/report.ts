/**
 * The month for the family conversation as data: the same sections and figures as the domain's
 * `exporting.monthlyReportHtml` (summary, comparison, categories against the plan, due dates, indicators,
 * pending), so the print view can draw them with React instead of injecting HTML. A test compares the two.
 */
import {
  dom,
  exporting,
  formatBrl,
  formatDateBr,
  formatFixed,
  queries,
  sortedBy,
  ymLastDay,
  ymStr,
  type Dec,
  type Id,
  type IsoDate,
  type Ledger,
  type YearMonth,
} from "@opesvault/domain";
import { formatMonth } from "@opesvault/ui";

/** A table cell: a decimal is money, text is as is, null is a dash. */
export type ReportCell = Dec | string | null;

export interface ReportTable {
  id: string;
  title: string;
  headers: readonly string[];
  /** Columns aligned to the end (numbers). */
  numeric: readonly number[];
  rows: readonly (readonly ReportCell[])[];
}

export interface MonthlyReportData {
  project: string;
  /** "outubro de 2026" */
  monthTitle: string;
  /** The member whose view this is; null for the whole project. */
  member: string | null;
  /** The file leaves the project's protection. */
  warning: string;
  tables: readonly ReportTable[];
  pending: readonly string[];
}

/** Money as the report prints it. */
export function cellText(cell: ReportCell): string {
  if (cell === null) return "—";
  return typeof cell === "string" ? cell : formatBrl(cell);
}

export function monthlyReportData(
  ledger: Ledger,
  month: YearMonth,
  today: IsoDate,
  memberId: Id | null = null,
): MonthlyReportData {
  const flow = queries.cashFlow(ledger, month, month).get(ymStr(month));
  const statement = queries.incomeStatement(ledger, month, memberId);
  const worth = queries.netWorth(ledger, ymLastDay(month));
  const member = memberId ? ledger.members.get(memberId) : undefined;
  const summary: ReportTable = {
    id: "resumo",
    title: "Resumo",
    headers: ["", "Valor"],
    numeric: [1],
    rows: [
      ["Entradas (caixa)", flow?.inflow ?? null],
      ["Saídas (caixa)", flow?.outflow ?? null],
      ["Receitas (competência)", statement.totalIncome],
      ["Despesas (competência)", statement.totalExpense],
      ["Resultado", statement.result],
      ["Patrimônio líquido no fim do mês", worth.net],
    ],
  };
  const comparison: ReportTable = {
    id: "comparacao",
    title: "Comparado aos meses anteriores",
    headers: ["", "Este mês", "Média de 3 meses", "Um ano antes"],
    numeric: [1, 2, 3],
    rows: dom.comparisons.totalsComparison(ledger, month).map((c) => [c.name, c.current, c.average, c.lastYear]),
  };
  const status = dom.budget.status(ledger, month);
  const plan = new Map(status.rows.map((r) => [r.categoryId, r]));
  const categories: ReportTable = {
    id: "categorias",
    title: "Despesas por categoria",
    headers: ["Categoria", "Realizado", "Planejado"],
    numeric: [1, 2],
    rows: sortedBy([...statement.expense], ([, value]) => value, true).map(([categoryId, value]) => [
      ledger.account(categoryId).name,
      value,
      plan.get(categoryId)?.planned ?? null,
    ]),
  };
  const due: ReportTable = {
    id: "vencimentos",
    title: "Vencimentos do mês",
    headers: ["Data", "Descrição", "Valor", "Situação"],
    numeric: [2],
    rows: dom.agenda
      .monthEvents(ledger, month, today)
      .map((e) => [formatDateBr(e.on), e.title, e.amount.abs(), dom.agenda.STATE_LABELS[e.state]]),
  };
  const indicators: ReportTable = {
    id: "indicadores",
    title: "Indicadores",
    headers: ["Indicador", "Valor", "Como é calculado"],
    numeric: [1],
    rows: dom.indicators
      .indicators(ledger, month)
      .map((i) => [
        i.label,
        i.value === null
          ? "—"
          : i.unit === "%"
            ? `${formatFixed(i.value.mul(100), 0)}%`
            : `${i.value.toString()} meses`.replaceAll(".", ","),
        i.detail,
      ]),
  };
  return {
    project: ledger.meta.family_name || "Projeto",
    monthTitle: formatMonth(month),
    member: member?.name ?? null,
    warning: exporting.WARNING,
    tables: [summary, comparison, categories, due, indicators],
    pending: dom.periods.pendingItems(ledger, month),
  };
}

/** The same report as the domain's HTML file (for the download). */
export function monthlyReportFile(ledger: Ledger, month: YearMonth, today: IsoDate, memberId: Id | null): string {
  return exporting.monthlyReportHtml(ledger, month, today, memberId);
}

/** File name of the report ("resumo-2026-10.html"). */
export function reportFileName(month: YearMonth, extension: string): string {
  return `resumo-${ymStr(month)}.${extension}`;
}
