/**
 * What the project has and owes over time: net worth, account balances, card bills, loans and goals.
 * Port of `charts/data/wealth.py`.
 *
 * `loanChart` and `goalChart` read `date.today()` in Python; here `today` is explicit.
 */
import {
  formatDateBr,
  type IsoDate,
  minDate,
  ymAdd,
  ymFirstDay,
  ymLastDay,
  ymOf,
  ymStr,
  type YearMonth,
} from "../../lib/dates.ts";
import type { Dec } from "../../lib/dec.ts";
import type { Id } from "../../lib/ids.ts";
import { KeyError } from "../../lib/py.ts";
import { sortedBy } from "../../lib/text.ts";
import { results } from "../../domain/balance_checks.ts";
import { bills } from "../../domain/cards.ts";
import { type Goal, KIND_LABELS, valueOf } from "../../domain/goals.ts";
import type { Ledger } from "../../domain/ledger.ts";
import { plans, planSchedule, STATE_LABELS, stateOf } from "../../domain/loans.ts";
import * as queries from "../../domain/queries.ts";
import { composition, compositionPartial } from "../../investments/performance.ts";
import { type Chart, chart, datePoint, monthsBetween, point, series } from "./model.ts";

export function netWorthSeries(ledger: Ledger, start: YearMonth, end: YearMonth): Chart {
  const assets = [];
  const liabilities = [];
  const net = [];
  const notes = [];
  for (const month of monthsBetween(start, end)) {
    const worth = queries.netWorth(ledger, ymLastDay(month));
    const info: Record<string, string> = { base: "custo contábil" };
    const portfolio = composition(ledger, ymLastDay(month));
    if (compositionPartial(portfolio)) info["carteira"] = "parcial (ativos sem avaliação)";
    assets.push(point(ymStr(month), worth.assets, info));
    liabilities.push(point(ymStr(month), worth.liabilities, info));
    net.push(point(ymStr(month), worth.net, info));
  }
  notes.push("Investimentos pelo custo contábil; o valor observado aparece nos gráficos de investimento.");
  return chart(
    "Patrimônio",
    "BRL",
    [
      series("Ativos", assets, { style: "line", markerPoints: true }),
      series("Passivos", liabilities, { style: "line", markerPoints: true }),
      series("Patrimônio líquido", net, { style: "line", markerPoints: true }),
    ],
    notes,
  );
}

/** End-of-month balance of one account, with the bank checks informed by the user. */
export function accountBalanceHistory(ledger: Ledger, accountId: Id, start: YearMonth, end: YearMonth): Chart {
  const account = ledger.account(accountId);
  const months = monthsBetween(start, end);
  const balances = months.map((m) =>
    point(ymStr(m), queries.balance(ledger, accountId, ymLastDay(m)), { saldo: "fim do mês" }),
  );
  const seriesList = [series("Saldo no fim do mês", balances, { style: "line", markerPoints: true })];
  const first = ymFirstDay(start);
  const last = ymLastDay(end);
  const checks = results(ledger, accountId).filter((r) => first <= r.check.on && r.check.on <= last);
  if (checks.length) {
    const byMonth = new Map<string, Dec>();
    for (const r of sortedBy(checks, (r) => r.check.on)) byMonth.set(ymStr(ymOf(r.check.on)), r.check.informed);
    seriesList.push(
      series(
        "Saldo informado pelo banco",
        months.map((m) => point(ymStr(m), byMonth.get(ymStr(m)) ?? null)),
        { style: "scatter" },
      ),
    );
  }
  return chart(`Saldo: ${account.name}`, "BRL", seriesList, ["Saldo por data de caixa."], "caixa");
}

export function cardBillsHistory(ledger: Ledger, cardId: Id, months: readonly YearMonth[]): Chart {
  const card = ledger.cards.get(cardId);
  if (card === undefined) throw new KeyError(cardId);
  const found = bills(ledger, cardId, months);
  const total = found.map((b) => point(ymStr(b.cycle.month), b.total, { vencimento: formatDateBr(b.cycle.due) }));
  const paid = found.map((b) => point(ymStr(b.cycle.month), b.payments));
  const installments = found.map((b) => point(ymStr(b.cycle.month), b.installments));
  return chart(
    `Faturas: ${card.name}`,
    "BRL",
    [series("Total da fatura", total), series("Pago", paid), series("Parcelas", installments, { hidden: true })],
    ["Mês de vencimento."],
  );
}

/** Outstanding balance and the interest × amortization split of each installment. */
export function loanChart(ledger: Ledger, planId: Id, today: IsoDate): Chart {
  const plan = plans(ledger).get(planId);
  if (plan === undefined) throw new KeyError(planId);
  const balance = [];
  const interest = [];
  const amortization = [];
  const payment = [];
  for (const item of planSchedule(ledger, planId)) {
    const info: Record<string, string> = {
      parcela: String(item.number),
      situação: STATE_LABELS[stateOf(ledger, planId, item, today)],
    };
    if (!item.prepaidAfter.isZero()) info["amortização antecipada"] = item.prepaidAfter.toFixed();
    balance.push(datePoint(item.due, item.balanceAfter, info));
    interest.push(datePoint(item.due, item.interest, info));
    amortization.push(datePoint(item.due, item.amortization, info));
    payment.push(datePoint(item.due, item.payment, info));
  }
  return chart(
    `Financiamento: ${plan.name}`,
    "BRL",
    [
      series("Saldo devedor", balance, { style: "line" }),
      series("Juros", interest, { style: "line", summable: true, axis: "right" }),
      series("Amortização", amortization, { style: "line", summable: true, axis: "right" }),
      series("Parcela", payment, { hidden: true, summable: true }),
    ],
    [
      "Saldo devedor na escala da esquerda; juros e amortização de cada parcela na da direita.",
      "Calculado pelo contrato informado; o saldo da conta no livro é a referência.",
    ],
  );
}

/** The goal's value at the end of each month, against the target. */
export function goalChart(ledger: Ledger, goalId: Id, end: YearMonth, today: IsoDate, months = 12): Chart {
  const goal = ledger.entities<Goal>("goal").get(goalId);
  if (goal === undefined) throw new KeyError(goalId);
  const value = [];
  const target = [];
  for (const month of monthsBetween(ymAdd(end, -(months - 1)), end)) {
    const at = minDate(ymLastDay(month), today);
    value.push(point(ymStr(month), valueOf(ledger, goal, at), { base: KIND_LABELS[goal.kind].toLowerCase() }));
    target.push(point(ymStr(month), goal.target));
  }
  const notes = ["Valor no fim de cada mês (o mês atual, até hoje)."];
  if (goal.target_date) notes.push(`Prazo: ${formatDateBr(goal.target_date)}.`);
  return chart(
    `Meta: ${goal.name}`,
    "BRL",
    [
      series("Valor", value, { style: "line", markerPoints: true }),
      series("Meta", target, { style: "line", summable: false }),
    ],
    notes,
  );
}
