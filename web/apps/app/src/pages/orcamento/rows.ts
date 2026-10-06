/**
 * Orçamento without React: labels, the percentage of use, the summary line and the reveal reference.
 * (The desktop keeps this in the page; here it is testable on its own, like `pages/tax/rows.py`.)
 */
import { Dec, ymParse, ymStr, type dom, type YearMonth } from "@opesvault/domain";

export type BudgetState = dom.budget.BudgetRow["state"];
type BudgetStatus = dom.budget.BudgetStatus;

export const STATE_LABELS: Record<BudgetState, string> = {
  ok: "Dentro",
  near: "Perto do limite",
  over: "Estourado",
};

export const STATE_TONES = { ok: "positive", near: "warning", over: "negative" } as const;

/** 0.8237 as "82%": the same rounding the desktop shows (half away from zero). */
export function usedPercent(used: Dec): string {
  return `${used.mul(100).quantize("1", "ROUND_HALF_UP").toFixed()}%`;
}

/** Exact cents for sorting a money column. */
export function cents(value: Dec): bigint {
  return BigInt(value.quantize("0.01", "ROUND_HALF_UP").toFixed().replace(".", ""));
}

/** How many categories, with the right plural ("1 categoria estourada", "2 categorias estouradas"). */
export function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** The line under the title: how the month is going, in words. */
export function summaryLine(status: BudgetStatus): string {
  const parts: string[] = [];
  const over = status.over.length;
  const near = status.near.length;
  if (over) parts.push(plural(over, "categoria estourada", "categorias estouradas"));
  if (near) parts.push(`${near} perto do limite`);
  if (status.rows.length && !parts.length) parts.push("Todas as categorias dentro do planejado");
  return parts.join(" · ");
}

export interface CategoryRef {
  categoryId: string;
  /** Only when the reference names a month. */
  month: YearMonth | null;
}

/** The reference other screens use for a category: "categoria:<id>" or "categoria:<id>:<YYYY-MM>". */
export function categoryRef(categoryId: string, month?: YearMonth): string {
  return month ? `categoria:${categoryId}:${ymStr(month)}` : `categoria:${categoryId}`;
}

export function parseCategoryRef(ref: string | undefined): CategoryRef | null {
  if (!ref) return null;
  const match = /^categoria:([^:]+)(?::(\d{4}-(?:0[1-9]|1[0-2])))?$/.exec(ref);
  if (!match?.[1]) return null;
  return { categoryId: match[1], month: match[2] ? ymParse(match[2]) : null };
}
