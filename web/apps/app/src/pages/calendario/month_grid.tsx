/**
 * The month by day (desktop's grid of days): a day with entries is a button that shows them in the list,
 * with the amount due, the count and, when something is late, the word. Under 640 px the page shows a list
 * of days instead (`DayList`).
 */
import { formatBrl, dom, type IsoDate, type YearMonth } from "@opesvault/domain";
import { cn, useMotionPreset } from "@opesvault/ui";
import { motion } from "motion/react";
import { WEEKDAYS, WEEKDAY_NAMES, type DayCell } from "./rows.ts";

const plain = (value: Parameters<typeof formatBrl>[0]) => formatBrl(value).replace("R$ ", "");

/** What a day says to a screen reader. */
export function dayLabel(cell: DayCell, monthName: string): string {
  const count = cell.events.length;
  const parts = [`${cell.day} de ${monthName}`];
  if (cell.isToday) parts.push("hoje");
  parts.push(`${count} ${count === 1 ? "vencimento" : "vencimentos"}`);
  if (cell.outflow) parts.push(`${formatBrl(cell.outflow)} a pagar`);
  if (cell.late) parts.push("com atraso");
  return parts.join(", ");
}

export interface MonthGridProps {
  month: YearMonth;
  monthName: string;
  weeks: readonly (readonly (DayCell | null)[])[];
  selected: IsoDate | null;
  onSelect: (date: IsoDate | null) => void;
}

export function MonthGrid({ month, monthName, weeks, selected, onSelect }: MonthGridProps) {
  const preset = useMotionPreset();
  return (
    <motion.div
      key={`${month.year}-${month.month}`}
      initial={preset.enter.initial}
      animate={preset.enter.animate}
      transition={preset.enter.transition}
      className="min-w-0"
    >
      <table className="w-full table-fixed border-separate border-spacing-1" aria-label="Dias do mês">
        <caption className="sr-only">Dias de {monthName}, com os vencimentos de cada um</caption>
        <thead>
          <tr>
            {WEEKDAYS.map((name, index) => (
              <th
                key={name}
                scope="col"
                abbr={WEEKDAY_NAMES[index] as string}
                className="pb-1 pl-2 text-left text-caption font-semibold text-secondary"
              >
                {name}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {weeks.map((week, row) => (
            <tr key={row}>
              {week.map((cell, column) => (
                <td key={column} className="h-[88px] p-0 align-top">
                  {cell ? (
                    <Day
                      cell={cell}
                      monthName={monthName}
                      selected={selected === cell.date}
                      onSelect={() => onSelect(selected === cell.date ? null : cell.date)}
                    />
                  ) : null}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </motion.div>
  );
}

function Day({
  cell,
  monthName,
  selected,
  onSelect,
}: {
  cell: DayCell;
  monthName: string;
  selected: boolean;
  onSelect: () => void;
}) {
  const body = (
    <>
      <span className="flex items-center justify-between gap-1">
        <span
          className={cn(
            "text-body",
            cell.isToday
              ? "grid size-6 place-items-center rounded-full bg-accent-fill font-semibold text-accent-text"
              : cell.events.length
                ? "font-semibold text-text"
                : "text-secondary",
          )}
        >
          {cell.day}
        </span>
        {cell.events.length > 1 ? (
          <span className="rounded-full bg-selection-inactive px-1.5 text-caption text-text">{cell.events.length}</span>
        ) : null}
      </span>
      {cell.events.length ? (
        <span className="mt-1 block truncate text-caption font-semibold tabular-nums text-text">
          {cell.outflow ? plain(cell.outflow) : `${cell.events.length} item(ns)`}
        </span>
      ) : null}
      {cell.events[0] ? (
        <span className="block truncate text-caption text-secondary">{cell.events[0].title}</span>
      ) : null}
      {cell.late ? <span className="block text-caption font-semibold text-warning">Atrasado</span> : null}
    </>
  );
  const base = "block h-full w-full rounded-lg border p-1.5 text-left";
  if (!cell.events.length) {
    return <div className={cn(base, "border-transparent")}>{body}</div>;
  }
  return (
    <button
      type="button"
      aria-pressed={selected}
      aria-label={dayLabel(cell, monthName)}
      onClick={onSelect}
      title={cell.events
        .map((e) => `${e.title} · ${formatBrl(e.amount.abs())} · ${dom.agenda.STATE_LABELS[e.state]}`)
        .join("\n")}
      className={cn(
        base,
        "transition-colors duration-[var(--ov-duration-fast)]",
        selected
          ? "border-accent bg-accent-soft"
          : "border-separator bg-alternate hover:border-separator-strong hover:bg-hover",
      )}
    >
      {body}
    </button>
  );
}
