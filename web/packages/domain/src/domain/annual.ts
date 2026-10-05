/**
 * Year-end summary: support material for the annual tax return (docs/09 §1.3 C, docs/00 §5).
 * Port of `domain/annual.py`.
 *
 * What the family already recorded, organized by year: balances on 31/12 (and a year before), income
 * by category, investment income, tax withheld, realized gains and deductible expenses. It is not the
 * tax return: it applies no legal rule, classifies nothing as exempt or taxable on its own, and every
 * figure keeps its quality (incomplete events are counted and flagged).
 */
import { makeDate, yearOf, ym } from "../lib/dates.ts";
import { Dec } from "../lib/dec.ts";
import type { Id } from "../lib/ids.ts";
import { casefold, sortedBy } from "../lib/text.ts";
import { EventKind, realizedGain } from "../investments/model.ts";
import { events } from "../investments/service.ts";
import type { Ledger } from "./ledger.ts";
import { AccountType } from "./model.ts";
import { ZERO } from "./money.ts";
import * as queries from "./queries.ts";

export const NOTICE =
  "Material de apoio à declaração anual, a partir do que foi registrado. Não aplica regras fiscais " +
  "nem classifica rendimentos como isentos ou tributáveis; confira com os informes das instituições.";

export interface BalanceLine {
  readonly accountId: Id;
  readonly name: string;
  readonly kind: AccountType;
  readonly yearEnd: Dec;
  readonly previousYearEnd: Dec;
}

export class AnnualSummary {
  readonly year: number;
  balances: BalanceLine[] = [];
  /** By income category, competence. */
  income = new Map<Id, Dec>();
  expenseTotal: Dec = ZERO;
  /** Distributions received (gross when known). */
  investmentIncome: Dec = ZERO;
  taxWithheld: Dec = ZERO;
  realizedGains: Dec = ZERO;
  /** Redemptions without gross or cost: not in the gains. */
  incompleteEvents = 0;

  constructor(year: number) {
    this.year = year;
  }

  get netWorth(): Dec {
    return Dec.sum(
      this.balances.map((b) => (b.kind === AccountType.ASSET ? b.yearEnd : b.yearEnd.negate())),
      ZERO,
    );
  }
}

export function annual(ledger: Ledger, year: number): AnnualSummary {
  const summary = new AnnualSummary(year);
  const end = makeDate(year, 12, 31);
  const before = makeDate(year - 1, 12, 31);
  const now = queries.balances(ledger, end);
  const then = queries.balances(ledger, before);
  for (const account of sortedBy([...ledger.accounts.values()], (a) => [a.type, casefold(a.name)])) {
    if (account.type !== AccountType.ASSET && account.type !== AccountType.LIABILITY) continue;
    const value = now.get(account.id) ?? ZERO;
    const previous = then.get(account.id) ?? ZERO;
    if (!value.isZero() || !previous.isZero()) {
      summary.balances.push({
        accountId: account.id,
        name: account.name,
        kind: account.type,
        yearEnd: value,
        previousYearEnd: previous,
      });
    }
  }
  const income = new Map<Id, Dec>();
  for (let month = 1; month <= 12; month++) {
    const statement = queries.incomeStatement(ledger, ym(year, month));
    for (const [categoryId, value] of statement.income)
      income.set(categoryId, (income.get(categoryId) ?? ZERO).add(value));
    summary.expenseTotal = summary.expenseTotal.add(statement.totalExpense);
  }
  summary.income = new Map([...income].filter(([, v]) => !v.isZero()));
  for (const event of events(ledger).values()) {
    if (yearOf(event.on) !== year) continue;
    summary.taxWithheld = summary.taxWithheld.add(event.tax_withheld);
    if (event.kind === EventKind.DISTRIBUTION) {
      summary.investmentIncome = summary.investmentIncome.add(event.gross !== null ? event.gross : (event.net ?? ZERO));
    }
    if (event.kind === EventKind.WITHDRAWAL || event.kind === EventKind.SELL) {
      const gain = realizedGain(event);
      if (gain === null) summary.incompleteEvents += 1;
      else summary.realizedGains = summary.realizedGains.add(gain);
    }
  }
  return summary;
}
