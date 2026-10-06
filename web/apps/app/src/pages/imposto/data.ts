/**
 * Everything the Imposto de renda page shows for one year and one declarant, read from the domain in one go
 * (desktop `TaxPage.refresh`). Rates, tables and limits are the person's: when they were not informed the
 * numbers that depend on them are unknown (`null`), with their reason, never zero.
 */
import { Dec, dom, tax, type Id, type IsoDate, type Ledger } from "@opesvault/domain";

export interface YearData {
  issues: tax.issues.Issue[];
  docs: tax.checklist.Expected[];
  income: tax.declaration.Income;
  payments: tax.declaration.PaymentRow[];
  assets: tax.declaration.AssetRow[];
  debts: tax.declaration.DebtRow[];
  months: tax.variableIncome.MonthResult[];
  carried: Map<tax.model.Bucket, Dec>;
  comparison: tax.simulation.Comparison;
  reports: tax.model.IncomeReport[];
  /** IRRF on salaries and thirteenth salaries. */
  withheld: Dec;
  /** What the person already recorded as deductions, summed. */
  deductions: Dec;
  /** Pending items that need fixing before the return. */
  urgent: number;
  /** The year has something to show (otherwise the page shows its empty state). */
  hasAny: boolean;
}

export function yearData(ledger: Ledger, year: number, declarant: Id | null, today: IsoDate): YearData {
  const people = tax.records.peopleOf(ledger, declarant);
  const issues = tax.issues.issues(ledger, year, declarant, today);
  const income = tax.declaration.income(ledger, year, people);
  const payments = tax.declaration.payments(ledger, year, people);
  const assets = tax.declaration.assets(ledger, year, people);
  const months = tax.variableIncome.months(ledger, year, people);
  const comparison = tax.simulation.compare(ledger, year, declarant);
  return {
    issues,
    docs: tax.checklist.expected(ledger, year, people),
    income,
    payments,
    assets,
    debts: tax.declaration.debts(ledger, year, people),
    months,
    carried: tax.variableIncome.carriedLoss(ledger, year, people),
    comparison,
    reports: tax.records.reportsOf(ledger, year),
    withheld: Dec.sum(
      income.taxable.map((r) => r.withheld.add(r.thirteenth_withheld)),
      Dec.from(0),
    ),
    deductions: Dec.sum([...comparison.deductions.values()], Dec.from(0)),
    urgent: issues.filter((i) => i.severity === dom.alerts.Severity.URGENT).length,
    hasAny: Boolean(
      income.taxable.length ||
      income.other.length ||
      payments.length ||
      assets.length ||
      months.length ||
      issues.length,
    ),
  };
}

/** The members who file a return (Select options come from these), by name. */
export function declarantChoices(ledger: Ledger): { id: Id; name: string }[] {
  return tax.records.declarants(ledger).map((id) => ({ id, name: ledger.members.get(id)?.name ?? "?" }));
}

/** Member id to name for the sheets ("—" when none). */
export const namesOf = (ledger: Ledger) => (id: Id | null) => (id ? (ledger.members.get(id)?.name ?? "—") : "—");
