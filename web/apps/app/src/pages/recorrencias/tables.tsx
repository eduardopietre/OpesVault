/**
 * The four tables of Recorrências: rules, forecasts, subscriptions and fixed bills, and the charges that
 * look recurring. A state is always a word with a shape (a badge), never a color alone.
 */
import { formatBrl, formatDateBr, type dom } from "@opesvault/domain";
import { Badge, ElidedText, type BadgeTone, type DataColumn } from "@opesvault/ui";
import { CircleAlert, CircleCheck, CircleDashed, SkipForward, TriangleAlert } from "lucide-react";
import type { ReactNode } from "react";
import { cents } from "../orcamento/rows.ts";
import { FORECAST_LABELS, FREQUENCY_LABELS, dayLabel, situationLabel } from "./rows.ts";

type Rule = dom.recurrence.RecurrenceRule;
type Forecast = dom.recurrence.Forecast;
type Commitment = dom.subscriptions.Commitment;
type Candidate = dom.subscriptions.Candidate;

const FORECAST_TONES: Readonly<Record<Forecast["status"], BadgeTone>> = {
  pending: "neutral",
  late: "warning",
  realized: "positive",
  skipped: "neutral",
};

const FORECAST_ICONS: Readonly<Record<Forecast["status"], ReactNode>> = {
  pending: <CircleDashed aria-hidden="true" className="size-3.5" />,
  late: <TriangleAlert aria-hidden="true" className="size-3.5" />,
  realized: <CircleCheck aria-hidden="true" className="size-3.5" />,
  skipped: <SkipForward aria-hidden="true" className="size-3.5" />,
};

function State({ tone, icon, children }: { tone: BadgeTone; icon: ReactNode; children: string }) {
  return (
    <Badge tone={tone} className="gap-1 px-2">
      {icon}
      {children}
    </Badge>
  );
}

export const description = (value: string) => <ElidedText>{value}</ElidedText>;

export const RULE_COLUMNS: DataColumn<Rule>[] = [
  {
    id: "descricao",
    header: "Descrição",
    cell: (r) => description(r.description),
    sortValue: (r) => r.description,
    width: 150,
    grow: 2,
  },
  {
    id: "valor",
    header: "Valor",
    cell: (r) => formatBrl(r.amount),
    sortValue: (r) => cents(r.amount),
    align: "end",
    width: 110,
  },
  {
    id: "frequencia",
    header: "Frequência",
    cell: (r) => FREQUENCY_LABELS[r.frequency],
    sortValue: (r) => FREQUENCY_LABELS[r.frequency],
    width: 100,
    priority: 2,
  },
  { id: "dia", header: "Dia", cell: (r) => dayLabel(r), align: "end", width: 56, priority: 2 },
  {
    id: "situacao",
    header: "Situação",
    cell: (r) =>
      r.paused ? (
        <State tone="neutral" icon={<CircleDashed aria-hidden="true" className="size-3.5" />}>
          Pausada
        </State>
      ) : (
        <State tone="positive" icon={<CircleCheck aria-hidden="true" className="size-3.5" />}>
          Ativa
        </State>
      ),
    sortValue: (r) => (r.paused ? "Pausada" : "Ativa"),
    width: 110,
  },
];

export const FORECAST_COLUMNS: DataColumn<Forecast>[] = [
  { id: "data", header: "Data", cell: (f) => formatDateBr(f.dueOn), sortValue: (f) => f.dueOn, width: 104 },
  {
    id: "descricao",
    header: "Descrição",
    cell: (f) => description(f.description),
    sortValue: (f) => f.description,
    width: 140,
    grow: 2,
  },
  {
    id: "valor",
    header: "Valor",
    cell: (f) => formatBrl(f.amount),
    sortValue: (f) => cents(f.amount),
    align: "end",
    width: 120,
  },
  {
    id: "situacao",
    header: "Situação",
    cell: (f) => (
      <State tone={FORECAST_TONES[f.status]} icon={FORECAST_ICONS[f.status]}>
        {FORECAST_LABELS[f.status]}
      </State>
    ),
    sortValue: (f) => FORECAST_LABELS[f.status],
    width: 120,
  },
];

export const COMMITMENT_COLUMNS: DataColumn<Commitment>[] = [
  {
    id: "descricao",
    header: "Descrição",
    cell: (c) => description(c.rule.description),
    sortValue: (c) => c.rule.description,
    width: 150,
    grow: 2,
  },
  {
    id: "valor",
    header: "Valor",
    cell: (c) => formatBrl(c.rule.amount),
    sortValue: (c) => cents(c.rule.amount),
    align: "end",
    width: 110,
  },
  {
    id: "frequencia",
    header: "Frequência",
    cell: (c) => FREQUENCY_LABELS[c.rule.frequency],
    sortValue: (c) => FREQUENCY_LABELS[c.rule.frequency],
    width: 100,
    priority: 2,
  },
  {
    id: "ano",
    header: "Por ano",
    cell: (c) => formatBrl(c.perYear),
    sortValue: (c) => cents(c.perYear),
    align: "end",
    width: 120,
  },
  {
    id: "ultima",
    header: "Última cobrança",
    cell: (c) =>
      c.lastPaid !== null && c.lastPaidOn !== null ? `${formatBrl(c.lastPaid)} em ${formatDateBr(c.lastPaidOn)}` : "—",
    sortValue: (c) => c.lastPaidOn ?? "",
    width: 220,
    grow: 1,
    priority: 3,
  },
  {
    id: "situacao",
    header: "Situação",
    cell: (c) =>
      c.priceChanged ? (
        <State tone="warning" icon={<CircleAlert aria-hidden="true" className="size-3.5" />}>
          {situationLabel(c)}
        </State>
      ) : (
        <span className="text-secondary">{situationLabel(c)}</span>
      ),
    sortValue: (c) => situationLabel(c),
    width: 190,
    grow: 1,
  },
];

export const CANDIDATE_COLUMNS: DataColumn<Candidate>[] = [
  {
    id: "descricao",
    header: "Descrição",
    cell: (c) => description(c.description),
    sortValue: (c) => c.description,
    width: 150,
    grow: 2,
  },
  {
    id: "valor",
    header: "Valor",
    cell: (c) => formatBrl(c.amount),
    sortValue: (c) => cents(c.amount),
    align: "end",
    width: 110,
  },
  {
    id: "dia",
    header: "Dia",
    cell: (c) => String(c.day),
    sortValue: (c) => c.day,
    align: "end",
    width: 56,
    priority: 2,
  },
  {
    id: "meses",
    header: "Meses seguidos",
    cell: (c) => String(c.months),
    sortValue: (c) => c.months,
    align: "end",
    width: 130,
    priority: 2,
  },
  { id: "ultima", header: "Última", cell: (c) => formatDateBr(c.lastOn), sortValue: (c) => c.lastOn, width: 104 },
];
