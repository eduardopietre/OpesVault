/**
 * The entries of the month in words: the state of each one (never by color alone), the table of the wide
 * layouts and the list of days of the phone's.
 */
import { dom, formatBrl, formatDateBr, type IsoDate } from "@opesvault/domain";
import { Badge, Button, DataTable, useMotionPreset, type BadgeTone, type DataColumn } from "@opesvault/ui";
import { AnimatePresence, motion } from "motion/react";
import type { Link } from "../../data/links.ts";
import { eventLink } from "../../data/links.ts";
import { KIND_LABELS, dayTitle } from "./rows.ts";
import { cents } from "../../data/money.ts";

type AgendaEvent = dom.agenda.AgendaEvent;

const STATE_TONES: Readonly<Record<dom.agenda.EventState, BadgeTone>> = {
  done: "positive",
  pending: "neutral",
  late: "negative",
};

export function StateBadge({ state }: { state: dom.agenda.EventState }) {
  return <Badge tone={STATE_TONES[state]}>{dom.agenda.STATE_LABELS[state]}</Badge>;
}

export interface EntryRow {
  id: string;
  event: AgendaEvent;
  link: Link;
}

export function entryRows(events: readonly AgendaEvent[]): EntryRow[] {
  return events.map((event, index) => ({ id: String(index), event, link: eventLink(event) }));
}

/** The open button of an entry: "Pagar…", "Vincular…" or "Abrir", named by what it is about. */
function OpenButton({ row, onOpen }: { row: EntryRow; onOpen: (link: Link) => void }) {
  return (
    <Button
      size="sm"
      variant="secondary"
      aria-label={`${row.link.label}: ${row.event.title}`}
      onClick={(event) => {
        event.stopPropagation();
        onOpen(row.link);
      }}
    >
      {row.link.label}
    </Button>
  );
}

export interface EntriesTableProps {
  rows: readonly EntryRow[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onOpen: (link: Link) => void;
}

/** "Vencimentos do mês": date, description, kind, amount and state; Enter or double click opens it. */
export function EntriesTable({ rows, selectedId, onSelect, onOpen }: EntriesTableProps) {
  const columns: DataColumn<EntryRow>[] = [
    { id: "data", header: "Data", cell: (r) => formatDateBr(r.event.on), sortValue: (r) => r.event.on, width: 112 },
    {
      id: "descricao",
      header: "Descrição",
      cell: (r) => <span title={r.event.title}>{r.event.title}</span>,
      sortValue: (r) => r.event.title,
      width: 180,
      grow: 1,
    },
    {
      id: "tipo",
      header: "Tipo",
      cell: (r) => KIND_LABELS[r.event.kind] ?? r.event.kind,
      sortValue: (r) => r.event.kind,
      priority: 2,
      width: 120,
    },
    {
      id: "valor",
      header: "Valor",
      cell: (r) => formatBrl(r.event.amount.abs()),
      sortValue: (r) => cents(r.event.amount.abs()),
      align: "end",
      width: 120,
    },
    {
      id: "situacao",
      header: "Situação",
      cell: (r) => <StateBadge state={r.event.state} />,
      sortValue: (r) => r.event.state,
      width: 110,
    },
    {
      id: "acao",
      header: "Abrir",
      cell: (r) => <OpenButton row={r} onOpen={onOpen} />,
      priority: 2,
      width: 112,
    },
  ];
  return (
    <DataTable
      label="Vencimentos"
      rows={rows}
      columns={columns}
      getRowId={(row) => row.id}
      selectedId={selectedId}
      onSelect={onSelect}
      onActivate={(id) => {
        const row = rows.find((r) => r.id === id);
        if (row) onOpen(row.link);
      }}
      height="min(56dvh, 520px)"
      cardTitle={(row) => row.event.title}
      empty={<p className="px-4 py-6 text-center text-body text-secondary">Nenhum vencimento neste período.</p>}
    />
  );
}

export interface DayListProps {
  rows: readonly EntryRow[];
  monthName: string;
  today: IsoDate;
  onOpen: (link: Link) => void;
}

/** The phone's calendar: the days that have entries, each with its entries and their action. */
export function DayList({ rows, monthName, today, onOpen }: DayListProps) {
  const preset = useMotionPreset();
  const days: { date: IsoDate; rows: EntryRow[] }[] = [];
  for (const row of rows) {
    const last = days.at(-1);
    if (last && last.date === row.event.on) last.rows.push(row);
    else days.push({ date: row.event.on, rows: [row] });
  }
  if (!days.length) {
    return <p className="py-6 text-center text-body text-secondary">Nenhum vencimento em {monthName}.</p>;
  }
  return (
    <ol aria-label="Dias com vencimentos" className="flex flex-col gap-5">
      <AnimatePresence initial={false}>
        {days.map((day, index) => (
          <motion.li
            key={day.date}
            initial={preset.enter.initial}
            animate={preset.enter.animate}
            exit={preset.enter.exit}
            transition={{ ...preset.enter.transition, delay: preset.reduce ? 0 : Math.min(index, 5) * 0.03 }}
          >
            <h3 className="mb-2 flex items-center gap-2 text-body font-semibold text-text">
              {dayTitle(day.date, monthName.split(" de ")[0] ?? monthName)}
              {day.date === today ? <Badge tone="accent">hoje</Badge> : null}
            </h3>
            <ul className="flex flex-col gap-2">
              {day.rows.map((row) => (
                <li key={row.id} className="rounded-lg border border-separator bg-raised px-3 py-2.5 shadow-sm">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-body font-medium text-text [overflow-wrap:anywhere]">{row.event.title}</p>
                      <p className="mt-0.5 text-caption text-secondary">
                        {KIND_LABELS[row.event.kind] ?? row.event.kind}
                      </p>
                    </div>
                    <span className="shrink-0 text-body font-semibold tabular-nums">
                      {formatBrl(row.event.amount.abs())}
                    </span>
                  </div>
                  <div className="mt-2 flex items-center justify-between gap-2">
                    <StateBadge state={row.event.state} />
                    <OpenButton row={row} onOpen={onOpen} />
                  </div>
                </li>
              ))}
            </ul>
          </motion.li>
        ))}
      </AnimatePresence>
    </ol>
  );
}
