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
  usePhone,
} from "@opesvault/ui";
import { TriangleAlert } from "lucide-react";
import { useEffect, useMemo, useRef, type ReactNode } from "react";
import { useLock } from "../data/read_only.ts";
import { fitColumns, type TierColumn } from "./tier_columns.ts";

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
  const fitted = useMemo(() => fitColumns(columns, width), [columns, width]);
  return (
    <div ref={measure} className="min-w-0">
      <DataTable {...props} columns={fitted} height={height} />
    </div>
  );
}

/** An empty table or chart: what it is, why it is empty and what to do. */
export function Empty({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="rounded-xl border border-dashed border-separator-strong bg-window/40">
      <EmptyState title={title} description={children} />
    </div>
  );
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
