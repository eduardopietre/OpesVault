/**
 * Small pieces every tab of Contas e cartões shares: the row of commands above a table, the table's height,
 * the read-only lock, the dialog slot (one at a time, mounted with a fresh key so it animates out with its
 * content) and the one-shot reveal a link asks of a tab.
 */
import { Button, DataTable, EmptyState, useMediaQuery, type ButtonProps, type DataTableProps } from "@opesvault/ui";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useWorkspace } from "../../data/react.tsx";

export const LOCKED = "Outra aba ou outro aparelho está editando este projeto. Atualize para editar.";

/** Read-only state and the tooltip that explains a disabled command. */
export function useLock(): { locked: boolean; tip: string | undefined } {
  const locked = useWorkspace().readOnly;
  return { locked, tip: locked ? LOCKED : undefined };
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

/** A work table that fits its rows. */
export function ListTable<T extends object>({
  max = 10,
  ...props
}: Omit<DataTableProps<T>, "height"> & { max?: number }) {
  const height = useTableHeight(props.rows.length, max);
  return <DataTable {...props} height={height} />;
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
