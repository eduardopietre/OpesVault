/**
 * Work tables (docs/16 §3, docs/18 §5.1): TanStack Table for sorting and column visibility, TanStack
 * Virtual for rows (the Livro with 50 thousand lines). The header stays on top while rows scroll; columns
 * have a priority, and lower priorities hide when the container is narrow; under 640 px of container the
 * rows become a list of cards. Selection is by row id (a string), never by object identity, so a row read
 * back from the project keeps its selection. Keyboard: arrows, Home/End, Page Up/Down and Enter.
 *
 * Tables start in the order the data arrives, without a sort indicator (docs/16 §4 rule 12).
 */
import {
  columnVisibilityFeature,
  createColumnHelper,
  createSortedRowModel,
  rowSortingFeature,
  tableFeatures,
  useTable,
  type SortingState,
} from "@tanstack/react-table";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ArrowDown, ArrowUp } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
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
  className?: string;
  /** Forces the card layout (tests and catalog); otherwise it follows the container width. */
  layout?: "auto" | "table" | "cards";
}

const features = tableFeatures({
  rowSortingFeature,
  columnVisibilityFeature,
  sortedRowModel: createSortedRowModel(),
});

function compare(a: SortValue, b: SortValue): number {
  if (a === b) return 0;
  if (a === null || a === undefined) return 1;
  if (b === null || b === undefined) return -1;
  if (typeof a === "string" && typeof b === "string") return a.localeCompare(b, "pt-BR", { sensitivity: "base" });
  return a < b ? -1 : a > b ? 1 : 0;
}

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
  const [sorting, setSorting] = useState<SortingState>([]);
  const gridId = useId();

  const columnVisibility = useMemo(() => {
    const visibility: Record<string, boolean> = {};
    for (const column of columns) {
      const priority = column.priority ?? 1;
      visibility[column.id] = width === 0 || priority === 1 || (priority === 2 ? width >= 720 : width >= 960);
    }
    return visibility;
  }, [columns, width]);

  const tableColumns = useMemo(() => {
    const helper = createColumnHelper<typeof features, T>();
    return helper.columns(
      columns.map((column) =>
        helper.accessor((row: T) => column.sortValue?.(row) ?? null, {
          id: column.id,
          header: column.header,
          enableSorting: Boolean(column.sortValue),
          sortUndefined: "last",
          sortDescFirst: false,
          sortFn: (a, b, id) => compare(a.getValue<SortValue>(id), b.getValue<SortValue>(id)),
        }),
      ),
    );
  }, [columns]);

  const data = useMemo(() => [...rows], [rows]);
  const table = useTable({
    features,
    columns: tableColumns,
    data,
    getRowId: (row: T) => getRowId(row),
    state: { sorting, columnVisibility },
    onSortingChange: setSorting,
    enableSortingRemoval: true,
  });

  const modelRows = table.getRowModel().rows;
  const ids = useMemo(() => modelRows.map((row) => row.id), [modelRows]);
  const selectedIndex = selectedId === null ? -1 : ids.indexOf(selectedId);
  const byId = useMemo(() => new Map(columns.map((column) => [column.id, column])), [columns]);
  const visible = columns.filter((column) => columnVisibility[column.id] !== false);
  const template = visible
    .map((column) => (column.grow ? `minmax(${column.width ?? 120}px, ${column.grow}fr)` : `${column.width ?? 120}px`))
    .join(" ");

  const scroller = useRef<HTMLDivElement>(null);
  // TanStack Virtual returns fresh functions each render; this component is not memoized by the compiler.
  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: ids.length,
    getScrollElement: () => scroller.current,
    estimateSize: () => (cards ? 96 : rowHeight),
    getItemKey: (index) => ids[index] ?? index,
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
    if (!ids.length) return;
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
  const headerGroup = table.getHeaderGroups()[0];

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
              const sorted = sorting[0]?.id === column.id ? (sorting[0].desc ? "desc" : "asc") : false;
              return (
                <button
                  key={column.id}
                  type="button"
                  aria-pressed={Boolean(sorted)}
                  onClick={() => table.getColumn(column.id)?.toggleSorting(sorted === "asc")}
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
        {!cards && headerGroup ? (
          <div role="rowgroup" className="sticky top-0 z-10">
            <div
              role="row"
              aria-rowindex={1}
              className="grid min-w-full border-b border-separator bg-raised"
              style={{ gridTemplateColumns: template }}
            >
              {headerGroup.headers.map((header) => {
                const column = byId.get(header.column.id);
                const sorted = header.column.getIsSorted();
                const end = column?.align === "end";
                return (
                  <div
                    key={header.id}
                    role="columnheader"
                    aria-sort={sorted === "asc" ? "ascending" : sorted === "desc" ? "descending" : undefined}
                    className={cn(
                      "flex h-9 min-w-0 items-center px-3 text-caption font-semibold text-secondary",
                      end && "justify-end",
                    )}
                  >
                    {header.column.getCanSort() ? (
                      <button
                        type="button"
                        tabIndex={-1}
                        onClick={header.column.getToggleSortingHandler()}
                        className={cn(
                          "inline-flex min-w-0 items-center gap-1 rounded-sm hover:text-text",
                          end && "flex-row-reverse",
                        )}
                        title={`Ordenar por ${column?.header ?? ""}`}
                      >
                        <span className="truncate">{column?.header}</span>
                        {sorted === "asc" ? <ArrowUp aria-hidden="true" className="size-3.5 shrink-0" /> : null}
                        {sorted === "desc" ? <ArrowDown aria-hidden="true" className="size-3.5 shrink-0" /> : null}
                      </button>
                    ) : (
                      <span className="truncate">{column?.header}</span>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        ) : null}
        <div role={cards ? undefined : "rowgroup"} className="relative" style={{ height: virtualizer.getTotalSize() }}>
          {virtualizer.getVirtualItems().map((item) => {
            const row = modelRows[item.index];
            if (!row) return null;
            const selected = row.id === selectedId;
            const original = row.original;
            const common = {
              id: rowDomId(item.index),
              "data-index": item.index,
              "data-row-id": row.id,
              "aria-selected": selected,
              onClick: () => onSelect?.(row.id),
              onDoubleClick: () => onActivate?.(row.id),
            };
            if (cards) {
              const [first, ...rest] = visible;
              return (
                <div
                  key={row.id}
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
                          <dd className={cn("min-w-0 truncate text-text", column.align === "end" && "text-right")}>
                            {column.cell(original)}
                          </dd>
                        </div>
                      ))}
                    </dl>
                  </div>
                </div>
              );
            }
            return (
              <div
                key={row.id}
                role="row"
                aria-rowindex={item.index + 2}
                {...common}
                className={cn(
                  "absolute top-0 left-0 grid min-w-full cursor-default border-b border-separator/60 text-body",
                  selected
                    ? "bg-selection-inactive group-focus/grid:bg-selection group-focus/grid:text-accent-text"
                    : item.index % 2
                      ? "bg-alternate hover:bg-hover"
                      : "hover:bg-hover",
                )}
                style={{ gridTemplateColumns: template, height: rowHeight, transform: `translateY(${item.start}px)` }}
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
          })}
        </div>
      </div>
    </div>
  );
}
