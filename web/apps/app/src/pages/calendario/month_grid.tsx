/**
 * The month by day (desktop's grid of days), a keyboard grid (WAI-ARIA grid pattern, as a date picker): one day
 * is in the tab order; the arrows move a day or a week, Home and End go to the start and end of the week,
 * PageUp and PageDown change month (with Shift, year), crossing into the next or previous month when needed;
 * Enter or Space opens the day, showing its entries in the list. A day says the amount due, the count and, when
 * something is late, the word. Under 640 px the page shows a list of days instead (`DayList`).
 */
import { addDays, addMonthsClamped, formatBrl, dom, weekday, type IsoDate, type YearMonth } from "@opesvault/domain";
import { cn, useMotionPreset } from "@opesvault/ui";
import { motion } from "motion/react";
import { useEffect, useId, useRef, type KeyboardEvent } from "react";
import { WEEKDAYS, WEEKDAY_NAMES, type DayCell } from "./rows.ts";
import { plural } from "../../data/text.ts";

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

/** Sunday is the first column. */
const column = (date: IsoDate) => (weekday(date) + 1) % 7;

/** The day a key moves to from `date`, or null for a key the grid does not use. */
export function dayAfterKey(date: IsoDate, key: string, shift = false): IsoDate | null {
  switch (key) {
    case "ArrowLeft":
      return addDays(date, -1);
    case "ArrowRight":
      return addDays(date, 1);
    case "ArrowUp":
      return addDays(date, -7);
    case "ArrowDown":
      return addDays(date, 7);
    case "Home":
      return addDays(date, -column(date));
    case "End":
      return addDays(date, 6 - column(date));
    case "PageUp":
      return addMonthsClamped(date, shift ? -12 : -1);
    case "PageDown":
      return addMonthsClamped(date, shift ? 12 : 1);
    default:
      return null;
  }
}

export interface MonthGridProps {
  month: YearMonth;
  monthName: string;
  weeks: readonly (readonly (DayCell | null)[])[];
  selected: IsoDate | null;
  /** A click toggles the day; Enter or Space opens it. */
  onSelect: (date: IsoDate | null) => void;
  /** The day in the tab order (of this month). */
  focused: IsoDate;
  /** The keyboard moved to a day, perhaps of another month: the page changes month when it must. */
  onMove: (date: IsoDate) => void;
}

export function MonthGrid({ month, monthName, weeks, selected, onSelect, focused, onMove }: MonthGridProps) {
  const preset = useMotionPreset();
  const box = useRef<HTMLDivElement>(null);
  const keysId = useId();
  // Focus follows the keyboard only: a click or a change of month by the picker leaves it where it is.
  const follow = useRef(false);
  useEffect(() => {
    if (!follow.current) return;
    const cell = box.current?.querySelector<HTMLElement>(`[data-date="${focused}"]`);
    if (cell) {
      cell.focus();
      follow.current = false;
    }
  }, [focused, month]);

  const keyDown = (event: KeyboardEvent<HTMLElement>, date: IsoDate) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onSelect(date);
      return;
    }
    const next = dayAfterKey(date, event.key, event.shiftKey);
    if (next === null) return;
    event.preventDefault();
    follow.current = true;
    onMove(next);
  };

  return (
    <div ref={box} className="min-w-0">
      <motion.div
        key={`${month.year}-${month.month}`}
        initial={preset.enter.initial}
        animate={preset.enter.animate}
        transition={preset.enter.transition}
        className="min-w-0"
      >
        <table
          role="grid"
          className="w-full table-fixed border-separate border-spacing-1"
          aria-label="Dias do mês"
          aria-describedby={keysId}
        >
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
                {week.map((cell, index) =>
                  cell ? (
                    <Day
                      key={index}
                      cell={cell}
                      monthName={monthName}
                      selected={selected === cell.date}
                      focusable={focused === cell.date}
                      onSelect={() => onSelect(selected === cell.date ? null : cell.date)}
                      onKeyDown={(event) => keyDown(event, cell.date)}
                    />
                  ) : (
                    <td key={index} role="gridcell" className="h-[88px] p-0" />
                  ),
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </motion.div>
      <p id={keysId} className="sr-only">
        Setas mudam de dia, Home e End vão ao início e ao fim da semana, Page Up e Page Down mudam de mês, Enter mostra
        os vencimentos do dia.
      </p>
    </div>
  );
}

function Day({
  cell,
  monthName,
  selected,
  focusable,
  onSelect,
  onKeyDown,
}: {
  cell: DayCell;
  monthName: string;
  selected: boolean;
  focusable: boolean;
  onSelect: () => void;
  onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
}) {
  const has = cell.events.length > 0;
  return (
    <td
      role="gridcell"
      data-date={cell.date}
      tabIndex={focusable ? 0 : -1}
      aria-selected={selected}
      aria-label={dayLabel(cell, monthName)}
      {...(cell.isToday ? { "aria-current": "date" as const } : {})}
      onClick={onSelect}
      onKeyDown={onKeyDown}
      title={
        has
          ? cell.events
              .map((e) => `${e.title} · ${formatBrl(e.amount.abs())} · ${dom.agenda.STATE_LABELS[e.state]}`)
              .join("\n")
          : undefined
      }
      className={cn(
        "h-[88px] cursor-pointer rounded-lg border p-1.5 text-left align-top",
        "transition-colors duration-[var(--ov-duration-fast)]",
        selected
          ? "border-accent bg-accent-soft"
          : has
            ? "border-separator bg-alternate hover:border-separator-strong hover:bg-hover"
            : "border-transparent hover:bg-hover",
      )}
    >
      <span className="flex items-center justify-between gap-1">
        <span
          className={cn(
            "text-body",
            cell.isToday
              ? "grid size-6 place-items-center rounded-full bg-accent-fill font-semibold text-accent-text"
              : has
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
      {has ? (
        <span className="mt-1 block truncate text-caption font-semibold tabular-nums text-text">
          {cell.outflow ? plain(cell.outflow) : plural(cell.events.length, "item", "itens")}
        </span>
      ) : null}
      {cell.events[0] ? (
        <span className="block truncate text-caption text-secondary">{cell.events[0].title}</span>
      ) : null}
      {cell.late ? <span className="block text-caption font-semibold text-warning">Atrasado</span> : null}
    </td>
  );
}
