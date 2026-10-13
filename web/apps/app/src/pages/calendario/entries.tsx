/**
 * The entries of the month in words: the state of each one (never by color alone), the table of the wide
 * layouts and the list of days of the phone's. A bill or installment is paid and a forecast linked right here
 * (`actions.tsx`); every entry also opens the screen where it lives.
 */
import { dom, formatBrl, formatDateBr, type IsoDate } from "@opesvault/domain";
import {
  Badge,
  Button,
  DataTable,
  useMotionPreset,
  type BadgeTone,
  type DataColumn,
  type MenuEntry,
} from "@opesvault/ui";
import { AnimatePresence, motion } from "motion/react";
import type { Link } from "../../data/links.ts";
import { eventLink } from "../../data/links.ts";
import { KIND_LABELS, dayTitle } from "./rows.ts";
import { cents } from "../../data/money.ts";
import { EditButton } from "../../components/list_parts.tsx";
import { lockEntries } from "../../data/read_only.ts";
import { pageById } from "../../pages.tsx";
import type { EntryAction } from "./actions.tsx";

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
  /** Paying or linking it right here; null when it only opens (resolved, or an investment's maturity). */
  action: EntryAction | null;
}

export function entryRows(
  events: readonly AgendaEvent[],
  actionOf: (event: AgendaEvent) => EntryAction | null = () => null,
): EntryRow[] {
  return events.map((event, index) => ({ id: String(index), event, link: eventLink(event), action: actionOf(event) }));
}

/** The screen an entry lives on, without the action (the action is done here): "Abrir em Contas e cartões". */
export function openLabel(row: EntryRow): string {
  return `Abrir em ${pageById(row.link.page)?.title ?? "outra tela"}`;
}
const plainLink = (link: Link): Link => ({
  page: link.page,
  ...(link.ref ? { ref: link.ref } : {}),
  label: link.label,
});

/** The entry's own button: "Pagar…" or "Vincular…" here, or "Abrir" on its screen, named by what it is about. */
function EntryButton({ row, onOpen }: { row: EntryRow; onOpen: (link: Link) => void }) {
  if (row.action) {
    const action = row.action;
    return (
      <EditButton
        size="sm"
        variant="secondary"
        aria-label={`${action.label}: ${row.event.title}`}
        onClick={(event) => {
          event.stopPropagation();
          action.run();
        }}
      >
        {action.label}
      </EditButton>
    );
  }
  return (
    <Button
      size="sm"
      variant="secondary"
      aria-label={`Abrir: ${row.event.title}`}
      onClick={(event) => {
        event.stopPropagation();
        onOpen(row.link);
      }}
    >
      Abrir
    </Button>
  );
}

/** A row's context menu: its action here, then its screen. */
function entryMenu(row: EntryRow, onOpen: (link: Link) => void, locked: boolean): MenuEntry[] {
  const open: MenuEntry = { id: "open", label: openLabel(row), onSelect: () => onOpen(plainLink(row.link)) };
  if (!row.action) return [open];
  const action = row.action;
  return lockEntries([{ id: "act", label: action.label, onSelect: action.run }, open], locked, ["open"]);
}

export interface EntriesTableProps {
  rows: readonly EntryRow[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onOpen: (link: Link) => void;
  /** The project is read-only: paying and linking are disabled. */
  locked?: boolean;
  /** What an empty list says. */
  emptyText?: string;
}

/**
 * "Vencimentos do mês": date, description, kind, amount and state; its button pays or links here, Enter or
 * double click opens its screen, and its menu has both.
 */
export function EntriesTable({
  rows,
  selectedId,
  onSelect,
  onOpen,
  locked = false,
  emptyText = "Nenhum vencimento neste período.",
}: EntriesTableProps) {
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
      header: "Ação",
      cell: (r) => <EntryButton row={r} onOpen={onOpen} />,
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
      rowMenu={(row) => entryMenu(row, onOpen, locked)}
      rowMenuLabel={(row) => `Ações de ${row.event.title}`}
      onActivate={(id) => {
        const row = rows.find((r) => r.id === id);
        if (row) onOpen(row.link);
      }}
      height="min(56dvh, 520px)"
      cardTitle={(row) => row.event.title}
      empty={<p className="px-4 py-6 text-center text-body text-secondary">{emptyText}</p>}
    />
  );
}

export interface DayListProps {
  rows: readonly EntryRow[];
  monthName: string;
  today: IsoDate;
  onOpen: (link: Link) => void;
  /** What an empty list says. */
  emptyText?: string;
}

/** The phone's calendar: the days that have entries, each with its entries, their action and their screen. */
export function DayList({ rows, monthName, today, onOpen, emptyText }: DayListProps) {
  const preset = useMotionPreset();
  const days: { date: IsoDate; rows: EntryRow[] }[] = [];
  for (const row of rows) {
    const last = days.at(-1);
    if (last && last.date === row.event.on) last.rows.push(row);
    else days.push({ date: row.event.on, rows: [row] });
  }
  if (!days.length) {
    return (
      <p className="py-6 text-center text-body text-secondary">{emptyText ?? `Nenhum vencimento em ${monthName}.`}</p>
    );
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
                  <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
                    <StateBadge state={row.event.state} />
                    <span className="flex items-center gap-1">
                      {row.action ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          aria-label={`${openLabel(row)}: ${row.event.title}`}
                          onClick={() => onOpen(plainLink(row.link))}
                        >
                          Abrir
                        </Button>
                      ) : null}
                      <EntryButton row={row} onOpen={onOpen} />
                    </span>
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
