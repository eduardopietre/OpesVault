/**
 * The shared month (docs/16 §3 MonthPicker): the month spelled out, ‹ › of the same size around it and
 * Alt+← / Alt+→. Clicking the month opens a year with its twelve months.
 */
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Popover } from "radix-ui";
import { useState, type KeyboardEvent } from "react";
import { cn } from "../cn.ts";
import { addMonths, formatMonth, monthName, type Month } from "../format.ts";
import { IconButton } from "./Button.tsx";

export interface MonthPickerProps {
  value: Month;
  onChange: (month: Month) => void;
  /** Accessible name of the group ("Mês"). */
  label?: string;
  min?: Month;
  max?: Month;
  className?: string;
}

const index = (m: Month) => m.year * 12 + m.month - 1;

export function MonthPicker({ value, onChange, label = "Mês", min, max, className }: MonthPickerProps) {
  const [open, setOpen] = useState(false);
  const [year, setYear] = useState(value.year);
  const allowed = (m: Month) => (!min || index(m) >= index(min)) && (!max || index(m) <= index(max));
  const step = (delta: number) => {
    const next = addMonths(value, delta);
    if (allowed(next)) onChange(next);
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.altKey && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
      event.preventDefault();
      step(event.key === "ArrowLeft" ? -1 : 1);
    }
  };
  const previous = addMonths(value, -1);
  const next = addMonths(value, 1);
  return (
    <div
      role="group"
      aria-label={label}
      className={cn("inline-flex items-center gap-1", className)}
      onKeyDown={onKeyDown}
    >
      <IconButton
        label="Mês anterior"
        shortcut="Alt+←"
        variant="secondary"
        icon={<ChevronLeft />}
        disabled={!allowed(previous)}
        onClick={() => step(-1)}
      />
      <Popover.Root
        open={open}
        onOpenChange={(state) => {
          setOpen(state);
          if (state) setYear(value.year);
        }}
      >
        <Popover.Trigger asChild>
          <button
            type="button"
            aria-label={`${label}: ${formatMonth(value)}. Escolher outro mês`}
            className="h-8 min-w-[168px] rounded-md border border-separator-strong bg-raised px-3 text-body font-medium text-text shadow-sm first-letter:uppercase hover:bg-hover"
          >
            {formatMonth(value)}
          </button>
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Content
            sideOffset={6}
            collisionPadding={8}
            aria-label="Escolher mês"
            className="z-50 w-[272px] rounded-lg border border-separator bg-raised p-3 shadow-lg data-[state=open]:animate-[ov-menu-in_var(--ov-duration-fast)_var(--ov-ease-enter)]"
          >
            <div className="mb-2 flex items-center justify-between">
              <IconButton label="Ano anterior" size="sm" icon={<ChevronLeft />} onClick={() => setYear(year - 1)} />
              <span className="text-body font-semibold" aria-live="polite">
                {year}
              </span>
              <IconButton label="Próximo ano" size="sm" icon={<ChevronRight />} onClick={() => setYear(year + 1)} />
            </div>
            <div className="grid grid-cols-3 gap-1">
              {Array.from({ length: 12 }, (_, i) => {
                const month = { year, month: i + 1 };
                const current = month.year === value.year && month.month === value.month;
                return (
                  <button
                    key={i}
                    type="button"
                    disabled={!allowed(month)}
                    aria-pressed={current}
                    aria-label={formatMonth(month)}
                    onClick={() => {
                      onChange(month);
                      setOpen(false);
                    }}
                    className={cn(
                      "h-8 rounded-md text-body capitalize disabled:opacity-40",
                      current ? "bg-accent-fill font-semibold text-accent-text" : "text-text hover:bg-hover",
                    )}
                  >
                    {monthName(i + 1).slice(0, 3)}
                  </button>
                );
              })}
            </div>
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
      <IconButton
        label="Próximo mês"
        shortcut="Alt+→"
        variant="secondary"
        icon={<ChevronRight />}
        disabled={!allowed(next)}
        onClick={() => step(1)}
      />
    </div>
  );
}
