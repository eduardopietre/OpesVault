/**
 * The reports of Relatórios (desktop `ui/pages/reports_page.py`): which charts exist, which filter each one
 * accepts, how each chart is built from the ledger, what a chosen point says and which operations stand
 * behind it ("Ver lançamentos"). Pure functions of the ledger, so the page and the tests share them.
 *
 * The keys are also what another page puts in `ref` to open a report (`relatorios`, `ref: "<key>"`):
 * in_out, result, cash, projected_balance, categories, comparison, net_worth, composition, projection,
 * merchants, tags, deductibles, annual.
 */
import {
  AccountType,
  Dec,
  ZERO,
  charts,
  dom,
  ymAdd,
  ymFirstDay,
  ymLastDay,
  ymParse,
  type Id,
  type IsoDate,
  type Ledger,
  type YearMonth,
} from "@opesvault/domain";
import { formatBrDate, formatMonth, formatValue, type ChartUnit, type SelectOption } from "@opesvault/ui";
import { encodeRef } from "../../data/links.ts";
import { balanceAccounts, categoryItems } from "../../dialogs/account_choices.ts";

type Chart = charts.data.Chart;
type Point = charts.data.Point;

export const REPORTS = [
  { key: "in_out", label: "Entradas e saídas mensais" },
  { key: "result", label: "Resultado mensal (competência)" },
  { key: "cash", label: "Fluxo de caixa" },
  { key: "projected_balance", label: "Saldo projetado" },
  { key: "categories", label: "Despesas por categoria" },
  { key: "comparison", label: "Comparação com a média" },
  { key: "net_worth", label: "Patrimônio" },
  { key: "composition", label: "Composição da carteira" },
  { key: "projection", label: "Projeção de compromissos" },
  { key: "merchants", label: "Despesas por estabelecimento" },
  { key: "tags", label: "Marcadores" },
  { key: "deductibles", label: "Despesas dedutíveis" },
  { key: "annual", label: "Fechamento do ano" },
] as const;

export type ReportKey = (typeof REPORTS)[number]["key"];

export const REPORT_KEYS: readonly ReportKey[] = REPORTS.map((report) => report.key);

export function isReportKey(value: string | undefined): value is ReportKey {
  return value !== undefined && (REPORT_KEYS as readonly string[]).includes(value);
}

export const HINT = "Clique em um ponto do gráfico ou numa linha da tabela para ver de onde vem o valor.";

/** The filter each report accepts; the others have no defined per-account or per-member reading. */
export type ScopeKind = "account" | "member" | "category" | "window" | "tag" | "year" | "horizon";

export const SCOPES: Readonly<Partial<Record<ReportKey, ScopeKind>>> = {
  in_out: "account",
  cash: "account",
  result: "member",
  categories: "category",
  comparison: "window",
  tags: "tag",
  deductibles: "year",
  annual: "year",
  projected_balance: "horizon",
};

/** Reports that read a range of months (the period filter); the others have their own reference. */
export const MONTHLY: ReadonlySet<ReportKey> = new Set([
  "in_out",
  "result",
  "cash",
  "categories",
  "net_worth",
  "merchants",
]);

export const PERIODS: readonly SelectOption[] = [
  { id: "6", label: "Últimos 6 meses" },
  { id: "12", label: "Últimos 12 meses" },
  { id: "24", label: "Últimos 24 meses" },
];
export const DEFAULT_PERIOD = 12;

/** The "no filter" choice of a filter that narrows by object. */
export const ALL = "__all";

export interface Params {
  /** The shared month: the last month of the range and the reference of the others. */
  end: YearMonth;
  months: number;
  /** The filter chosen (an id, a tag, a year, a count…); null is the report's default. */
  scope: string | null;
  today: IsoDate;
}

export interface ScopeChoices {
  label: string;
  options: SelectOption[];
  /** The option in use while the user has not chosen. */
  fallback: string;
}

/** The filter of a report and its options, or null when the report has none (or nothing to choose from). */
export function scopeChoices(ledger: Ledger, key: ReportKey, end: YearMonth): ScopeChoices | null {
  const kind = SCOPES[key];
  if (kind === undefined) return null;
  if (kind === "window") {
    return {
      label: "Média de comparação",
      fallback: "3",
      options: [3, 6, 12].map((months) => ({ id: String(months), label: `Média de ${months} meses` })),
    };
  }
  if (kind === "horizon") {
    return {
      label: "Horizonte",
      fallback: "60",
      options: [30, 60, 90].map((days) => ({ id: String(days), label: `Próximos ${days} dias` })),
    };
  }
  if (kind === "year") {
    return {
      label: "Ano",
      fallback: String(end.year),
      options: Array.from({ length: 6 }, (_, index) => end.year - index).map((year) => ({
        id: String(year),
        label: `Ano de ${year}`,
      })),
    };
  }
  let all: string;
  let items: SelectOption[];
  if (kind === "account") {
    all = "Todas as contas";
    items = balanceAccounts(ledger);
  } else if (kind === "member") {
    all = "Projeto inteiro";
    items = [...ledger.members.values()].filter((m) => m.active).map((m) => ({ id: m.id, label: m.name }));
  } else if (kind === "category") {
    all = "Todas as categorias";
    items = categoryItems(ledger, AccountType.EXPENSE);
  } else {
    all = "Todos os marcadores";
    items = dom.tags.allTags(ledger).map((t) => ({ id: t, label: t }));
  }
  if (items.length === 0) return null;
  const label = { account: "Conta", member: "Integrante", category: "Categoria", tag: "Marcador" }[kind];
  return { label, fallback: ALL, options: [{ id: ALL, label: all }, ...items] };
}

/** The filter's value, null when it is "all" (or not one of this report's options). */
export function chosenScope(ledger: Ledger, key: ReportKey, params: Params): string | null {
  const choices = scopeChoices(ledger, key, params.end);
  if (!choices) return null;
  const value = params.scope ?? choices.fallback;
  if (!choices.options.some((option) => option.id === value)) return null;
  return value === ALL ? null : value;
}

export const rangeOf = (params: Params): [YearMonth, YearMonth] => [
  ymAdd(params.end, -(params.months - 1)),
  params.end,
];

/** Deductible expenses of the year by category, one series per person (desktop `deductibles_chart`). */
export function deductiblesChart(ledger: Ledger, year: number): Chart {
  const groups = dom.deductibles.annual(ledger, year);
  const people = new Map<Id | null, string>();
  const totals = new Map<string, Dec>();
  const categories = new Map<Id, string>();
  for (const group of groups) {
    const member = group.memberId ? ledger.members.get(group.memberId) : undefined;
    people.set(group.memberId, member ? member.name : "Sem integrante");
    for (const line of group.lines) {
      const name = ledger.account(line.categoryId).name;
      const kind = dom.deductibles.KIND_LABELS[group.kind];
      categories.set(line.categoryId, name === kind ? name : `${name} (${kind})`);
      const key = `${line.categoryId}|${group.memberId ?? ""}`;
      totals.set(key, (totals.get(key) ?? ZERO).add(line.amount));
    }
  }
  const series = [...people].map(([memberId, name]) =>
    charts.data.series(
      name,
      [...categories].map(([categoryId, label]) =>
        charts.data.point(label, totals.get(`${categoryId}|${memberId ?? ""}`) ?? ZERO, { _categoria: categoryId }),
      ),
    ),
  );
  return charts.data.chart(`Despesas dedutíveis de ${year}`, "BRL", series, ["Por pessoa; pagamentos do ano."]);
}

/** The chart of a report with its filters. */
export function buildChart(ledger: Ledger, key: ReportKey, params: Params): Chart {
  const [start, end] = rangeOf(params);
  const chosen = chosenScope(ledger, key, params);
  switch (key) {
    case "in_out":
      return charts.data.monthlyInOut(ledger, start, end, chosen ? [chosen] : null);
    case "result":
      return charts.data.monthlyResult(ledger, start, end, chosen);
    case "cash":
      return charts.data.cashFlowBalance(ledger, start, end, chosen ? [chosen] : null);
    case "projected_balance":
      return charts.data.projectedBalance(ledger, params.today, Number(chosen ?? 60));
    case "categories":
      return chosen
        ? charts.data.categoryMonthly(ledger, chosen, start, end)
        : charts.data.expensesByCategory(ledger, start, end);
    case "comparison":
      return charts.data.categoryComparisonChart(ledger, params.end, Number(chosen ?? 3));
    case "net_worth":
      return charts.data.netWorthSeries(ledger, start, end);
    case "composition":
      return charts.data.portfolioComposition(ledger, params.today);
    case "tags":
      return chosen ? charts.data.tagChart(ledger, chosen) : charts.data.tagsOverview(ledger);
    case "deductibles":
      return deductiblesChart(ledger, Number(chosen ?? params.end.year));
    case "annual":
      return charts.data.annualChart(ledger, Number(chosen ?? params.end.year));
    case "merchants":
      return charts.data.merchantsChart(ledger, ymFirstDay(start), ymLastDay(end));
    case "projection":
      return charts.data.commitmentsProjection(ledger, params.end, 12);
  }
}

/** The line under the title: the period or the reference of the report. */
export function subtitle(key: ReportKey, params: Params): string {
  if (MONTHLY.has(key)) {
    const [start, end] = rangeOf(params);
    return `De ${formatMonth(start)} a ${formatMonth(end)}`;
  }
  switch (key) {
    case "comparison": {
      const text = formatMonth(params.end);
      return `${text.charAt(0).toUpperCase()}${text.slice(1)} comparado aos meses anteriores`;
    }
    case "projected_balance":
      return "A partir de hoje, com o que já está registrado";
    case "projection":
      return `Doze meses a partir de ${formatMonth(params.end)}`;
    case "deductibles":
      return dom.deductibles.NOTICE;
    case "annual":
      return dom.annual.NOTICE;
    default:
      return "";
  }
}

/** A chart with nothing to draw (no point, or every value unknown or zero): an empty project, or no data for the filter. */
export function isEmpty(chart: Chart): boolean {
  return chart.series.every((series) => series.points.every((p) => p.y === null || p.y.isZero()));
}

const MONTH = /^(\d{4})-(0[1-9]|1[0-2])$/;

/** What the table calls its first column: dates, months or items. */
export function firstColumnTitle(chart: Chart): string {
  const [, rows] = charts.data.tableRows(chart);
  const xs = rows.filter((row) => row.x !== null);
  if (xs.length > 0 && xs.every((row) => row.isDate)) return "Data";
  if (xs.length > 0 && xs.every((row) => !row.isDate && MONTH.test(row.x as string))) return "Mês";
  return "Item";
}

/** The x of the category at this position of the chart (rows of the domain's table, summaries left out). */
export function xAt(chart: Chart, index: number): { x: string; isDate: boolean } | null {
  const [, rows] = charts.data.tableRows(chart);
  const row = rows.filter((r) => r.x !== null)[index];
  return row ? { x: row.x as string, isDate: row.isDate } : null;
}

/** How an x reads: "01/03/2026", "mar/2026" or the item itself. */
export function xLabel(x: string, isDate: boolean): string {
  if (isDate) return formatBrDate(x);
  return MONTH.test(x) ? charts.data.monthName(ymParse(x)) : x;
}

const unitOf = (chart: Chart, series: charts.data.Series): ChartUnit =>
  series.axis === "right" || chart.unit === "BRL" ? "money" : chart.unit === "%" ? "percent" : "number";

export interface Inspected {
  /** The title of the point ("mar/2026", "Alimentação"). */
  title: string;
  /** One line per drawn series: "Entradas: R$ 1.000,00". */
  values: string[];
  /** Regime and the point's own details (internal keys, which start with "_", left out). */
  details: string[];
}

/** What a chosen point says (desktop `tooltip_text`), for every drawn series that has it. */
export function inspect(chart: Chart, index: number): Inspected | null {
  const at = xAt(chart, index);
  if (!at) return null;
  const points = chart.series
    .filter((series) => !series.hidden)
    .flatMap((series) => {
      const found = series.points.find((p) => p.x === at.x && p.isDate === at.isDate);
      return found ? [{ series, point: found }] : [];
    });
  const first = points[0]?.point;
  return {
    title: xLabel(at.x, at.isDate),
    values: points.map(
      ({ series, point }) => `${series.name}: ${formatValue(point.y?.toFixed() ?? null, unitOf(chart, series))}`,
    ),
    // the regime is also in the points' own details of most charts: said once
    details: [
      ...new Set([
        ...(chart.regime ? [`regime: ${chart.regime}`] : []),
        ...Object.entries(first?.info ?? {})
          .filter(([name]) => !name.startsWith("_"))
          .map(([name, value]) => `${name}: ${value}`),
      ]),
    ],
  };
}

const expenseByName = (ledger: Ledger, name: string): Id | null =>
  ledger.categories(AccountType.EXPENSE).find((category) => category.name === name)?.id ?? null;

/** The point of the chart at `x`, from the first series that has it. */
function pointAt(chart: Chart, at: { x: string; isDate: boolean }): Point | undefined {
  for (const series of chart.series) {
    const found = series.points.find((p) => p.x === at.x && p.isDate === at.isDate);
    if (found) return found;
  }
  return undefined;
}

/**
 * The Livro's `ref` for the operations behind a point, when the report is made of operations (desktop
 * `_ledger_ref`): a tag, a deductible category in the year, a category in the month, an account or the
 * project in a month, a member's month, or one category over the whole range.
 */
export function ledgerRef(ledger: Ledger, key: ReportKey, chart: Chart, index: number, params: Params): string | null {
  const at = xAt(chart, index);
  if (!at) return null;
  const chosen = chosenScope(ledger, key, params);
  const point = pointAt(chart, at);
  if (key === "tags") {
    const tag = chosen ?? at.x;
    return tag ? `marcador:${tag}` : null;
  }
  if (key === "deductibles") {
    const category = point?.info["_categoria"];
    const year = Number(chosen ?? params.end.year);
    return category ? (encodeRef(["filter", category, [`${year}-01-01`, `${year}-12-31`]]) ?? null) : null;
  }
  if (key === "comparison") {
    const account = expenseByName(ledger, at.x);
    return account ? (encodeRef(["filter", account, params.end]) ?? null) : null;
  }
  if (key !== "in_out" && key !== "result" && key !== "cash" && key !== "categories") return null;
  if (key === "categories" && chosen === null) {
    // One bar per category over the whole range: that category, the whole period.
    const account = expenseByName(ledger, at.x);
    const [start, end] = rangeOf(params);
    return account ? (encodeRef(["filter", account, [ymFirstDay(start), ymLastDay(end)]]) ?? null) : null;
  }
  if (at.isDate || !MONTH.test(at.x)) return null;
  const month = ymParse(at.x);
  const account = key === "result" ? null : chosen;
  const member = key === "result" ? chosen : null;
  return encodeRef(["filter", account, month, member]) ?? null;
}

/** The table of values as CSV (';', decimals with '.', months as AAAA-MM), like the Livro's export. */
export function valuesCsv(chart: Chart): string {
  const [headers, rows] = charts.data.tableRows(chart);
  const field = (value: string) => (/[;"\n\r]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value);
  const lines = [
    ["item", ...headers],
    ...rows.map((row) => [row.x ?? row.label, ...row.values.map((value) => (value === null ? "" : value.toFixed()))]),
  ];
  return String.fromCharCode(0xfeff) + lines.map((line) => line.map(field).join(";")).join("\n") + "\n";
}

export const csvFileName = (key: ReportKey) => `valores-${key}.csv`;
