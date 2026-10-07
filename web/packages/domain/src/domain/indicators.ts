/**
 * Family indicators computed from what is already recorded (docs/09 §1.3 E).
 * Port of `domain/indicators.py`.
 *
 * Each indicator says how it is computed and is null, with the reason, when the data does not
 * allow it (no income in the month, no expense history): never a misleading zero.
 */
import { ymAdd, ymEq, ymLastDay, ymOf, ymStr, type YearMonth } from "../lib/dates.ts";
import { Dec } from "../lib/dec.ts";
import { plans as cardPlans, schedule } from "./cards.ts";
import { knownMonths } from "./comparisons.ts";
import * as queries from "./queries.ts";
import type { Ledger } from "./ledger.ts";
import { loanOperationIds, plans as loanPlans, planSchedule } from "./loans.ts";
import { AccountType, isLiquid } from "./model.ts";
import { ZERO } from "./money.ts";

export const RATIO = Dec.from("0.0001");
export const RESERVE_WINDOW = 6; // months of expense averaged for the emergency reserve

export interface Indicator {
  readonly key: string;
  readonly label: string;
  readonly value: Dec | null;
  /** "%" (fraction: 0.25 = 25%), "meses" */
  readonly unit: string;
  /** How it was computed, or why it is unavailable. */
  readonly detail: string;
}

function ratio(part: Dec, whole: Dec): Dec {
  return part.div(whole).quantize(RATIO);
}

function lastMonths(month: YearMonth, count: number): YearMonth[] {
  return Array.from({ length: count }, (_, i) => ymAdd(month, -i));
}

function savingsRate(ledger: Ledger, month: YearMonth): Indicator {
  const statement = queries.incomeStatement(ledger, month);
  const label = "Taxa de poupança do mês";
  if (!statement.totalIncome.isPositive()) {
    return { key: "savings", label, value: null, unit: "%", detail: "Sem receitas no mês." };
  }
  return {
    key: "savings",
    label,
    value: ratio(statement.result, statement.totalIncome),
    unit: "%",
    detail: "Resultado por competência dividido pelas receitas do mês.",
  };
}

function savingsRateYear(ledger: Ledger, month: YearMonth): Indicator {
  const months = knownMonths(ledger, lastMonths(month, 12));
  let income = ZERO;
  let expense = ZERO;
  for (const m of months) {
    const statement = queries.incomeStatement(ledger, m);
    income = income.add(statement.totalIncome);
    expense = expense.add(statement.totalExpense);
  }
  const label = "Taxa de poupança em 12 meses";
  if (!income.isPositive()) {
    return { key: "savings_12m", label, value: null, unit: "%", detail: "Sem receitas registradas no período." };
  }
  const detail = `Últimos ${months.length} mês(es) com registros: resultado dividido pelas receitas.`;
  return { key: "savings_12m", label, value: ratio(income.sub(expense), income), unit: "%", detail };
}

/** Share of the month's expenses that are commitments: linked to a recurrence or loan installments. */
function fixedShare(ledger: Ledger, month: YearMonth): Indicator {
  const loans = loanOperationIds(ledger);
  let total = ZERO;
  let fixed = ZERO;
  for (const op of queries.index(ledger).byCompetence.get(ymStr(month)) ?? []) {
    const committed = op.forecast_id !== null || loans.has(op.id);
    for (const p of op.postings) {
      if (ledger.account(p.account_id).type === AccountType.EXPENSE) {
        total = total.add(p.amount);
        if (committed) fixed = fixed.add(p.amount);
      }
    }
  }
  const label = "Despesas fixas";
  if (!total.isPositive()) return { key: "fixed", label, value: null, unit: "%", detail: "Sem despesas no mês." };
  return {
    key: "fixed",
    label,
    value: ratio(fixed, total),
    unit: "%",
    detail: "Parte das despesas do mês ligada a recorrências e a parcelas de financiamento; o resto é variável.",
  };
}

/** Card installments billed in the month plus loan installments due in it, over the month's income. */
function committedIncome(ledger: Ledger, month: YearMonth): Indicator {
  let installments = ZERO;
  for (const plan of cardPlans(ledger).values()) {
    installments = installments.add(
      Dec.sum(
        schedule(ledger, plan)
          .filter((i) => ymEq(i.cycle.month, month))
          .map((i) => i.amount),
        ZERO,
      ),
    );
  }
  for (const loan of loanPlans(ledger).values()) {
    installments = installments.add(
      Dec.sum(
        planSchedule(ledger, loan.id)
          .filter((i) => ymEq(ymOf(i.due), month))
          .map((i) => i.payment),
        ZERO,
      ),
    );
  }
  const income = queries.incomeStatement(ledger, month).totalIncome;
  const label = "Renda comprometida com parcelas";
  if (!income.isPositive()) return { key: "committed", label, value: null, unit: "%", detail: "Sem receitas no mês." };
  return {
    key: "committed",
    label,
    value: ratio(installments, income),
    unit: "%",
    detail: "Parcelas de cartão e de financiamento do mês divididas pelas receitas do mês.",
  };
}

/** How many months of the average expense the liquid accounts cover. */
function reserveMonths(ledger: Ledger, month: YearMonth): Indicator {
  const months = knownMonths(ledger, lastMonths(month, RESERVE_WINDOW));
  const expense = Dec.sum(
    months.map((m) => queries.incomeStatement(ledger, m).totalExpense),
    ZERO,
  );
  const label = "Reserva em meses de despesa";
  if (!months.length || !expense.isPositive()) {
    return { key: "reserve", label, value: null, unit: "meses", detail: "Sem despesas registradas para comparar." };
  }
  const at = ymLastDay(month);
  const liquid = Dec.sum(
    [...ledger.accounts.values()]
      .filter((a) => isLiquid(a) && a.type === AccountType.ASSET && !a.archived)
      .map((a) => queries.balance(ledger, a.id, at)),
    ZERO,
  );
  const average = expense.div(months.length);
  return {
    key: "reserve",
    label,
    value: liquid.div(average).quantize("0.1"),
    unit: "meses",
    detail: `Saldo das contas líquidas no fim do mês dividido pela despesa média de ${months.length} mês(es).`,
  };
}

export function indicators(ledger: Ledger, month: YearMonth): Indicator[] {
  return [
    savingsRate(ledger, month),
    savingsRateYear(ledger, month),
    fixedShare(ledger, month),
    committedIncome(ledger, month),
    reserveMonths(ledger, month),
  ];
}
