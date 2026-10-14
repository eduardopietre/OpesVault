/**
 * Recorrências without React (desktop `ui/pages/recurrences_page.py`): labels, the forecast window, the
 * references other pages use to reach a forecast or a rule, and the lines of the summary.
 */
import { addDays, type dom, type IsoDate } from "@opesvault/domain";
import { plural } from "../../data/text.ts";

type Rule = dom.recurrence.RecurrenceRule;
type Frequency = Rule["frequency"];
type ForecastStatus = dom.recurrence.Forecast["status"];

export const FREQUENCY_LABELS: Readonly<Record<Frequency, string>> = {
  monthly: "Mensal",
  yearly: "Anual",
  weekly: "Semanal",
  semimonthly: "Quinzenal",
  quarterly: "Trimestral",
  every_n_months: "A cada N meses",
  last_business_day: "Último dia útil do mês",
};

/** The frequency of one rule in words: "a cada N meses" names its N. */
export function frequencyLabel(rule: Rule): string {
  return rule.frequency === "every_n_months" && rule.interval_months !== null
    ? `A cada ${rule.interval_months} meses`
    : FREQUENCY_LABELS[rule.frequency];
}

export const FORECAST_LABELS: Readonly<Record<ForecastStatus, string>> = {
  pending: "Prevista",
  late: "Atrasada",
  realized: "Realizada",
  skipped: "Pulada",
};

/** From 3 months back to 6 months ahead, as on the desktop (92 and 186 days). */
export const WINDOW_BACK_DAYS = 92;
export const WINDOW_AHEAD_DAYS = 186;

export function forecastWindow(today: IsoDate): [IsoDate, IsoDate] {
  return [addDays(today, -WINDOW_BACK_DAYS), addDays(today, WINDOW_AHEAD_DAYS)];
}

/** The id of a forecast row: the same text a notice or a calendar entry sends ("<ruleId>:<YYYY-MM-DD>"). */
export function forecastId(ruleId: string, dueOn: IsoDate): string {
  return `${ruleId}:${dueOn}`;
}

export type RecurrenceTarget = { kind: "forecast"; ruleId: string; dueOn: IsoDate } | { kind: "rule"; ruleId: string };

const DATE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

/** The `ref` of an incoming link: "<ruleId>:<YYYY-MM-DD>" (a forecast) or "rule:<ruleId>" (a price change). */
export function parseRecurrenceRef(ref: string | undefined): RecurrenceTarget | null {
  if (!ref) return null;
  const parts = ref.split(":");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  if (parts[0] === "rule") return { kind: "rule", ruleId: parts[1] };
  if (!DATE.test(parts[1])) return null;
  return { kind: "forecast", ruleId: parts[0], dueOn: parts[1] as IsoDate };
}

/** The `ref` that leads to a rule. */
export function ruleRef(ruleId: string): string {
  return `rule:${ruleId}`;
}

/**
 * The day column: a weekly rule repeats from its start date and the last business day moves with the
 * calendar, so no day of the month applies; a semimonthly rule has two days, 15 apart.
 */
export function dayLabel(rule: Rule): string {
  if (rule.frequency === "weekly" || rule.frequency === "last_business_day") return "—";
  if (rule.frequency === "semimonthly") {
    return rule.day <= 15 ? `${rule.day} e ${rule.day + 15}` : `${rule.day - 15} e ${rule.day}`;
  }
  return String(rule.day);
}

/** What the charge of a commitment says, in words (the color only reinforces it). */
export function situationLabel(commitment: dom.subscriptions.Commitment): string {
  if (commitment.priceChanged) return "Valor mudou";
  if (commitment.lastPaid === null) return "Sem cobrança vinculada";
  return "Como previsto";
}

/** A stable key for a suggested recurrence (it has no id): the charge it was found in. */
export function candidateKey(candidate: dom.subscriptions.Candidate): string {
  return `${candidate.accountId}|${candidate.categoryId}|${candidate.description}`;
}

/** The line under the title. */
export function summaryLine(rules: readonly Rule[], late: number): string {
  const parts: string[] = [];
  if (rules.length) parts.push(plural(rules.filter((r) => !r.paused).length, "regra ativa", "regras ativas"));
  if (late) parts.push(plural(late, "previsão atrasada", "previsões atrasadas"));
  return parts.join(" · ");
}
