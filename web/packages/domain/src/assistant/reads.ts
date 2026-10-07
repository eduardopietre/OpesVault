/**
 * Read tools: what the assistant may look up. They never change the ledger. Port of `assistant/reads.py`.
 *
 * They return plain data (money and dates as text) with at most `MAX_ROWS` rows and the total, so a
 * long history does not overflow the model's context. Personal tax data (CPF, CNPJ) is not
 * reachable from here.
 */
import * as budget from "../domain/budget.ts";
import { type Ledger } from "../domain/ledger.ts";
import * as merchants from "../domain/merchants.ts";
import { AccountSubtype, AccountType, cashDate, competence, isActive, type Operation } from "../domain/model.ts";
import { ZERO } from "../domain/money.ts";
import * as queries from "../domain/queries.ts";
import { findOperations, operationFilter, StatusFilter } from "../domain/search.ts";
import * as tags from "../domain/tags.ts";
import { type IsoDate, formatDateBr, ymFirstDay, ymLastDay, ymLt, ymOf, ymStr, type YearMonth } from "../lib/dates.ts";
import { Dec } from "../lib/dec.ts";
import type { Id } from "../lib/ids.ts";
import { items as importItems } from "../importing/store.ts";
import { ItemStatus } from "../importing/model.ts";
import * as rules from "../importing/rules.ts";
import { sortedBy } from "../lib/text.ts";
import {
  type ArgSpec,
  type Args,
  MAX_ROWS,
  money,
  month,
  day,
  accountLabel,
  findAccount,
  findMember,
  findOperation,
  optionalText,
  Registry,
  shortId,
  text,
  type ToolContext,
  ToolError,
  ToolKind,
  type Tool,
  type Field,
} from "./tools.ts";

const NO_ARGS: ArgSpec = [];
const MONTH_ARGS: ArgSpec = [["month", optionalText("Mês AAAA-MM; sem ele, o mês do lançamento mais recente")]];
const PERIOD_ARGS: ArgSpec = [
  ["start", text("Primeiro mês, AAAA-MM")],
  ["end", optionalText("Último mês, AAAA-MM; sem ele, o mesmo do início")],
];
const CATEGORIES_ARGS: ArgSpec = [
  [
    "kind",
    { kind: "literal", description: "Tipo de categoria", values: ["despesa", "receita", "todas"], default: "todas" },
  ],
];
const SEARCH_ARGS: ArgSpec = [
  ["text", optionalText("Trecho da descrição ou das observações")],
  ["start", optionalText("Data inicial AAAA-MM-DD")],
  ["end", optionalText("Data final AAAA-MM-DD")],
  ["account", optionalText("Nome de uma conta, cartão ou categoria")],
  ["member", optionalText("Nome de um integrante")],
  ["tag", optionalText("Marcador")],
  ["min_amount", optionalText("Valor mínimo, ex.: 100.00")],
  ["max_amount", optionalText("Valor máximo, ex.: 500.00")],
  [
    "status",
    { kind: "literal", description: "", values: ["ativos", "cancelados", "todos"], default: "ativos" } as Field,
  ],
  ["limit", { kind: "int", description: `Quantos devolver (até ${MAX_ROWS})`, default: 20, ge: 1, le: MAX_ROWS }],
];
const OPERATION_ARGS: ArgSpec = [["id", text("O 'id' de um lançamento, devolvido por search_operations")]];
const LIMIT_ARGS: ArgSpec = [["limit", { kind: "int", description: "", default: 20, ge: 1, le: MAX_ROWS }]];
const SHOW_ARGS: ArgSpec = [
  ["account", optionalText("Conta, cartão ou categoria a filtrar")],
  ["tag", optionalText("Marcador a filtrar")],
  ["start", optionalText("Data inicial AAAA-MM-DD")],
  ["end", optionalText("Data final AAAA-MM-DD")],
];

const str = (v: unknown) => v as string | null;

function latestMonth(ledger: Ledger, today: IsoDate): YearMonth {
  let latest: IsoDate | null = null;
  for (const op of ledger.activeOperations()) {
    const d = op.occurred_on ?? cashDate(op);
    if (d !== null && (latest === null || d > latest)) latest = d;
  }
  return ymOf(latest ?? today);
}

function monthOrLatest(ledger: Ledger, input: string | null, today: IsoDate): YearMonth {
  return month(input) ?? latestMonth(ledger, today);
}

/** The operation's size: what moved into categories, or else the largest posting. */
export function amountOf(ledger: Ledger, op: Operation): Dec {
  const categories = op.postings
    .filter((p) => {
      const a = ledger.account(p.account_id);
      return a.subtype === AccountSubtype.CATEGORY && a.type === AccountType.EXPENSE;
    })
    .map((p) => p.amount);
  if (categories.length) return Dec.sum(categories, ZERO);
  const income = queries.postingsOfType(ledger, op, AccountType.INCOME).map((p) => p.amount.negate());
  if (income.length) return Dec.sum(income, ZERO);
  let best: Dec = ZERO;
  let first = true;
  for (const p of op.postings) {
    const v = p.amount.abs();
    if (first || v.gt(best)) best = v;
    first = false;
  }
  return best;
}

function operationRow(ledger: Ledger, op: Operation): Record<string, unknown> {
  const sources = op.postings
    .filter((p) => p.amount.isNegative())
    .map((p) => accountLabel(ledger, ledger.account(p.account_id)));
  const targets = op.postings
    .filter((p) => p.amount.isPositive())
    .map((p) => accountLabel(ledger, ledger.account(p.account_id)));
  const row: Record<string, unknown> = {
    id: shortId(op.id),
    data: op.occurred_on ?? cashDate(op),
    descricao: op.description,
    valor: amountOf(ledger, op),
    de: sources.join(", "),
    para: targets.join(", "),
  };
  if (!isActive(op)) row["cancelado"] = true;
  const found = tags.tagsOf(ledger, op.id);
  if (found.length) row["marcadores"] = [...found];
  return row;
}

// ── tools ───────────────────────────────────────────

function pendingItems(ledger: Ledger) {
  return [...importItems(ledger).values()].filter(
    (i) => i.status === ItemStatus.READY || i.status === ItemStatus.NEEDS_REVIEW,
  );
}

function getOverview(ledger: Ledger, args: Args, ctx: ToolContext): Record<string, unknown> {
  const current = monthOrLatest(ledger, str(args["month"]), ctx.today);
  const statement = queries.incomeStatement(ledger, current);
  const worth = queries.netWorth(ledger);
  return {
    projeto: ledger.meta.family_name,
    mes: ymStr(current),
    receitas_do_mes: statement.totalIncome,
    despesas_do_mes: statement.totalExpense,
    resultado_do_mes: statement.result,
    patrimonio_liquido: worth.net,
    lancamentos: ledger.operations.size,
    itens_importados_pendentes: pendingItems(ledger).length,
    integrantes: [...ledger.members.values()].filter((m) => m.active).map((m) => m.name),
  };
}

function listAccounts(ledger: Ledger): Record<string, unknown> {
  const balances = queries.balances(ledger);
  const rows: unknown[] = [];
  for (const account of sortedBy([...ledger.accounts.values()], (a) => [a.type, a.name])) {
    if (account.subtype === AccountSubtype.CATEGORY || account.type === AccountType.EQUITY || account.archived)
      continue;
    rows.push({ nome: account.name, tipo: account.subtype, saldo: balances.get(account.id) ?? ZERO });
  }
  return { contas: rows };
}

function listCategories(ledger: Ledger, args: Args): Record<string, unknown> {
  const kinds: Record<string, AccountType[]> = {
    despesa: [AccountType.EXPENSE],
    receita: [AccountType.INCOME],
    todas: [AccountType.EXPENSE, AccountType.INCOME],
  };
  const out: Record<string, string[]> = {};
  for (const kind of kinds[args["kind"] as string]!) {
    const label = kind === AccountType.EXPENSE ? "despesa" : "receita";
    out[label] = sortedBy(
      ledger.categories(kind).map((a) => accountLabel(ledger, a)),
      (s) => s,
    );
  }
  return out;
}

function listMembers(ledger: Ledger): Record<string, unknown> {
  return {
    integrantes: [...ledger.members.values()].filter((m) => m.active).map((m) => ({ nome: m.name, papel: m.role })),
  };
}

function searchOperations(ledger: Ledger, args: Args): Record<string, unknown> {
  const accountId: Id | null = str(args["account"]) ? findAccount(ledger, str(args["account"])!).id : null;
  const memberId = str(args["member"]) ? findMember(ledger, str(args["member"])!) : null;
  let restrict: ReadonlySet<Id> | null = null;
  if (str(args["tag"])) restrict = new Set(tags.operationsWith(ledger, str(args["tag"])!));
  const low = str(args["min_amount"]) ? money(args["min_amount"], "valor mínimo") : null;
  const high = str(args["max_amount"]) ? money(args["max_amount"], "valor máximo") : null;
  const status: Record<string, StatusFilter> = {
    ativos: StatusFilter.ACTIVE,
    cancelados: StatusFilter.CANCELLED,
    todos: StatusFilter.ALL,
  };
  const flt = operationFilter({
    start: day(str(args["start"]), "data inicial"),
    end: day(str(args["end"]), "data final"),
    account_id: accountId,
    member_id: memberId,
    text: str(args["text"]) || "",
    status: status[args["status"] as string]!,
    operation_ids: restrict,
  });
  let found = findOperations(ledger, flt);
  if (low !== null || high !== null) {
    found = found.filter((op) => {
      const size = amountOf(ledger, op);
      return (low === null || size.gte(low)) && (high === null || size.lte(high));
    });
  }
  const rows = found.slice(0, args["limit"] as number).map((op) => operationRow(ledger, op));
  return { total: found.length, mostrando: rows.length, lancamentos: rows };
}

function getOperation(ledger: Ledger, args: Args): Record<string, unknown> {
  const op = findOperation(ledger, args["id"] as string);
  const row = operationRow(ledger, op);
  row["partidas"] = op.postings.map((p) => ({
    conta: accountLabel(ledger, ledger.account(p.account_id)),
    valor: p.amount,
  }));
  row["estabelecimento"] = merchants.merchantOf(ledger, op.description);
  const when = competence(op);
  row["competencia"] = when === null ? null : ymStr(when);
  if (op.notes) row["observacoes"] = op.notes;
  row["versoes"] = ledger.historyOf(op.id).length;
  return row;
}

function spendingByCategory(ledger: Ledger, args: Args): Record<string, unknown> {
  const start = month(args["start"] as string, "mês inicial");
  const end = month(str(args["end"]), "mês final") ?? start;
  if (start === null || end === null) throw new ToolError("Informe o mês inicial, AAAA-MM.");
  if (ymLt(end, start)) throw new ToolError("O mês final vem antes do inicial.");
  const totals = queries.expensesByCategory(ledger, start, end);
  const rows = sortedBy(
    [...totals]
      .filter(([, v]) => !v.isZero())
      .map(([k, v]) => ({ categoria: accountLabel(ledger, ledger.account(k)), total: v })),
    (r) => r.total,
    true,
  );
  return {
    de: ymStr(start),
    ate: ymStr(end),
    total: Dec.sum(
      rows.map((r) => r.total),
      ZERO,
    ),
    categorias: rows.slice(0, MAX_ROWS),
  };
}

function monthSummary(ledger: Ledger, args: Args, ctx: ToolContext): Record<string, unknown> {
  const current = monthOrLatest(ledger, str(args["month"]), ctx.today);
  const statement = queries.incomeStatement(ledger, current);
  const named = (values: ReadonlyMap<Id, Dec>) =>
    sortedBy(
      [...values]
        .filter(([, v]) => !v.isZero())
        .map(([k, v]) => ({ categoria: accountLabel(ledger, ledger.account(k)), total: v })),
      (r) => r.total,
      true,
    ).slice(0, 10);
  return {
    mes: ymStr(current),
    receitas: statement.totalIncome,
    despesas: statement.totalExpense,
    resultado: statement.result,
    maiores_despesas: named(statement.expense),
    receitas_por_categoria: named(statement.income),
  };
}

function budgetStatus(ledger: Ledger, args: Args, ctx: ToolContext): Record<string, unknown> {
  const current = monthOrLatest(ledger, str(args["month"]), ctx.today);
  const found = budget.status(ledger, current);
  return {
    mes: ymStr(current),
    planejado: found.totalPlanned,
    gasto_planejado: found.totalActual,
    gasto_sem_plano: found.unbudgeted,
    linhas: found.rows.map((r) => ({
      categoria: accountLabel(ledger, ledger.account(r.categoryId)),
      planejado: r.planned,
      gasto: r.actual,
      restante: r.remaining,
      situacao: r.state,
    })),
  };
}

function listTags(ledger: Ledger): Record<string, unknown> {
  return {
    marcadores: tags
      .summaries(ledger)
      .slice(0, MAX_ROWS)
      .map((s) => ({ nome: s.tag, lancamentos: s.operations.length, despesas: s.expense })),
  };
}

function listRules(ledger: Ledger): Record<string, unknown> {
  const all = [...rules.rules(ledger).values()];
  const rows = all.map((rule) => {
    const target = ledger.accounts.get(rule.target_account_id);
    return { contem: rule.pattern, categoria: target ? accountLabel(ledger, target) : "?", ativa: rule.active };
  });
  return { regras: rows.slice(0, MAX_ROWS), total: rows.length };
}

function listPendingImportItems(ledger: Ledger, args: Args): Record<string, unknown> {
  const pending = sortedBy(pendingItems(ledger), (i) => [i.occurred_on ?? "0001-01-01", i.description]);
  const rows = pending.slice(0, args["limit"] as number).map((item) => {
    const target = item.target_account_id ? ledger.accounts.get(item.target_account_id) : undefined;
    return {
      id: shortId(item.id),
      data: item.occurred_on,
      descricao: item.description,
      valor: item.amount,
      categoria: target ? accountLabel(ledger, target) : null,
    };
  });
  return { total: pending.length, itens: rows };
}

function merchantTotals(ledger: Ledger, args: Args): Record<string, unknown> {
  const start = month(args["start"] as string, "mês inicial");
  const end = month(str(args["end"]), "mês final") ?? start;
  if (start === null || end === null) throw new ToolError("Informe o mês inicial, AAAA-MM.");
  const rows = merchants.totals(ledger, ymFirstDay(start), ymLastDay(end));
  return {
    estabelecimentos: rows.slice(0, MAX_ROWS).map((m) => ({ nome: m.name, despesas: m.expense, lancamentos: m.count })),
  };
}

/** The Livro filter a `show_in_ledger` result offers: a tag, or an account with an optional period. */
export type LedgerLink = readonly ["tag", string] | readonly ["filter", Id, readonly [IsoDate, IsoDate] | null];

/** Not an edit: offers the user a button that opens the Livro with these filters. */
function showInLedger(ledger: Ledger, args: Args): { link: LedgerLink; rotulo: string } {
  const tag = str(args["tag"]);
  if (tag) {
    if (!tags.allTags(ledger).includes(tag)) throw new ToolError(`Não existe o marcador '${tag}'. Consulte list_tags.`);
    return { link: ["tag", tag], rotulo: `marcador ${tag}` };
  }
  if (!str(args["account"])) throw new ToolError("Informe a conta, a categoria ou o marcador a mostrar.");
  const account = findAccount(ledger, str(args["account"])!);
  const start = day(str(args["start"]), "data inicial");
  const end = day(str(args["end"]), "data final");
  const period = start && end ? ([start, end] as const) : null;
  let label = accountLabel(ledger, account);
  if (period) label += `, de ${formatDateBr(start!)} a ${formatDateBr(end!)}`;
  return { link: ["filter", account.id, period], rotulo: label };
}

type ReadFn = (ledger: Ledger, args: Args, ctx: ToolContext) => unknown;

export const READS: readonly (readonly [string, string, ArgSpec, ReadFn])[] = [
  [
    "get_overview",
    "Resumo do projeto: integrantes, receitas, despesas e resultado de um mês, patrimônio e pendências.",
    MONTH_ARGS,
    getOverview,
  ],
  ["list_accounts", "Contas, cartões e investimentos com o saldo atual.", NO_ARGS, listAccounts],
  ["list_categories", "Nomes das categorias de despesa e de receita.", CATEGORIES_ARGS, listCategories],
  ["list_members", "Integrantes do projeto.", NO_ARGS, listMembers],
  [
    "search_operations",
    "Procura lançamentos com filtros (texto, período, conta ou categoria, integrante, marcador, valor). " +
      "Devolve o total encontrado e os mais recentes primeiro, cada um com seu 'id'.",
    SEARCH_ARGS,
    searchOperations,
  ],
  [
    "get_operation",
    "Detalhes de um lançamento pelo 'id': partidas, competência, versões.",
    OPERATION_ARGS,
    getOperation,
  ],
  ["spending_by_category", "Total de despesas por categoria num período de meses.", PERIOD_ARGS, spendingByCategory],
  ["month_summary", "Receitas, despesas e resultado de um mês, com as maiores categorias.", MONTH_ARGS, monthSummary],
  ["budget_status", "Orçamento de um mês: planejado, gasto e restante por categoria.", MONTH_ARGS, budgetStatus],
  ["list_tags", "Marcadores com quantos lançamentos e quanto de despesa cada um tem.", NO_ARGS, listTags],
  ["list_rules", "Regras de categoria (a descrição contém… → categoria).", NO_ARGS, listRules],
  [
    "list_pending_import_items",
    "Itens importados que ainda aguardam revisão, com a categoria sugerida.",
    LIMIT_ARGS,
    listPendingImportItems,
  ],
  ["merchant_totals", "Despesas por estabelecimento num período de meses.", PERIOD_ARGS, merchantTotals],
  [
    "show_in_ledger",
    "Oferece ao usuário um botão que abre o Livro financeiro filtrado por conta, categoria ou marcador " +
      "(e período). Não muda nada.",
    SHOW_ARGS,
    showInLedger,
  ],
];

export function register(registry: Registry): void {
  for (const [name, description, spec, run] of READS) {
    const tool: Tool = { name, description, arguments: spec, kind: ToolKind.READ, run, prepare: null };
    registry.add(tool);
  }
}
