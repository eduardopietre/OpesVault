/**
 * The list of reports (the desktop's master list): one button per report, the open one marked with
 * `aria-current` and a bar, not only by color. Arrow keys move between them.
 */
import { cn } from "@opesvault/ui";
import { useRef, type KeyboardEvent } from "react";
import type { ReportKey } from "./reports.ts";

export interface ReportListProps {
  reports: readonly { key: ReportKey; label: string }[];
  current: ReportKey;
  onChoose: (key: ReportKey) => void;
}

export function ReportList({ reports, current, onChoose }: ReportListProps) {
  const list = useRef<HTMLUListElement>(null);
  const move = (event: KeyboardEvent<HTMLUListElement>) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const buttons = [...(list.current?.querySelectorAll<HTMLButtonElement>("button") ?? [])];
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (at < 0) return;
    event.preventDefault();
    buttons[(at + (event.key === "ArrowDown" ? 1 : buttons.length - 1)) % buttons.length]?.focus();
  };
  return (
    <nav aria-label="Relatórios" className="min-w-0">
      <ul ref={list} onKeyDown={move} className="flex flex-col gap-0.5">
        {reports.map((report) => {
          const active = report.key === current;
          return (
            <li key={report.key}>
              <button
                type="button"
                aria-current={active ? "true" : undefined}
                onClick={() => onChoose(report.key)}
                className={cn(
                  "relative w-full rounded-md py-2 pr-3 pl-4 text-left text-body transition-colors duration-[var(--ov-duration-fast)]",
                  active ? "bg-accent-soft font-semibold text-text" : "text-secondary hover:bg-hover hover:text-text",
                )}
              >
                {active ? (
                  <span
                    aria-hidden="true"
                    className="absolute top-1.5 bottom-1.5 left-1 w-[3px] rounded-full bg-accent"
                  />
                ) : null}
                {report.label}
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
