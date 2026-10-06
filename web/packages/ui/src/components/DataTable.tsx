/**
 * Work tables (docs/16 §3, docs/18 §5.1): sorting and column visibility here, TanStack Virtual for rows
 * (the Livro with 50 thousand lines). No row model is built per row: with 50 thousand rows a new filter
 * would otherwise cost an object per row before the first frame. The header stays on top while rows scroll; columns
 * have a priority, and lower priorities hide when the container is narrow; under 640 px of container the
 * rows become a list of cards. Selection is by row id (a string), never by object identity, so a row read
 * back from the project keeps its selection. Keyboard: arrows, Home/End, Page Up/Down and Enter.
 *
 * Tables start in the order the data arrives, without a sort indicator (docs/16 §4 rule 12).
 */
import { useVirtualizer } from "@tanstack/react-virtual";
import { ArrowDown, ArrowUp } from "lucide-react";
import {
  memo,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { cn } from "../cn.ts";
import { useElementWidth } from "../hooks.ts";

export type SortValue = string | number | bigint | null | undefined;

export interface DataColumn<T> {
  id: string;
  header: string;
  /** Renders the cell (formatting happens here, from domain values). */
  cell: (row: T) => ReactNode;
  /** Value used to sort (exact: amounts as scaled bigint or zero-padded strings). Without it the column does not sort. */
  sortValue?: (row: T) => SortValue;
  /** Numbers align to the end, header included. */
  align?: "start" | "end";
  /** 1 always shows; 2 from 720 px of table; 3 from 960 px. */
  priority?: 1 | 2 | 3;
  /** Minimum width in px. */
  width?: number;
  /** Share of the leftover width (text columns grow; numbers keep their width). */
  grow?: number;
}

export interface DataTableProps<T> {
  /** Accessible name ("Lançamentos"). */
  label: string;
  rows: readonly T[];
  columns: readonly DataColumn<T>[];
  getRowId: (row: T) => string;
  selectedId?: string | null;
  onSelect?: (id: string) => void;
  /** Enter or double click: open or edit. */
  onActivate?: (id: string) => void;
  /** Shown when there are no rows. */
  empty?: ReactNode;
  /** Height of the scrolling area (CSS length); the table never grows the page beyond it. */
  height?: string;
  rowHeight?: number;
  /** Card title in the phone list (defaults to the first column). */
  cardTitle?: (row: T) => ReactNode;
  className?: string | undefined;
  /** Forces the card layout (tests and catalog); otherwise it follows the container width. */
  layout?: "auto" | "table" | "cards";
}

/** The column the rows are sorted by; none keeps the order the data arrives in. */
interface Sorting {
  readonly id: string;
  readonly desc: boolean;
}

function compare(a: SortValue, b: SortValue): number {
  if (a === b) return 0;
  if (a === null || a === undefined) return 1;
  if (b === null || b === undefined) return -1;
  if (typeof a === "string" && typeof b === "string") return a.localeCompare(b, "pt-BR", { sensitivity: "base" });
  return a < b ? -1 : a > b ? 1 : 0;
}

interface TableRowProps<T> {
  original: T;
  rowId: string;
  domId: string;
  index: number;
  start: number;
  selected: boolean;
  template: string;
  visible: readonly DataColumn<T>[];
  rowHeight: number;
  onSelect: (id: string) => void;
  onActivate: (id: string) => void;
}

/**
 * One row of the grid. Memoized: while scrolling, only the rows that enter the window are rendered; the ones
 * already there keep their elements (the cells call the page's formatters, which is most of the cost).
 */
const TableRow = memo(function TableRow<T>({
  original,
  rowId,
  domId,
  index,
  start,
  selected,
  template,
  visible,
  rowHeight,
  onSelect,
  onActivate,
}: TableRowProps<T>) {
  return (
    <div
      id={domId}
      role="row"
      aria-rowindex={index + 2}
      data-index={index}
      data-row-id={rowId}
      aria-selected={selected}
      onClick={() => onSelect(rowId)}
      onDoubleClick={() => onActivate(rowId)}
      className={cn(
        "absolute top-0 left-0 grid min-w-full cursor-default border-b border-separator/60 text-body",
        selected
          ? "bg-selection-inactive group-focus/grid:bg-selection group-focus/grid:text-accent-text group-focus/grid:**:text-accent-text"
          : index % 2
            ? "bg-alternate hover:bg-hover"
            : "hover:bg-hover",
      )}
      style={{ gridTemplateColumns: template, height: rowHeight, transform: `translateY(${start}px)` }}
    >
      {visible.map((column) => (
        <div
          key={column.id}
          role="gridcell"
          className={cn(
            "flex min-w-0 items-center px-3",
            column.align === "end" && "justify-end text-right tabular-nums",
          )}
        >
          <span className="min-w-0 truncate">{column.cell(original)}</span>
        </div>
      ))}
    </div>
  );
}) as <T>(props: TableRowProps<T>) => ReactNode;

export function DataTable<T extends object>({
  label,
  rows,
  columns,
  getRowId,
  selectedId = null,
  onSelect,
  onActivate,
  empty,
  height = "min(70dvh, 640px)",
  rowHeight = 36,
  cardTitle,
  className,
  layout = "auto",
}: DataTableProps<T>) {
  const [measure, width] = useElementWidth<HTMLDivElement>();
  const cards = layout === "cards" || (layout === "auto" && width > 0 && width < 640);
  const [sorting, setSorting] = useState<Sorting | null>(null);
  const gridId = useId();

  const columnVisibility = useMemo(() => {
    const visibility: Record<string, boolean> = {};
    for (const column of columns) {
      const priority = column.priority ?? 1;
      visibility[column.id] = width === 0 || priority === 1 || (priority === 2 ? width >= 720 : width >= 960);
    }
    return visibility;
  }, [columns, width]);

  const sortedRows = useMemo<readonly T[]>(() => {
    const column = sorting === null ? undefined : columns.find((c) => c.id === sorting.id);
    if (sorting === null || column?.sortValue === undefined) return rows;
    const value = column.sortValue;
    const keys = rows.map((row) => value(row) ?? null);
    const order = Array.from(rows.keys());
    const direction = sorting.desc ? -1 : 1;
    // Ties keep the order the data arrived in, in both directions.
    order.sort((x, y) => direction * compare(keys[x], keys[y]) || x - y);
    return order.map((i) => rows[i]!);
  }, [rows, columns, sorting]);
  const ids = useMemo(() => sortedRows.map((row) => getRowId(row)), [sortedRows, getRowId]);
  const selectedIndex = selectedId === null ? -1 : ids.indexOf(selectedId);
  const toggleSort = (id: string, firstDesc = false) =>
    setSorting((current) => {
      if (current?.id !== id) return { id, desc: firstDesc };
      return current.desc === firstDesc ? { id, desc: !firstDesc } : null;
    });
  const visible = useMemo(
    () => columns.filter((column) => columnVisibility[column.id] !== false),
    [columns, columnVisibility],
  );
  // Rows are memoized: the handlers they get never change identity, they call the latest props.
  const handlers = useRef({ onSelect, onActivate });
  handlers.current = { onSelect, onActivate };
  const select = useCallback((id: string) => handlers.current.onSelect?.(id), []);
  const activate = useCallback((id: string) => handlers.current.onActivate?.(id), []);
  const template = visible
    .map((column) => (column.grow ? `minmax(${column.width ?? 120}px, ${column.grow}fr)` : `${column.width ?? 120}px`))
    .join(" ");

  const scroller = useRef<HTMLDivElement>(null);
  // The virtualizer measures every row again when these functions change identity: with 50 thousand rows
  // that is a few milliseconds per scroll frame, so they are kept stable between renders.
  const getScrollElement = useCallback(() => scroller.current, []);
  const estimateSize = useCallback(() => (cards ? 96 : rowHeight), [cards, rowHeight]);
  const getItemKey = useCallback((index: number) => ids[index] ?? index, [ids]);
  // TanStack Virtual returns fresh functions each render; this component is not memoized by the compiler.
  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: ids.length,
    getScrollElement,
    estimateSize,
    getItemKey,
    overscan: 8,
    initialRect: { width: 800, height: 600 },
  });

  useEffect(() => {
    virtualizer.measure();
  }, [cards, virtualizer]);

  useEffect(() => {
    if (selectedIndex >= 0) virtualizer.scrollToIndex(selectedIndex, { align: "auto" });
  }, [selectedIndex, virtualizer]);

  const move = (index: number) => {
    const target = Math.max(0, Math.min(ids.length - 1, index));
    const id = ids[target];
    if (id !== undefined) onSelect?.(id);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    // Ctrl/Alt/Cmd + a key belongs to the page (Ctrl+Enter approves, Alt+number changes section), not to the grid:
    // Ctrl+Enter used to open the row's correction as well as approve it.
    if (!ids.length || event.ctrlKey || event.metaKey || event.altKey) return;
    const page = Math.max(1, Math.floor((scroller.current?.clientHeight ?? 400) / (cards ? 96 : rowHeight)) - 1);
    const from = selectedIndex < 0 ? -1 : selectedIndex;
    const actions: Record<string, () => void> = {
      ArrowDown: () => move(from + 1),
      ArrowUp: () => move(from < 0 ? 0 : from - 1),
      Home: () => move(0),
      End: () => move(ids.length - 1),
      PageDown: () => move(from + page),
      PageUp: () => move(from - page),
      Enter: () => {
        if (selectedId !== null && selectedIndex >= 0) onActivate?.(selectedId);
      },
    };
    const action = actions[event.key];
    if (action) {
      event.preventDefault();
      action();
    }
  };

  const rowDomId = (index: number) => `${gridId}-r${index}`;
  const activeDescendant = selectedIndex >= 0 ? rowDomId(selectedIndex) : undefined;

  if (rows.length === 0 && empty) {
    return (
      <div ref={measure} className={cn("rounded-lg border border-separator bg-raised", className)}>
        {empty}
      </div>
    );
  }

  return (
    <div ref={measure} className={cn("min-w-0", className)}>
      {cards ? (
        <div className="mb-2 flex flex-wrap gap-2" aria-label={`Ordenar ${label}`} role="group">
          {visible
            .filter((column) => column.sortValue)
            .map((column) => {
              const sorted = sorting?.id === column.id ? (sorting.desc ? "desc" : "asc") : false;
              return (
                <button
                  key={column.id}
                  type="button"
                  aria-pressed={Boolean(sorted)}
                  onClick={() => setSorting({ id: column.id, desc: sorted === "asc" })}
                  className={cn(
                    "inline-flex h-7 items-center gap-1 rounded-full border px-2.5 text-caption",
                    sorted ? "border-accent bg-accent-soft font-semibold text-text" : "border-separator text-secondary",
                  )}
                >
                  {column.header}
                  {sorted === "asc" ? <ArrowUp aria-hidden="true" className="size-3" /> : null}
                  {sorted === "desc" ? <ArrowDown aria-hidden="true" className="size-3" /> : null}
                  {sorted ? (
                    <span className="sr-only">{sorted === "asc" ? ", crescente" : ", decrescente"}</span>
                  ) : null}
                </button>
              );
            })}
        </div>
      ) : null}
      <div
        ref={scroller}
        role={cards ? "listbox" : "grid"}
        aria-label={label}
        aria-rowcount={cards ? undefined : ids.length + 1}
        aria-activedescendant={activeDescendant}
        tabIndex={0}
        onKeyDown={onKeyDown}
        className={cn(
          "group/grid relative overflow-auto rounded-lg outline-offset-2",
          cards ? "" : "border border-separator bg-raised",
        )}
        style={{ maxHeight: height }}
      >
        {!cards ? (
          <div role="rowgroup" className="sticky top-0 z-10">
            <div
              role="row"
              aria-rowindex={1}
              className="grid min-w-full border-b border-separator bg-raised"
              style={{ gridTemplateColumns: template }}
            >
              {visible.map((column) => {
                const sorted = sorting?.id === column.id ? (sorting.desc ? "desc" : "asc") : false;
                const end = column.align === "end";
                return (
                  <div
                    key={column.id}
                    role="columnheader"
                    aria-sort={sorted === "asc" ? "ascending" : sorted === "desc" ? "descending" : undefined}
                    className={cn(
                      "flex h-9 min-w-0 items-center px-3 text-caption font-semibold text-secondary",
                      end && "justify-end",
                    )}
                  >
                    {column.sortValue ? (
                      <button
                        type="button"
                        tabIndex={-1}
                        onClick={() => toggleSort(column.id)}
                        className={cn(
                          "inline-flex min-w-0 items-center gap-1 rounded-sm hover:text-text",
                          end && "flex-row-reverse",
                        )}
                        title={`Ordenar por ${column.header}`}
                      >
                        <span className="truncate">{column.header}</span>
                        {sorted === "asc" ? <ArrowUp aria-hidden="true" className="size-3.5 shrink-0" /> : null}
                        {sorted === "desc" ? <ArrowDown aria-hidden="true" className="size-3.5 shrink-0" /> : null}
                      </button>
                    ) : (
                      <span className="truncate">{column.header}</span>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        ) : null}
        <div role={cards ? undefined : "rowgroup"} className="relative" style={{ height: virtualizer.getTotalSize() }}>
          {virtualizer.getVirtualItems().map((item) => {
            const original = sortedRows[item.index];
            const rowId = ids[item.index];
            if (original === undefined || rowId === undefined) return null;
            const selected = rowId === selectedId;
            const common = {
              id: rowDomId(item.index),
              "data-index": item.index,
              "data-row-id": rowId,
              "aria-selected": selected,
              onClick: () => onSelect?.(rowId),
              onDoubleClick: () => onActivate?.(rowId),
            };
            if (cards) {
              const [first, ...rest] = visible;
              return (
                <div
                  key={rowId}
                  ref={virtualizer.measureElement}
                  role="option"
                  {...common}
                  className="absolute inset-x-0 top-0 pb-2"
                  style={{ transform: `translateY(${item.start}px)` }}
                >
                  <div
                    className={cn(
                      "rounded-lg border bg-raised px-3 py-2.5 shadow-sm transition-colors",
                      selected ? "border-accent ring-1 ring-accent" : "border-separator",
                    )}
                  >
                    <div className="truncate text-body font-semibold">
                      {cardTitle ? cardTitle(original) : first ? first.cell(original) : null}
                    </div>
                    <dl className="mt-1 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5 text-caption">
                      {rest.map((column) => (
                        <div key={column.id} className="contents">
                          <dt className="text-secondary">{column.header}</dt>
                          <dd className="min-w-0 truncate text-text">{column.cell(original)}</dd>
                        </div>
                      ))}
                    </dl>
                  </div>
                </div>
              );
            }
            return (
              <TableRow
                key={rowId}
                original={original}
                rowId={rowId}
                domId={rowDomId(item.index)}
                index={item.index}
                start={item.start}
                selected={selected}
                template={template}
                visible={visible}
                rowHeight={rowHeight}
                onSelect={select}
                onActivate={activate}
              />
            );
          })}
        </div>
      </div>
    </div>
  );
}
