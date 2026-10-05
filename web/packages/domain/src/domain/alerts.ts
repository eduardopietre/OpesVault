/**
 * What needs attention when a project is opened (docs/09 §1.3). Port of `domain/alerts.py`.
 *
 * The app never notifies in the background, so the moment the project is opened is when it must say
 * what is due, late or waiting. Alerts are computed from the ledger, never stored, and never change
 * anything. `today` is explicit everywhere (Python read `date.today()` when it was omitted).
 */
import { reminders } from "../tax/issues.ts";
import { addDays, daysBetween, formatDateBr, type IsoDate, type YearMonth, ymAdd, ymOf } from "../lib/dates.ts";
import { sortedBy } from "../lib/text.ts";
import { maturities, EventState } from "./agenda.ts";
import { divergent } from "./balance_checks.ts";
import { status as budgetStatus } from "./budget.ts";
import { BillStatus, bills } from "./cards.ts";
import type { Ledger } from "./ledger.ts";
import { upcoming } from "./loans.ts";
import { formatBrl } from "./money.ts";
import { suspicions } from "./anomalies.ts";
import { ALERT_DAYS, negativeAhead } from "./projection.ts";
import { ForecastStatus, forecasts } from "./recurrence.ts";
import { commitments } from "./subscriptions.ts";
import { BatchStatus, ItemStatus } from "../importing/model.ts";
import * as store from "../importing/store.ts";

export const HORIZON_DAYS = 7; // "vence nos próximos dias"
export const LOOKBACK_DAYS = 31; // late items older than this are history, not alerts
export const DUPLICATE_SPAN = 3;
export const BACKUP_AGE_DAYS = 30;

export const Severity = {
  URGENT: "urgent", // late or over: something already went wrong
  SOON: "soon", // due within the horizon
  INFO: "info", // waiting for the user (review, near the budget)
} as const;
export type Severity = (typeof Severity)[keyof typeof Severity];

/** Where the user acts on the alert. */
export const Target = {
  ACCOUNTS: "accounts",
  RECURRENCES: "recurrences",
  IMPORT: "import",
  BUDGET: "budget",
  REPORTS: "reports",
  LEDGER: "ledger",
  SETTINGS: "settings",
  TAX: "tax",
  INVESTMENTS: "investments",
} as const;
export type Target = (typeof Target)[keyof typeof Target];

export interface Alert {
  readonly severity: Severity;
  readonly title: string;
  readonly detail: string;
  readonly target: Target;
  readonly dueOn: IsoDate | null;
  /**
   * What the alert is about, so the screen can open it ready to act: (card id, bill month),
   * (rule id, due date), (category id, month) or a batch id. Opaque to this module.
   */
  readonly ref: unknown;
}

function alert(
  severity: Severity,
  title: string,
  detail: string,
  target: Target,
  dueOn: IsoDate | null = null,
  ref: unknown = null,
): Alert {
  return { severity, title, detail, target, dueOn, ref };
}

/** `f"{d:%d/%m}"` */
export function dayMonth(d: IsoDate): string {
  return `${d.slice(8, 10)}/${d.slice(5, 7)}`;
}

export function when(due: IsoDate, today: IsoDate): string {
  const days = daysBetween(due, today);
  if (days === 0) return "vence hoje";
  if (days === 1) return "vence amanhã";
  if (days > 1) return `vence em ${days} dias (${dayMonth(due)})`;
  return `venceu em ${dayMonth(due)}`;
}

export function cardAlerts(ledger: Ledger, today: IsoDate, horizon: number = HORIZON_DAYS): Alert[] {
  const out: Alert[] = [];
  const thisMonth = ymOf(today);
  const months: YearMonth[] = [ymAdd(thisMonth, -1), thisMonth, ymAdd(thisMonth, 1)];
  for (const card of ledger.cards.values()) {
    for (const bill of bills(ledger, card.id, months)) {
      const due = bill.cycle.due;
      if (!bill.total.isPositive() || !bill.remaining.isPositive()) continue;
      if (!(addDays(today, -LOOKBACK_DAYS) <= due && due <= addDays(today, horizon))) continue;
      const state = bill.status(today);
      let severity: Severity;
      let verb: string;
      if ((state === BillStatus.OVERDUE || state === BillStatus.PARTIAL) && due < today) {
        severity = Severity.URGENT;
        verb = "Fatura vencida";
      } else if (state === BillStatus.PAID) {
        continue;
      } else {
        severity = Severity.SOON;
        verb = "Fatura a vencer";
      }
      out.push(
        alert(
          severity,
          `${verb}: ${card.name}`,
          `${when(due, today)} · falta pagar ${formatBrl(bill.remaining)}`,
          Target.ACCOUNTS,
          due,
          [card.id, bill.cycle.month],
        ),
      );
    }
  }
  return out;
}

export function recurrenceAlerts(ledger: Ledger, today: IsoDate, horizon: number = HORIZON_DAYS): Alert[] {
  const out: Alert[] = [];
  const start = addDays(today, -LOOKBACK_DAYS);
  const end = addDays(today, horizon);
  for (const forecast of forecasts(ledger, start, end, today)) {
    const value = formatBrl(forecast.amount.abs());
    if (forecast.status === ForecastStatus.LATE) {
      out.push(
        alert(
          Severity.URGENT,
          `Previsão não realizada: ${forecast.description}`,
          `esperada em ${dayMonth(forecast.dueOn)} · ${value} · vincule ao lançamento ou pule`,
          Target.RECURRENCES,
          forecast.dueOn,
          [forecast.ruleId, forecast.dueOn],
        ),
      );
    } else if (forecast.status === ForecastStatus.PENDING && forecast.dueOn >= today) {
      out.push(
        alert(
          Severity.SOON,
          forecast.amount.isNegative()
            ? `Conta a vencer: ${forecast.description}`
            : `Previsto: ${forecast.description}`,
          `${when(forecast.dueOn, today)} · ${value}`,
          Target.RECURRENCES,
          forecast.dueOn,
          [forecast.ruleId, forecast.dueOn],
        ),
      );
    }
  }
  return out;
}

export function importAlerts(ledger: Ledger): Alert[] {
  const out: Alert[] = [];
  const pending = [...store.items(ledger).values()].filter(
    (i) => i.status === ItemStatus.READY || i.status === ItemStatus.NEEDS_REVIEW,
  );
  if (pending.length) {
    const documents = new Set(pending.map((i) => i.batch_id)).size;
    out.push(
      alert(
        Severity.INFO,
        `${pending.length} item(ns) importado(s) aguardando revisão`,
        `em ${documents} documento(s); só entram nas contas depois de aprovados`,
        Target.IMPORT,
        null,
        pending[0]!.batch_id,
      ),
    );
  }
  const undecided = [...store.batches(ledger).values()].filter(
    (b) => b.status === BatchStatus.AMBIGUOUS || b.status === BatchStatus.UNSUPPORTED,
  );
  if (undecided.length) {
    out.push(
      alert(
        Severity.INFO,
        `${undecided.length} documento(s) sem layout definido`,
        "escolha o layout ou registre os lançamentos manualmente",
        Target.IMPORT,
        null,
        undecided[0]!.id,
      ),
    );
  }
  return out;
}

export function budgetAlerts(ledger: Ledger, today: IsoDate): Alert[] {
  const month = ymOf(today);
  const current = budgetStatus(ledger, month);
  const out = current.over.map((row) =>
    alert(
      Severity.URGENT,
      `Orçamento estourado: ${row.name}`,
      // int(): truncates toward zero
      `gasto ${formatBrl(row.actual)} de ${formatBrl(row.planned)} (${row.used.mul(100).toBigInt().toString()}%)`,
      Target.BUDGET,
      null,
      [row.categoryId, month],
    ),
  );
  for (const row of current.near) {
    out.push(
      alert(
        Severity.INFO,
        `Orçamento quase no limite: ${row.name}`,
        `resta ${formatBrl(row.remaining)} de ${formatBrl(row.planned)}`,
        Target.BUDGET,
        null,
        [row.categoryId, month],
      ),
    );
  }
  return out;
}

export function loanAlerts(ledger: Ledger, today: IsoDate, horizon: number = HORIZON_DAYS): Alert[] {
  const out: Alert[] = [];
  for (const [plan, item] of upcoming(ledger, addDays(today, -LOOKBACK_DAYS), addDays(today, horizon))) {
    const late = item.due < today;
    out.push(
      alert(
        late ? Severity.URGENT : Severity.SOON,
        `${late ? "Parcela vencida" : "Parcela a vencer"}: ${plan.name}`,
        `parcela ${item.number} · ${when(item.due, today)} · ${formatBrl(item.payment)}`,
        Target.ACCOUNTS,
        item.due,
        ["loan", plan.id, item.number],
      ),
    );
  }
  return out;
}

export function projectionAlerts(ledger: Ledger, today: IsoDate): Alert[] {
  const out: Alert[] = [];
  for (const projection of negativeAhead(ledger, today, ALERT_DAYS)) {
    const first = projection.firstNegative;
    const [on, lowest] = projection.lowest;
    const account = ledger.accounts.get(projection.accountId);
    if (first === null || account === undefined) continue;
    out.push(
      alert(
        Severity.SOON,
        `Saldo previsto negativo: ${account.name}`,
        `a partir de ${dayMonth(first)}, chega a ${formatBrl(lowest)} em ${dayMonth(on)}, ` +
          "com faturas, recorrências e parcelas já registradas",
        Target.REPORTS,
        first,
        "projected_balance",
      ),
    );
  }
  return out;
}

export function balanceCheckAlerts(ledger: Ledger): Alert[] {
  return divergent(ledger).map((r) =>
    alert(
      Severity.INFO,
      `Saldo diferente do banco: ${ledger.account(r.check.account_id).name}`,
      `em ${formatDateBr(r.check.on)} o banco mostra ${formatBrl(r.check.informed)} e o aplicativo ` +
        `${formatBrl(r.computed)} (diferença ${formatBrl(r.difference)})`,
      Target.ACCOUNTS,
      null,
      ["check", r.check.account_id],
    ),
  );
}

export function priceAlerts(ledger: Ledger): Alert[] {
  const out: Alert[] = [];
  for (const c of commitments(ledger)) {
    if (!c.priceChanged || c.lastPaid === null) continue;
    out.push(
      alert(
        Severity.INFO,
        `Valor mudou: ${c.rule.description}`,
        `previsto ${formatBrl(c.rule.amount)}, cobrado ${formatBrl(c.lastPaid)}` +
          (c.lastPaidOn ? ` em ${dayMonth(c.lastPaidOn)}` : ""),
        Target.RECURRENCES,
        null,
        ["rule", c.rule.id],
      ),
    );
  }
  return out;
}

export function suspicionAlerts(ledger: Ledger, today: IsoDate): Alert[] {
  return suspicions(ledger, today).map((s) =>
    alert(Severity.INFO, s.title, s.detail + " · no Livro, Ações › Está certo silencia o aviso", Target.LEDGER, s.on, [
      "filter",
      s.accountId,
      [addDays(s.on, -DUPLICATE_SPAN), s.on],
    ]),
  );
}

/** An investment reaching its maturity date: register the redemption or the renewal. */
export function maturityAlerts(ledger: Ledger, today: IsoDate, horizon: number = HORIZON_DAYS): Alert[] {
  const out: Alert[] = [];
  for (const event of maturities(ledger, addDays(today, -LOOKBACK_DAYS), addDays(today, horizon), today)) {
    if (event.state === EventState.DONE) continue;
    const late = event.on < today;
    out.push(
      alert(
        late ? Severity.INFO : Severity.SOON,
        // Python's str.replace replaces every occurrence
        event.title.replaceAll("Vencimento — ", late ? "Investimento venceu: " : "Investimento vence: "),
        `${when(event.on, today)} · registre o resgate ou a renovação`,
        Target.INVESTMENTS,
        event.on,
        event.ref,
      ),
    );
  }
  return out;
}

/** DARFs of the month (renda variável, Carnê-Leão) and, in the return's season, what is pending. */
export function taxAlerts(ledger: Ledger, today: IsoDate, horizon: number = HORIZON_DAYS): Alert[] {
  return reminders(ledger, today, horizon).map(([severity, title, detail, due, ref]) =>
    alert(severity, title, detail, Target.TAX, Array.isArray(ref) && ref[0] === "year" ? null : due, ref),
  );
}

/** Said when the newest backup is old or missing. The caller reads the folder (not the domain). */
export function backupAlert(lastBackup: IsoDate | null, today: IsoDate, configured: boolean): Alert[] {
  if (lastBackup === null) {
    const detail = configured
      ? "nenhum backup encontrado na pasta de backups"
      : "defina uma pasta de backups em Configurações ou use Cofre › Fazer backup agora";
    return [alert(Severity.INFO, "Faça um backup do cofre", detail, Target.SETTINGS)];
  }
  const age = daysBetween(today, lastBackup);
  if (age < BACKUP_AGE_DAYS) return [];
  return [
    alert(
      Severity.INFO,
      `Último backup há ${age} dias`,
      `de ${formatDateBr(lastBackup)}; faça um novo e confira com Cofre › Verificar backup`,
      Target.SETTINGS,
    ),
  ];
}

const ORDER: Readonly<Record<Severity, number>> = { urgent: 0, soon: 1, info: 2 };

/** Most urgent first; within a level, the nearest date first. */
export function alerts(ledger: Ledger, today: IsoDate, horizon: number = HORIZON_DAYS): Alert[] {
  const found = [
    ...cardAlerts(ledger, today, horizon),
    ...recurrenceAlerts(ledger, today, horizon),
    ...loanAlerts(ledger, today, horizon),
    ...projectionAlerts(ledger, today),
    ...budgetAlerts(ledger, today),
    ...balanceCheckAlerts(ledger),
    ...priceAlerts(ledger),
    ...suspicionAlerts(ledger, today),
    ...importAlerts(ledger),
    ...taxAlerts(ledger, today, horizon),
    ...maturityAlerts(ledger, today, horizon),
  ];
  return sortedBy(found, (a) => [ORDER[a.severity], a.dueOn ?? "9999-12-31", a.title]);
}
