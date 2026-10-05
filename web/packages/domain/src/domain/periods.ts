/**
 * Monthly closing (RF-13, docs/04 §7): a state over the continuous ledger, not a separate file.
 * Port of `domain/periods.py`.
 */
import { z } from "zod";

import { nowInstant, ymEq, ymFirstDay, ymLastDay, ymOf, ymStr, type YearMonth } from "../lib/dates.ts";
import { zDec, zInstant, zYearMonth } from "../lib/schema.ts";
import { ItemStatus } from "../importing/model.ts";
import { items } from "../importing/store.ts";
import * as queries from "./queries.ts";
import { DomainError, Ledger } from "./ledger.ts";
import { cashDate, competence, type Operation, zEntityId } from "./model.ts";
import { ForecastStatus, forecasts } from "./recurrence.ts";

export const PeriodSummarySchema = z.strictObject({
  cash_in: zDec,
  cash_out: zDec,
  income: zDec,
  expense: zDec,
  net_worth: zDec,
});
export type PeriodSummary = Readonly<z.output<typeof PeriodSummarySchema>>;

export const PeriodCloseSchema = z.strictObject({
  id: zEntityId,
  month: zYearMonth,
  closed: z.boolean(),
  closed_at: zInstant,
  summary: PeriodSummarySchema,
  pending_note: z.string().max(1000).nullable().default(null),
  reopen_reasons: z.array(z.string()).readonly().default([]),
});
export type PeriodClose = Readonly<z.output<typeof PeriodCloseSchema>>;

Ledger.registerKind("period_close", PeriodCloseSchema);

export function closes(ledger: Ledger) {
  return ledger.entities<PeriodClose>("period_close");
}

export function period(ledger: Ledger, month: YearMonth): PeriodClose | null {
  for (const p of closes(ledger).values()) if (ymEq(p.month, month)) return p;
  return null;
}

export function isClosed(ledger: Ledger, month: YearMonth | null): boolean {
  if (month === null) return false;
  const found = period(ledger, month);
  return found !== null && found.closed;
}

/**
 * The competence month and the cash month of an operation, without repeats. Python returned a
 * set, whose order (and so which closed month an error names first) is not defined; here the
 * competence month comes first.
 */
export function monthsOf(op: Operation): YearMonth[] {
  const months: YearMonth[] = [];
  const comp = competence(op);
  if (comp !== null) months.push(comp);
  const cd = cashDate(op);
  if (cd !== null) {
    const m = ymOf(cd);
    if (!months.some((x) => ymEq(x, m))) months.push(m);
  }
  return months;
}

/** Relevant pending matters shown before closing (docs/01 §3 revisão mensal). */
export function pendingItems(ledger: Ledger, month: YearMonth): string[] {
  const notes: string[] = [];
  const openItems = [...items(ledger).values()].filter(
    (i) =>
      (i.status === ItemStatus.READY || i.status === ItemStatus.NEEDS_REVIEW || i.status === ItemStatus.DUPLICATE) &&
      i.occurred_on !== null &&
      ymEq(ymOf(i.occurred_on), month),
  );
  if (openItems.length) notes.push(`${openItems.length} item(ns) importado(s) aguardando revisão`);
  // Pending and late both count, so `today` (Python's date.today()) does not change the result.
  const first = ymFirstDay(month);
  const late = forecasts(ledger, first, ymLastDay(month), first).filter(
    (f) => f.status === ForecastStatus.PENDING || f.status === ForecastStatus.LATE,
  );
  if (late.length) notes.push(`${late.length} previsão(ões) recorrente(s) sem realização`);
  return notes;
}

export function summarize(ledger: Ledger, month: YearMonth): PeriodSummary {
  const flow = queries.cashFlow(ledger, month, month).get(ymStr(month))!;
  const statement = queries.incomeStatement(ledger, month);
  return PeriodSummarySchema.parse({
    cash_in: flow.inflow,
    cash_out: flow.outflow,
    income: statement.totalIncome,
    expense: statement.totalExpense,
    net_worth: queries.netWorth(ledger, ymLastDay(month)).net,
  });
}

export function closeMonth(ledger: Ledger, month: YearMonth, pendingNote: string | null = null): PeriodClose {
  if (isClosed(ledger, month)) throw new DomainError("Mês já fechado.");
  const pending = pendingItems(ledger, month);
  if (pending.length && !(pendingNote && pendingNote.trim())) {
    throw new DomainError("Há pendências: " + pending.join("; ") + ". Resolva ou registre uma justificativa.");
  }
  const current = period(ledger, month);
  const entry = PeriodCloseSchema.parse({
    month,
    closed: true,
    closed_at: nowInstant(),
    summary: summarize(ledger, month),
    pending_note: pendingNote ? pendingNote.trim() : null,
    reopen_reasons: current ? current.reopen_reasons : [],
  });
  if (current !== null) return ledger.put("period_close", { ...entry, id: current.id }, { reason: "novo fechamento" });
  return ledger.put("period_close", entry);
}

export function reopenMonth(ledger: Ledger, month: YearMonth, reason: string): PeriodClose {
  const current = period(ledger, month);
  if (current === null || !current.closed) throw new DomainError("Mês não está fechado.");
  if (!reason.trim()) throw new DomainError("A reabertura exige motivo.");
  const reopened: PeriodClose = {
    ...current,
    closed: false,
    reopen_reasons: [...current.reopen_reasons, reason.trim()],
  };
  return ledger.put("period_close", reopened, { reason });
}

function guardNewOp(ledger: Ledger, op: Operation): void {
  for (const month of monthsOf(op)) {
    if (isClosed(ledger, month)) {
      throw new DomainError(`O mês ${ymStr(month)} está fechado. Reabra-o com um motivo para lançar nele.`);
    }
  }
}

/** Whether two operations have the same figures (Python compared a tuple of fields; decimals by value). */
function sameFigures(a: Operation, b: Operation): boolean {
  return (
    a.kind === b.kind &&
    a.status === b.status &&
    a.currency === b.currency &&
    a.postings.length === b.postings.length &&
    a.postings.every((p, i) => {
      const q = b.postings[i]!;
      return p.account_id === q.account_id && p.amount.eq(q.amount) && p.member_id === q.member_id;
    }) &&
    a.occurred_on === b.occurred_on &&
    a.booked_on === b.booked_on &&
    ymEq(a.accrual_month, b.accrual_month) &&
    a.settled_on === b.settled_on
  );
}

function guardUpdate(ledger: Ledger, before: Operation, after: Operation): void {
  if (sameFigures(before, after)) return; // descriptions, evidence or forecast links do not change any closed figure
  const months = monthsOf(before);
  for (const m of monthsOf(after)) if (!months.some((x) => ymEq(x, m))) months.push(m);
  for (const month of months) {
    if (isClosed(ledger, month)) {
      throw new DomainError(`O mês ${ymStr(month)} está fechado. Reabra-o com um motivo antes de alterar.`);
    }
  }
}

Ledger.addOperationGuard(guardNewOp);
Ledger.addUpdateGuard(guardUpdate);

export function closedFiguresUnchanged(ledger: Ledger, month: YearMonth): boolean {
  const found = period(ledger, month);
  if (found === null) return true;
  const now = summarize(ledger, month);
  const keys = ["cash_in", "cash_out", "income", "expense", "net_worth"] as const;
  return keys.every((k) => now[k].eq(found.summary[k]));
}
