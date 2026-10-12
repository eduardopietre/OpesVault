/**
 * Small pieces every tab of Contas e cartões shares: the row of commands above a table, the table's height,
 * the command that respects the read-only lock and the one-shot reveal a link asks of a tab.
 */
import {
  Button,
  DataTable,
  EmptyState,
  useElementWidth,
  type ButtonProps,
  type DataTableProps,
  fitHeight,
  notify,
  usePhone,
} from "@opesvault/ui";
import { TriangleAlert } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useLock } from "../data/read_only.ts";
import { CELL_PADDING, fitColumns, longestTexts, widenColumns, type TierColumn } from "./tier_columns.ts";

/**
 * A value that needs attention (a difference from the bank, a rule the family contradicts): the warning shape
 * before the text, which keeps the table's own text color, so the state is never by color alone and the text
 * keeps its contrast on a selected row.
 */
export function Warn({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5 font-medium">
      <TriangleAlert aria-hidden="true" className="size-3.5 shrink-0 text-warning" />
      <span className="truncate">{children}</span>
    </span>
  );
}

/** The commands of a tab, above its table; they wrap on narrow screens. */
export function Toolbar({ children, label }: { children: ReactNode; label: string }) {
  return (
    <div role="toolbar" aria-label={label} className="flex flex-wrap items-center gap-2">
      {children}
    </div>
  );
}

/** A command that changes the project: disabled, with the reason, while the project is read-only. */
export function EditButton(props: ButtonProps) {
  const { locked, tip } = useLock();
  return <Button {...props} disabled={props.disabled || locked} title={props.title ?? tip} />;
}

/** A work table that fits its rows and shows the columns its room allows (`columns.ts`). */
export function ListTable<T extends object>({
  max = 10,
  columns,
  ...props
}: Omit<DataTableProps<T>, "height" | "columns"> & { max?: number; columns: readonly TierColumn<T>[] }) {
  const [measure, width] = useElementWidth<HTMLDivElement>();
  const height = fitHeight(props.rows.length, max, usePhone());
  const { probe, widths } = useTextWidths(columns, props.rows);
  const fitted = useMemo(() => fitColumns(widenColumns(columns, widths), width), [columns, widths, width]);
  return (
    <div ref={measure} className="relative min-w-0">
      <span
        ref={probe}
        aria-hidden="true"
        className="pointer-events-none invisible absolute top-0 left-0 text-body whitespace-nowrap tabular-nums"
      />
      <DataTable {...props} columns={fitted} height={height} />
    </div>
  );
}

/**
 * The width each number column needs for its longest text, measured in the cells' own type (`text-body`,
 * tabular figures) once the fonts have loaded, so an amount is never cut: the column grows, and the tiers then
 * drop other columns instead of scrolling sideways.
 */
function useTextWidths<T>(columns: readonly TierColumn<T>[], rows: readonly T[]) {
  const probe = useRef<HTMLSpanElement>(null);
  const longest = useMemo(() => longestTexts(columns, rows), [columns, rows]);
  const [widths, setWidths] = useState<ReadonlyMap<string, number>>(() => new Map());
  const [fontsLoaded, setFontsLoaded] = useState(false);
  useEffect(() => {
    let live = true;
    const fonts = (document as Partial<Document>).fonts;
    void fonts?.ready.then(() => {
      if (live) setFontsLoaded(true);
    });
    return () => {
      live = false;
    };
  }, []);
  useLayoutEffect(() => {
    const span = probe.current;
    if (!span) return;
    const next = new Map<string, number>();
    for (const [id, text] of longest) {
      span.textContent = text;
      const px = Math.ceil(span.getBoundingClientRect().width);
      if (px > 0) next.set(id, px + CELL_PADDING);
    }
    span.textContent = "";
    setWidths((previous) =>
      previous.size === next.size && [...next].every(([id, px]) => previous.get(id) === px) ? previous : next,
    );
  }, [longest, fontsLoaded]);
  return { probe, widths };
}

/** An empty table or chart: what it is, why it is empty and what to do. */
export function Empty({ title, children }: { title: string; children: ReactNode }) {
  return <EmptyState framed title={title} description={children} />;
}

export interface Pick<T> {
  /** The id picked in the table (it may name a row that is gone). */
  pick: string | null;
  setPick: (id: string | null) => void;
  /** The picked row, or the first with `first` (a table that always shows one in detail). */
  selected: T | null;
  /** For a command on the selected row: the row, or null after saying what to select. */
  need: (message: string) => T | null;
}

/** The row a table has selected, by id, so a row read back from the project keeps its selection. */
export function usePick<T>(rows: readonly T[], idOf: (row: T) => string, options: { first?: boolean } = {}): Pick<T> {
  const [pick, setPick] = useState<string | null>(null);
  const selected = rows.find((row) => idOf(row) === pick) ?? (options.first ? (rows[0] ?? null) : null);
  const need = (message: string): T | null => {
    if (!selected) notify(message);
    return selected;
  };
  return { pick, setPick, selected, need };
}

/** What a link asks of a tab: made by the page, consumed once by the tab it names. */
export interface TabReveal<T> {
  seq: number;
  value: T;
}

/** Runs `apply` once for each new reveal, when the tab is mounted (a tab switched to by the link mounts first). */
export function useTabReveal<T>(reveal: TabReveal<T> | null | undefined, apply: (value: T) => void): void {
  const done = useRef(0);
  const latest = useRef(apply);
  useEffect(() => {
    latest.current = apply;
  });
  const seq = reveal?.seq ?? 0;
  useEffect(() => {
    if (!reveal || done.current === reveal.seq) return;
    done.current = reveal.seq;
    latest.current(reveal.value);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per `seq`
  }, [seq]);
}
