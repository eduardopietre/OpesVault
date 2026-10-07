/** Small wording helpers the pages share. */
import { dom, type YearMonth } from "@opesvault/domain";
import { formatMonth, type BadgeTone } from "@opesvault/ui";

/** How many, with the right plural ("1 conta", "2 contas"). */
export function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** The first letter in capitals ("outubro de 2026" → "Outubro de 2026"). */
export function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** "Outubro de 2026": a month as a title. */
export function monthLabel(month: YearMonth): string {
  return capitalize(formatMonth(month));
}

/** The badge tone of a notice's severity (the words differ by page; the tone does not). */
export const SEVERITY_TONES: Readonly<Record<dom.alerts.Severity, BadgeTone>> = {
  urgent: "negative",
  soon: "warning",
  info: "neutral",
};
