/**
 * Money in and out over time: monthly flows, results, cash, the projected balance and commitments.
 * Port of `charts/data/cash.py`.
 */
import {
  addDays,
  type IsoDate,
  ymAdd,
  ymFirstDay,
  ymLastDay,
  ymLte,
  ymOf,
  ymParse,
  ymStr,
  type YearMonth,
} from "../../lib/dates.ts";
import { Dec } from "../../lib/dec.ts";
import type { Id } from "../../lib/ids.ts";
import { sortedBy } from "../../lib/text.ts";
import { annual, NOTICE } from "../../domain/annual.ts";
import { plans, schedule } from "../../domain/cards.ts";
import type { Ledger } from "../../domain/ledger.ts";
import { AccountType, isLiquid } from "../../domain/model.ts";
import { ZERO } from "../../domain/money.ts";
import { events, project } from "../../domain/projection.ts";
import * as queries from "../../domain/queries.ts";
import { ForecastStatus, forecasts } from "../../domain/recurrence.ts";
import { type Chart, chart, datePoint, monthsBetween, point, series } from "./model.ts";

export function monthlyInOut(
  ledger: Ledger,
  start: YearMonth,
  end: YearMonth,
  accounts: readonly Id[] | null = null,
): Chart {
  const flows = queries.cashFlow(ledger, start, end, accounts);
  const scope = accounts && accounts.length ? "contas selecionadas" : "consolidado (transferências internas excluídas)";
  const info = { regime: "caixa", contas: scope };
  return chart(
    "Entradas e saídas mensais",
    "BRL",
    [
      series(
        "Entradas",
        [...flows].map(([m, f]) => point(m, f.inflow, info)),
      ),
      series(
        "Saídas",
        [...flows].map(([m, f]) => point(m, f.outflow, info)),
      ),
    ],
    [`Regime de caixa · ${scope}`],
    "caixa",
  );
}

/** Competence result per month; with `memberId`, the member's view (`queries.incomeStatement`). */
export function monthlyResult(ledger: Ledger, start: YearMonth, end: YearMonth, memberId: Id | null = null): Chart {
  const points = monthsBetween(start, end).map((month) => {
    const statement = queries.incomeStatement(ledger, month, memberId);
    return point(ymStr(month), statement.result, { regime: "competência" });
  });
  const member = memberId ? ledger.members.get(memberId) : undefined;
  const notes = ["Competência; não é a variação do saldo bancário."];
  if (member !== undefined) notes.push(`Visão de ${member.name}: lançamentos e rateios atribuídos a este integrante.`);
  return chart(
    "Resultado mensal (receitas − despesas)" + (member ? ` · ${member.name}` : ""),
    "BRL",
    [series("Resultado", points)],
    notes,
    "competência",
  );
}

export function cashFlowBalance(
  ledger: Ledger,
  start: YearMonth,
  end: YearMonth,
  accounts: readonly Id[] | null = null,
): Chart {
  const flows = queries.cashFlow(ledger, start, end, accounts);
  const liquid =
    accounts && accounts.length ? accounts : [...ledger.accounts.values()].filter(isLiquid).map((a) => a.id);
  const balancePoints = [...flows.keys()].map((key) => {
    const day = ymLastDay(ymParse(key));
    const total = Dec.sum(
      liquid.map((a) => queries.balance(ledger, a, day)),
      ZERO,
    );
    return point(key, total, { regime: "caixa", saldo: "fim do mês" });
  });
  return chart(
    "Fluxo de caixa",
    "BRL",
    [
      series(
        "Entradas",
        [...flows].map(([m, f]) => point(m, f.inflow)),
      ),
      series(
        "Saídas",
        [...flows].map(([m, f]) => point(m, f.outflow)),
      ),
      series("Saldo das contas", balancePoints, { style: "line", markerPoints: true }),
    ],
    ["Transferências internas excluídas do consolidado."],
    "caixa",
  );
}

/** The months side by side: cash, competence result and net worth (Visão geral). */
export function monthlySummary(ledger: Ledger, start: YearMonth, end: YearMonth): Chart {
  const months = monthsBetween(start, end);
  const flows = queries.cashFlow(ledger, start, end);
  const income = [];
  const expense = [];
  const result = [];
  const worth = [];
  const inflow = [];
  const outflow = [];
  for (const month of months) {
    const statement = queries.incomeStatement(ledger, month);
    const label = ymStr(month);
    const competence = { regime: "competência" };
    income.push(point(label, statement.totalIncome, competence));
    expense.push(point(label, statement.totalExpense, competence));
    result.push(point(label, statement.result, competence));
    inflow.push(point(label, flows.get(label)!.inflow, { regime: "caixa" }));
    outflow.push(point(label, flows.get(label)!.outflow, { regime: "caixa" }));
    worth.push(point(label, queries.netWorth(ledger, ymLastDay(month)).net, { base: "fim do mês" }));
  }
  return chart(
    "Mês a mês",
    "BRL",
    [
      series("Receitas", income),
      series("Despesas", expense),
      series("Resultado", result, { style: "line", markerPoints: true, summable: true }),
      series("Entradas (caixa)", inflow, { hidden: true }),
      series("Saídas (caixa)", outflow, { hidden: true }),
      series("Patrimônio líquido", worth, { style: "line", hidden: true }),
    ],
    ["Receitas, despesas e resultado por competência; entradas e saídas por caixa (na tabela)."],
    "competência",
  );
}

/**
 * Each liquid account's balance from today, with the movements already known (a forecast).
 *
 * Every account has a value on every day with a movement, so the table reads across: a balance that
 * does not change on a day is still known that day. Late items that may still happen are counted today.
 */
export function projectedBalance(ledger: Ledger, today: IsoDate, days = 60): Chart {
  const end = addDays(today, days);
  const projections = project(ledger, today, days).filter((p) => p.events.length > 0 || !p.startBalance.isZero());
  const moving = new Set<IsoDate>();
  for (const projection of projections) for (const event of projection.events) moving.add(event.on);
  const daysShown = sortedBy([...new Set<IsoDate>([today, end, ...moving])], (d) => d);
  const seriesList = projections.map((projection) => {
    const account = ledger.account(projection.accountId);
    const own = new Set(projection.events.map((e) => e.on));
    const points = daysShown.map((day) => {
      const info: Record<string, string> = { natureza: day === today ? "saldo de hoje" : "previsão" };
      if (own.has(day)) {
        info["movimentos"] = projection.events
          .filter((e) => e.on === day)
          .map((e) => `${e.description} (${e.source})`)
          .join("; ");
      }
      return datePoint(day, projection.balanceOn(day), info);
    });
    return series(account.name, points, { style: "step", markerPoints: true });
  });
  const [, notes] = events(ledger, today, end);
  return chart("Saldo projetado", "BRL", seriesList, [
    "Previsão com recorrências, faturas e parcelas já registradas; atrasados contam hoje. Não altera saldos.",
    ...notes,
  ]);
}

export function commitmentsProjection(ledger: Ledger, start: YearMonth, months = 12): Chart {
  const end = ymAdd(start, months - 1);
  const installments = new Map<string, Dec>();
  for (const plan of plans(ledger).values()) {
    for (const item of schedule(ledger, plan)) {
      if (ymLte(start, item.cycle.month) && ymLte(item.cycle.month, end)) {
        const key = ymStr(item.cycle.month);
        installments.set(key, (installments.get(key) ?? ZERO).add(item.amount));
      }
    }
  }
  const recurringOut = new Map<string, Dec>();
  const recurringIn = new Map<string, Dec>();
  // `today` only decides pending against late here, and both count
  for (const f of forecasts(ledger, ymFirstDay(start), ymLastDay(end), ymFirstDay(start))) {
    if (f.status !== ForecastStatus.PENDING && f.status !== ForecastStatus.LATE) continue;
    const target = f.amount.isPositive() ? recurringIn : recurringOut;
    const key = ymStr(ymOf(f.dueOn));
    target.set(key, (target.get(key) ?? ZERO).add(f.amount.abs()));
  }
  const labels = monthsBetween(start, end);
  const info = { natureza: "previsão" };
  const col = (m: Map<string, Dec>) => labels.map((l) => point(ymStr(l), m.get(ymStr(l)) ?? ZERO, info));
  return chart(
    "Projeção de compromissos",
    "BRL",
    [
      series("Parcelas de cartão", col(installments), { style: "forecast" }),
      series("Saídas recorrentes", col(recurringOut), { style: "forecast" }),
      series("Entradas recorrentes", col(recurringIn), { style: "forecast" }),
    ],
    ["Previsões: não alteram o realizado."],
  );
}

/** Balances on 31/12 per account, with the previous year's in the table (fechamento do ano). */
export function annualChart(ledger: Ledger, year: number): Chart {
  const summary = annual(ledger, year);
  const end = [];
  const before = [];
  for (const line of summary.balances) {
    const kind = line.kind === AccountType.ASSET ? "bem" : "dívida";
    end.push(point(line.name, line.yearEnd, { tipo: kind }));
    before.push(point(line.name, line.previousYearEnd, { tipo: kind }));
  }
  return chart(
    `Bens e dívidas em 31/12/${year}`,
    "BRL",
    [series(`31/12/${year}`, end), series(`31/12/${year - 1}`, before, { hidden: true })],
    [NOTICE],
  );
}
