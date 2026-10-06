/**
 * Small pieces every tab of Contas e cartões shares: the row of commands above a table, the table's height,
 * the read-only lock, the dialog slot (one at a time, mounted with a fresh key so it animates out with its
 * content) and the one-shot reveal a link asks of a tab.
 */
import {
  Button,
  DataTable,
  EmptyState,
  useElementWidth,
  useMediaQuery,
  type ButtonProps,
  type DataTableProps,
} from "@opesvault/ui";
import { TriangleAlert } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useWorkspace } from "../data/react.tsx";
import { fitColumns, type TierColumn } from "./tier_columns.ts";

export const LOCKED = "Outra aba ou outro aparelho está editando este projeto. Atualize para editar.";

/** Read-only state and the tooltip that explains a disabled command. */
export function useLock(): { locked: boolean; tip: string | undefined } {
  const locked = useWorkspace().readOnly;
  return { locked, tip: locked ? LOCKED : undefined };
}

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

/** The height of a short table: its rows, up to `max`, plus the header; free on phones (cards). */
export function useTableHeight(count: number, max: number): string {
  const phone = useMediaQuery("(max-width: 639px)");
  return phone ? "none" : `${Math.min(Math.max(count, 1), max) * 36 + 38}px`;
}

/** A work table that fits its rows and shows the columns its room allows (`columns.ts`). */
export function ListTable<T extends object>({
  max = 10,
  columns,
  ...props
}: Omit<DataTableProps<T>, "height" | "columns"> & { max?: number; columns: readonly TierColumn<T>[] }) {
  const [measure, width] = useElementWidth<HTMLDivElement>();
  const height = useTableHeight(props.rows.length, max);
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

/** One dialog at a time: closing only clears `open`, so it leaves with its content; the next gets a new key. */
export function useDialog<T>() {
  const [state, setState] = useState<{ spec: T | null; open: boolean; key: number }>({
    spec: null,
    open: false,
    key: 0,
  });
  const show = useCallback((spec: T) => setState((s) => ({ spec, open: true, key: s.key + 1 })), []);
  const close = useCallback(() => setState((s) => ({ ...s, open: false })), []);
  return { ...state, show, close };
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
