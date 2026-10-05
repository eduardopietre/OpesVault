/**
 * Where the money went: categories, comparisons, budget, tags and merchants.
 * Port of `charts/data/spending.py`.
 */
import { formatDateBr, type IsoDate, ymLte, ymStr, type YearMonth } from "../../lib/dates.ts";
import { Dec } from "../../lib/dec.ts";
import type { Id } from "../../lib/ids.ts";
import { formatFixed } from "../../lib/py.ts";
import { sortedBy } from "../../lib/text.ts";
import { status as budgetStatus } from "../../domain/budget.ts";
import { categoryComparison } from "../../domain/comparisons.ts";
import type { Ledger } from "../../domain/ledger.ts";
import { totals as merchantTotals } from "../../domain/merchants.ts";
import { AccountType, competence, OperationKind } from "../../domain/model.ts";
import { ZERO } from "../../domain/money.ts";
import * as queries from "../../domain/queries.ts";
import { summaries, summary } from "../../domain/tags.ts";
import { type Chart, chart, monthName, monthsBetween, point, series } from "./model.ts";

export function expensesByCategory(ledger: Ledger, start: YearMonth, end: YearMonth): Chart {
  const totals = queries.expensesByCategory(ledger, start, end);
  const refunds = new Map<Id, Dec>();
  for (const op of ledger.activeOperations()) {
    const comp = competence(op);
    if (op.kind === OperationKind.REFUND && comp !== null && ymLte(start, comp) && ymLte(comp, end)) {
      for (const p of op.postings) {
        if (ledger.account(p.account_id).type === AccountType.EXPENSE) {
          refunds.set(p.account_id, (refunds.get(p.account_id) ?? ZERO).add(p.amount.negate()));
        }
      }
    }
  }
  const ordered = sortedBy([...totals], ([, value]) => value, true);
  const points = ordered.map(([cid, value]) => {
    const refunded = refunds.get(cid);
    return point(
      ledger.account(cid).name,
      value,
      refunded && !refunded.isZero() ? { "estornos no período": refunded.toString() } : {},
    );
  });
  return chart(
    "Despesas por categoria",
    "BRL",
    [series("Despesas", points)],
    ["Valores já líquidos de estornos."],
    "competência",
  );
}

/** One expense category (with its sub-categories) month by month, by competence. */
export function categoryMonthly(ledger: Ledger, categoryId: Id, start: YearMonth, end: YearMonth): Chart {
  const family = new Set<Id>([categoryId]);
  let grew = true;
  while (grew) {
    // sub-categories at any depth
    const children = new Set<Id>();
    for (const a of ledger.accounts.values()) {
      if (a.parent_id !== null && family.has(a.parent_id) && !family.has(a.id)) children.add(a.id);
    }
    for (const c of children) family.add(c);
    grew = children.size > 0;
  }
  const points = monthsBetween(start, end).map((month) => {
    const totals = queries.expensesByCategory(ledger, month, month);
    let value = ZERO;
    for (const [cid, v] of totals) if (family.has(cid)) value = value.add(v);
    return point(ymStr(month), value, { regime: "competência" });
  });
  const name = ledger.account(categoryId).name;
  return chart(
    `Despesas: ${name}`,
    "BRL",
    [series(name, points)],
    ["Competência; inclui as subcategorias. Valores já líquidos de estornos."],
    "competência",
  );
}

export function categoryComparisonChart(ledger: Ledger, month: YearMonth, window = 3): Chart {
  const rows = categoryComparison(ledger, month, window);
  const labelNow = monthName(month);
  const current = [];
  const average = [];
  const lastYear = [];
  for (const row of rows) {
    const info: Record<string, string> = {};
    if (row.change !== null) {
      info["variação"] = `${formatFixed(row.change.mul(100), 0, true)}% sobre a média`.replaceAll(".", ",");
    }
    current.push(point(row.name, row.current, info));
    average.push(point(row.name, row.average, { "meses na média": String(row.monthsAveraged) }));
    lastYear.push(point(row.name, row.lastYear));
  }
  const notes = [`Competência. Média dos ${window} meses anteriores com registros; meses sem registros não entram.`];
  if (rows.length && rows[0]!.monthsAveraged < window) {
    notes.push(`Só ${rows[0]!.monthsAveraged} mês(es) anterior(es) com registros.`);
  }
  return chart(
    "Comparação com a média",
    "BRL",
    [
      series(labelNow, current),
      series(`Média de ${window} meses`, average),
      series("Mesmo mês do ano anterior", lastYear),
    ],
    notes,
    "competência",
  );
}

/** Planned against actual month by month, for the whole budget or one category. */
export function budgetHistory(ledger: Ledger, start: YearMonth, end: YearMonth, categoryId: Id | null = null): Chart {
  const planned = [];
  const actual = [];
  for (const month of monthsBetween(start, end)) {
    const current = budgetStatus(ledger, month);
    let plan: Dec | null;
    let spent: Dec | null;
    if (categoryId === null) {
      plan = current.rows.length ? current.totalPlanned : null;
      spent = current.rows.length ? current.totalActual : null;
    } else {
      const row = current.rows.find((r) => r.categoryId === categoryId);
      plan = row ? row.planned : null;
      spent = row ? row.actual : null;
    }
    planned.push(point(ymStr(month), plan, plan === null ? { situação: "sem orçamento" } : {}));
    actual.push(point(ymStr(month), spent, { regime: "competência" }));
  }
  const name = categoryId ? ledger.account(categoryId).name : "Categorias com orçamento";
  return chart(
    `Orçamento mês a mês: ${name}`,
    "BRL",
    [series("Planejado", planned), series("Realizado", actual)],
    ["Meses sem orçamento ficam vazios, não zerados."],
    "competência",
  );
}

export function tagChart(ledger: Ledger, tag: string): Chart {
  const found = summary(ledger, tag);
  const ordered = sortedBy([...found.byCategory], ([, value]) => value, true);
  const points = ordered
    .filter(([, value]) => !value.isZero())
    .map(([cid, value]) => point(ledger.account(cid).name, value));
  let span = "";
  if (found.first && found.last) span = `De ${formatDateBr(found.first)} a ${formatDateBr(found.last)}. `;
  return chart(
    `Marcador: ${tag}`,
    "BRL",
    [series("Despesas", points)],
    [span + "Despesas líquidas de estornos, em qualquer mês."],
  );
}

export function tagsOverview(ledger: Ledger): Chart {
  const rows = summaries(ledger);
  return chart(
    "Marcadores",
    "BRL",
    [
      series(
        "Despesas",
        rows.map((s) => point(s.tag, s.expense, { lançamentos: String(s.operations.length) })),
      ),
      series(
        "Receitas",
        rows.map((s) => point(s.tag, s.income)),
        { hidden: true },
      ),
    ],
    ["Cada marcador soma seus lançamentos em qualquer mês, com várias categorias."],
  );
}

/** Expense per merchant (approved names, or the cleaned description), largest first. */
export function merchantsChart(ledger: Ledger, start: IsoDate, end: IsoDate, top = 15): Chart {
  const found = merchantTotals(ledger, start, end);
  const shown = found.slice(0, top);
  const rest = found.slice(top).reduce((sum, m) => sum.add(m.expense), ZERO);
  const points = shown.map((m) =>
    point(m.name, m.expense, { lançamentos: String(m.count), nome: m.approved ? "aprovado" : "da descrição" }),
  );
  if (!rest.isZero()) points.push(point("Outros", rest, { estabelecimentos: String(found.length - top) }));
  return chart(
    "Despesas por estabelecimento",
    "BRL",
    [series("Despesas", points)],
    ["Nomes aprovados no Livro (Ações › Nomear estabelecimento); os demais vêm da descrição, limpa."],
  );
}
