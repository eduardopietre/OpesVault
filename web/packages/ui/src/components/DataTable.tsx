/**
 * Work tables (docs/16 §3, docs/18 §5.1): sorting and column visibility here, TanStack Virtual for rows
 * (the Livro with 50 thousand lines). No row model is built per row: with 50 thousand rows a new filter
 * would otherwise cost an object per row before the first frame. The header stays on top while rows scroll; columns
 * have a priority, and lower priorities hide when the container is narrow; under 640 px of container the
 * rows become a list of cards. Selection is by row id (a string), never by object identity, so a row read
 * back from the project keeps its selection. Keyboard: arrows, Home/End, Page Up/Down and Enter; the Menu key or
 * Shift+F10 opens the selected row's context menu (`rowMenu`), as a right click or a long press does.
 *
 * Opt-in tools above the rows: a search box (`search`, accent- and case-insensitive over the text the page says a
 * row is found by), toggle filters (`filters`), and the ticking of several rows (`selection`: a checkbox column,
 * "all shown", Shift+click for a range, Space on the current row, and a bar with the page's batch commands). The
 * ticked ids belong to the page; a command acts only on the ticked rows the search and filters still show.
 *
 * Tables start in the order the data arrives, without a sort indicator (docs/16 §4 rule 12).
 */
import { useVirtualizer } from "@tanstack/react-virtual";
import { ArrowDown, ArrowUp, Check, Minus, Search, SearchX } from "lucide-react";
import { Checkbox as RadixCheckbox } from "radix-ui";
import {
  memo,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  type ReactNode,
} from "react";
import { cn } from "../cn.ts";
import { compareLabels, searchKey } from "../format.ts";
import { useElementWidth } from "../hooks.ts";
import { BAND } from "../tokens.ts";
import { Button } from "./Button.tsx";
import { Checkbox, TextField } from "./fields.tsx";
import { EmptyState } from "./layout.tsx";
import { ContextMenuAt, type MenuEntry } from "./Menu.tsx";
import { usePortalContainer } from "./portal.ts";

export type SortValue = string | number | bigint | null | undefined;

/** Below this width of its own container a table is a list of cards. */
export const CARDS_BELOW = BAND.tablet;
/** A row's height, and the header's, in px. */
export const ROW_HEIGHT = 36;
export const HEADER_HEIGHT = 38;

/**
 * The height of a short table (docs/16 §4): its rows up to `max` (it scrolls inside beyond that) plus the
 * header; "none" as cards, which grow with the list, since a card list clipped to a row count would hide cards.
 */
export function fitHeight(count: number, max: number, cards = false): string {
  return cards ? "none" : `${Math.max(1, Math.min(count, max)) * ROW_HEIGHT + HEADER_HEIGHT}px`;
}

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

/** The search box of a table: what a row is found by. */
export interface TableSearch<T> {
  /** The text a row is found by (names, descriptions, notes); compared without accents or case. */
  text: (row: T) => string;
  /** The field's accessible name; `Buscar em <label>` by default. */
  label?: string;
  placeholder?: string;
}

/** A toggle above a table that narrows its rows ("Ocultar arquivadas"). */
export interface TableFilter<T> {
  id: string;
  label: string;
  /** While the filter is on, only the rows it keeps show. */
  keep: (row: T) => boolean;
  /** On when the table first shows. */
  initial?: boolean;
}

/** Ticking several rows for a batch command. The ticked ids belong to the page (one model per screen). */
export interface TableSelection<T> {
  selected: ReadonlySet<string>;
  onChange: (next: ReadonlySet<string>) => void;
  /** The batch commands, for the ticked rows that are shown (in the order shown). */
  actions?: (ids: readonly string[]) => ReactNode;
  /** Rows that cannot be ticked (an item already decided); every row by default. */
  canSelect?: (row: T) => boolean;
  /** A row's checkbox name (`Selecionar <first column>` by default). */
  rowLabel?: (row: T) => string;
  /** The count in the bar ("3 selecionados"). */
  count?: (n: number) => string;
  /** The command that unticks everything ("Limpar seleção"). */
  clearLabel?: string;
}

/** "1 selecionado", "3 selecionados". */
export function selectedCount(n: number): string {
  return `${n} ${n === 1 ? "selecionado" : "selecionados"}`;
}

/** The words of a search, without accents or case. */
export function searchWords(query: string): string[] {
  return searchKey(query).split(/\s+/).filter(Boolean);
}

/** Whether a row's search text (already through `searchKey`) holds every word of the search. */
export function matchesSearch(key: string, words: readonly string[]): boolean {
  return words.every((word) => key.includes(word));
}

export interface DataTableProps<T> {
  /** Accessible name ("Lançamentos"). */
  label: string;
  rows: readonly T[];
  columns: readonly DataColumn<T>[];
  getRowId: (row: T) => string;
  selectedId?: string | null;
  /** `via` is "menu" when the row is selected to open its context menu (a page may then skip opening a sheet). */
  onSelect?: (id: string, via?: "menu") => void;
  /** Enter or double click: open or edit. */
  onActivate?: (id: string) => void;
  /** Shown when there are no rows. */
  empty?: ReactNode;
  /** Height of the scrolling area (CSS length); the table never grows the page beyond it. */
  height?: string;
  rowHeight?: number;
  /** Card title in the phone list (defaults to the first column). */
  cardTitle?: (row: T) => ReactNode;
  /**
   * The whole content of a card in the phone list, for a page that lays it out itself (the Livro: description
   * and amount, then the accounts). Without it a card is the title and a "column: value" list.
   */
  renderCard?: (row: T) => ReactNode;
  /** Expected height of a card in px, for the virtual list (each card is measured once shown). */
  cardHeight?: number;
  className?: string | undefined;
  /** Forces the card layout (tests and catalog); otherwise it follows the container width. */
  layout?: "auto" | "table" | "cards";
  /**
   * The commands of one row, for its context menu: right click, the Menu key or Shift+F10 on the selected row,
   * or a long press on a phone. Asked only when the menu opens; the row is selected first. Without it (or with
   * no entries) the browser's own menu shows.
   */
  rowMenu?: (row: T) => readonly MenuEntry[];
  /** The context menu's accessible name for a row ("Ações de …"); the row's first column by default. */
  rowMenuLabel?: (row: T) => string;
  /** A search box above the rows. */
  search?: TableSearch<T>;
  /** Toggles above the rows that narrow them. */
  filters?: readonly TableFilter<T>[];
  /** Ticking several rows, with a bar of batch commands. */
  selection?: TableSelection<T>;
}

/** The text of a cell, for the menu's name; an element (a badge, a warning) gives none. */
function textOf(node: ReactNode): string {
  return typeof node === "string" || typeof node === "number" ? String(node) : "";
}

/** A context menu waiting to show: which row, and where. */
interface RowMenuAt {
  readonly id: string;
  readonly x: number;
  readonly y: number;
}

/** How long a finger rests on a row before its menu opens, and how far it may drift meanwhile. */
const LONG_PRESS_MS = 500;
const LONG_PRESS_SLOP = 10;

/** The column the rows are sorted by; none keeps the order the data arrives in. */
interface Sorting {
  readonly id: string;
  readonly desc: boolean;
}

function compare(a: SortValue, b: SortValue): number {
  if (a === b) return 0;
  if (a === null || a === undefined) return 1;
  if (b === null || b === undefined) return -1;
  if (typeof a === "string" && typeof b === "string") return compareLabels(a, b);
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
  /** The row's checkbox: null without `selection`. */
  checked: boolean | null;
  checkable: boolean;
  checkLabel: string;
  onCheck: (id: string, value: boolean, range: boolean) => void;
}

/** Width of the checkbox column, in px. */
const CHECK_WIDTH = 44;

const checkClass =
  "grid size-4.5 shrink-0 place-items-center rounded-sm border border-separator-strong bg-raised text-accent-text " +
  "shadow-sm transition-colors data-[state=checked]:border-accent-fill data-[state=checked]:bg-accent-fill " +
  "data-[state=indeterminate]:border-accent-fill data-[state=indeterminate]:bg-accent-fill disabled:opacity-50";

/**
 * A row's checkbox. Out of the tab order (the grid is one stop; Space ticks the current row) and apart from the
 * row: a click on it neither moves the current row nor opens the row. Shift+click ticks the range from the last one.
 */
function RowCheck({
  id,
  checked,
  disabled,
  label,
  onCheck,
}: {
  id: string;
  checked: boolean;
  disabled: boolean;
  label: string;
  onCheck: (id: string, value: boolean, range: boolean) => void;
}) {
  return (
    <RadixCheckbox.Root
      checked={checked}
      disabled={disabled}
      tabIndex={-1}
      aria-label={label}
      onMouseDown={(event) => {
        // Shift+click would select the page's text between the two clicks
        if (event.shiftKey) event.preventDefault();
      }}
      onClick={(event) => {
        event.stopPropagation();
        event.preventDefault();
        onCheck(id, !checked, event.shiftKey);
      }}
      onDoubleClick={(event) => event.stopPropagation()}
      className={checkClass}
    >
      <RadixCheckbox.Indicator>
        <Check aria-hidden="true" className="size-3.5" strokeWidth={3} />
      </RadixCheckbox.Indicator>
    </RadixCheckbox.Root>
  );
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
  checked,
  checkable,
  checkLabel,
  onCheck,
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
      {checked !== null ? (
        <div role="gridcell" className="flex items-center justify-center">
          <RowCheck id={rowId} checked={checked} disabled={!checkable} label={checkLabel} onCheck={onCheck} />
        </div>
      ) : null}
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
  rowHeight = ROW_HEIGHT,
  cardTitle,
  renderCard,
  cardHeight = 96,
  className,
  layout = "auto",
  rowMenu,
  rowMenuLabel,
  search,
  filters,
  selection,
}: DataTableProps<T>) {
  const [measure, width] = useElementWidth<HTMLDivElement>();
  const [portalAnchor, portalContainer] = usePortalContainer();
  const [menuAt, setMenuAt] = useState<RowMenuAt | null>(null);
  const press = useRef<{ x: number; y: number; timer: ReturnType<typeof setTimeout> } | null>(null);
  const pressedAt = useRef(0);
  useEffect(
    () => () => {
      if (press.current) clearTimeout(press.current.timer);
    },
    [],
  );
  const cards = layout === "cards" || (layout === "auto" && width > 0 && width < CARDS_BELOW);
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

  // ── search and filters ──
  const [query, setQuery] = useState("");
  const [filtersOn, setFiltersOn] = useState<ReadonlySet<string>>(
    () => new Set((filters ?? []).filter((f) => f.initial).map((f) => f.id)),
  );
  const searchText = search?.text;
  const searchKeys = useMemo(
    () => (searchText ? rows.map((row) => searchKey(searchText(row))) : null),
    [rows, searchText],
  );
  const words = useMemo(() => (searchText ? searchWords(query) : []), [searchText, query]);
  const activeFilters = useMemo(() => (filters ?? []).filter((f) => filtersOn.has(f.id)), [filters, filtersOn]);
  const narrowed = words.length > 0 || activeFilters.length > 0;
  const shownRows = useMemo<readonly T[]>(() => {
    if (!narrowed) return rows;
    return rows.filter(
      (row, index) =>
        (searchKeys === null || matchesSearch(searchKeys[index] ?? "", words)) &&
        activeFilters.every((f) => f.keep(row)),
    );
  }, [rows, narrowed, searchKeys, words, activeFilters]);

  const sortedRows = useMemo<readonly T[]>(() => {
    const column = sorting === null ? undefined : columns.find((c) => c.id === sorting.id);
    if (sorting === null || column?.sortValue === undefined) return shownRows;
    const value = column.sortValue;
    const keys = shownRows.map((row) => value(row) ?? null);
    const order = Array.from(shownRows.keys());
    const direction = sorting.desc ? -1 : 1;
    // Ties keep the order the data arrived in, in both directions.
    order.sort((x, y) => direction * compare(keys[x], keys[y]) || x - y);
    return order.map((i) => shownRows[i]!);
  }, [shownRows, columns, sorting]);
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
  // ── ticking several rows ──
  const selecting = selection !== undefined;
  const canSelect = selection?.canSelect;
  /** The ids that can be ticked, in the order shown. */
  const checkableIds = useMemo(
    () => (selecting ? sortedRows.filter((row) => canSelect?.(row) ?? true).map((row) => getRowId(row)) : []),
    [selecting, sortedRows, canSelect, getRowId],
  );
  const ticked = selection?.selected;
  const shownTicked = useMemo(
    () => (ticked ? checkableIds.filter((id) => ticked.has(id)) : []),
    [checkableIds, ticked],
  );
  const anchor = useRef<string | null>(null);
  const check = (id: string, value: boolean, range: boolean) => {
    if (!selection) return;
    const next = new Set(selection.selected);
    const from = range && anchor.current !== null ? checkableIds.indexOf(anchor.current) : -1;
    const to = checkableIds.indexOf(id);
    if (to < 0) return;
    const span = from >= 0 ? checkableIds.slice(Math.min(from, to), Math.max(from, to) + 1) : [id];
    for (const each of span) {
      if (value) next.add(each);
      else next.delete(each);
    }
    anchor.current = id;
    selection.onChange(next);
  };
  const checkAll = (value: boolean) => {
    if (!selection) return;
    const next = new Set(selection.selected);
    for (const id of checkableIds) {
      if (value) next.add(id);
      else next.delete(id);
    }
    selection.onChange(next);
  };
  const allState: boolean | "indeterminate" =
    shownTicked.length === 0 ? false : shownTicked.length === checkableIds.length ? true : "indeterminate";

  // Rows are memoized: the handlers they get never change identity, they call the latest props.
  const handlers = useRef({ onSelect, onActivate, check });
  handlers.current = { onSelect, onActivate, check };
  const select = useCallback((id: string) => handlers.current.onSelect?.(id), []);
  const activate = useCallback((id: string) => handlers.current.onActivate?.(id), []);
  const onCheck = useCallback(
    (id: string, value: boolean, range: boolean) => handlers.current.check(id, value, range),
    [],
  );
  const checkLabel = (row: T) => selection?.rowLabel?.(row) ?? `Selecionar ${textOf(visible[0]?.cell(row)) || "linha"}`;
  const template = [
    ...(selecting ? [`${CHECK_WIDTH}px`] : []),
    ...visible.map((column) =>
      column.grow ? `minmax(${column.width ?? 120}px, ${column.grow}fr)` : `${column.width ?? 120}px`,
    ),
  ].join(" ");

  const scroller = useRef<HTMLDivElement>(null);
  // The virtualizer measures every row again when these functions change identity: with 50 thousand rows
  // that is a few milliseconds per scroll frame, so they are kept stable between renders.
  const getScrollElement = useCallback(() => scroller.current, []);
  const estimateSize = useCallback(() => (cards ? cardHeight : rowHeight), [cards, cardHeight, rowHeight]);
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

  /** Opens the row's menu at a point, after selecting the row (the commands act on the selection). */
  const openMenu = (id: string, x: number, y: number) => {
    onSelect?.(id, "menu");
    setMenuAt({ id, x, y });
  };

  /** The row under a pointer event, inside this table. */
  const rowAt = (target: EventTarget | null): string | null => {
    const found = target instanceof Element ? target.closest<HTMLElement>("[data-row-id]") : null;
    return found && scroller.current?.contains(found) ? (found.dataset["rowId"] ?? null) : null;
  };

  const onContextMenu = (event: MouseEvent<HTMLDivElement>) => {
    if (!rowMenu) return;
    cancelPress();
    // A long press already opened it (Android also sends contextmenu then).
    if (Date.now() - pressedAt.current < 1000) {
      event.preventDefault();
      return;
    }
    const id = rowAt(event.target);
    if (id === null) return;
    event.preventDefault();
    openMenu(id, event.clientX, event.clientY);
  };

  const cancelPress = () => {
    if (press.current) clearTimeout(press.current.timer);
    press.current = null;
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (!rowMenu || event.pointerType !== "touch") return;
    const id = rowAt(event.target);
    if (id === null) return;
    const { clientX: x, clientY: y } = event;
    cancelPress();
    press.current = {
      x,
      y,
      timer: setTimeout(() => {
        press.current = null;
        pressedAt.current = Date.now();
        openMenu(id, x, y);
      }, LONG_PRESS_MS),
    };
  };

  /** The click that some browsers send when the finger lifts after a long press: the menu is open, not a tap. */
  const onClickCapture = (event: MouseEvent<HTMLDivElement>) => {
    if (Date.now() - pressedAt.current < 1000) {
      pressedAt.current = 0;
      event.stopPropagation();
      event.preventDefault();
    }
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const start = press.current;
    if (start && Math.hypot(event.clientX - start.x, event.clientY - start.y) > LONG_PRESS_SLOP) cancelPress();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    // The Menu key or Shift+F10: the selected row's menu, under the row.
    if (rowMenu && (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10"))) {
      event.preventDefault();
      if (selectedId === null || selectedIndex < 0) return;
      const rect = document.getElementById(rowDomId(selectedIndex))?.getBoundingClientRect();
      const box = rect ?? scroller.current?.getBoundingClientRect();
      if (box) openMenu(selectedId, box.left + 24, box.top + Math.min(box.height, rowHeight));
      return;
    }
    // Ctrl/Alt/Cmd + a key belongs to the page (Ctrl+Enter approves, Alt+number changes section), not to the grid:
    // Ctrl+Enter used to open the row's correction as well as approve it.
    if (!ids.length || event.ctrlKey || event.metaKey || event.altKey) return;
    const page = Math.max(
      1,
      Math.floor((scroller.current?.clientHeight ?? 400) / (cards ? cardHeight : rowHeight)) - 1,
    );
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
    // Space ticks the current row (Shift+Space: the range from the last one ticked).
    if (selection && selectedId !== null && selectedIndex >= 0) {
      const current = selectedId;
      actions[" "] = () => check(current, !selection.selected.has(current), event.shiftKey);
    }
    const action = actions[event.key];
    if (action) {
      event.preventDefault();
      action();
    }
  };

  const rowDomId = (index: number) => `${gridId}-r${index}`;
  const menuIndex = menuAt === null ? -1 : ids.indexOf(menuAt.id);
  const menuRow = menuIndex < 0 ? undefined : sortedRows[menuIndex];
  // Computed only while open, from the latest props: the commands see the row just selected.
  const menuItems = menuRow !== undefined && rowMenu ? rowMenu(menuRow) : [];
  const menuLabel =
    menuRow === undefined
      ? label
      : (rowMenuLabel?.(menuRow) ?? `Ações de ${textOf(visible[0]?.cell(menuRow)) || label}`);
  const closeMenu = () => {
    setMenuAt(null);
    scroller.current?.focus({ preventScroll: true });
  };
  const activeDescendant = selectedIndex >= 0 ? rowDomId(selectedIndex) : undefined;

  if (rows.length === 0 && empty) {
    return (
      <div ref={measure} className={cn("rounded-lg border border-separator bg-raised", className)}>
        {empty}
      </div>
    );
  }

  const clearSearch = () => {
    setQuery("");
    setFiltersOn(new Set());
  };
  const toggleFilter = (id: string, on: boolean) =>
    setFiltersOn((current) => {
      const next = new Set(current);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  const tools =
    search || filters?.length || (selection && cards) ? (
      <div className="mb-2 flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2">
        {search ? (
          <TextField
            label={search.label ?? `Buscar em ${label}`}
            hideLabel
            type="search"
            value={query}
            onChange={setQuery}
            placeholder={search.placeholder ?? "Buscar"}
            adornment={<Search />}
            autoComplete="off"
            fieldClassName="w-full tablet:w-72"
            onKeyDown={(event) => {
              if (event.key === "Escape" && query) {
                event.stopPropagation();
                setQuery("");
              }
            }}
          />
        ) : null}
        {(filters ?? []).map((filter) => (
          <Checkbox
            key={filter.id}
            label={filter.label}
            checked={filtersOn.has(filter.id)}
            onCheckedChange={(on) => toggleFilter(filter.id, on)}
          />
        ))}
        {selection && cards && checkableIds.length ? (
          <Checkbox label="Selecionar todos os exibidos" checked={allState} onCheckedChange={checkAll} />
        ) : null}
        <span role="status" className="text-caption text-secondary tabular-nums">
          {narrowed ? `${ids.length} de ${rows.length}` : ""}
        </span>
      </div>
    ) : null;
  const shownCount = shownTicked.length;
  const selectionBar = selection ? (
    <div
      role="toolbar"
      aria-label={`Ações dos selecionados em ${label}`}
      className={
        shownCount ? "mb-2 flex min-w-0 flex-wrap items-center gap-2 rounded-lg bg-accent-soft px-3 py-1.5" : "sr-only"
      }
    >
      <span role="status" className="text-body font-medium">
        {shownCount ? (selection.count ?? selectedCount)(shownCount) : ""}
      </span>
      {shownCount ? (
        <>
          {selection.actions?.(shownTicked)}
          <Button size="sm" variant="ghost" onClick={() => selection.onChange(new Set())}>
            {selection.clearLabel ?? "Limpar seleção"}
          </Button>
        </>
      ) : null}
    </div>
  ) : null;

  if (ids.length === 0 && narrowed) {
    return (
      <div ref={measure} className={cn("min-w-0", className)}>
        {tools}
        <div className="rounded-lg border border-separator bg-raised">
          <EmptyState
            icon={<SearchX />}
            title="Nada encontrado"
            description={
              words.length
                ? "Nenhuma linha tem este texto com os filtros escolhidos. Ajuste a busca ou os filtros."
                : "Os filtros escolhidos escondem todas as linhas."
            }
            actions={<Button onClick={clearSearch}>Limpar busca e filtros</Button>}
          />
        </div>
      </div>
    );
  }

  return (
    <div
      ref={(element) => {
        measure(element);
        portalAnchor(element);
      }}
      className={cn("min-w-0", className)}
    >
      {tools}
      {selectionBar}
      {menuAt !== null && menuItems.length > 0 ? (
        <ContextMenuAt
          key={`${menuAt.id}|${menuAt.x}|${menuAt.y}`}
          x={menuAt.x}
          y={menuAt.y}
          items={menuItems}
          label={menuLabel}
          onClose={closeMenu}
          container={portalContainer}
        />
      ) : null}
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
        onContextMenu={onContextMenu}
        onClickCapture={onClickCapture}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={cancelPress}
        onPointerCancel={cancelPress}
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
              {selection ? (
                <div role="columnheader" className="flex h-9 items-center justify-center">
                  <RadixCheckbox.Root
                    checked={allState}
                    disabled={!checkableIds.length}
                    tabIndex={-1}
                    aria-label="Selecionar todos os exibidos"
                    onClick={(event) => {
                      event.preventDefault();
                      checkAll(allState !== true);
                    }}
                    className={checkClass}
                  >
                    <RadixCheckbox.Indicator>
                      {allState === "indeterminate" ? (
                        <Minus aria-hidden="true" className="size-3.5" />
                      ) : (
                        <Check aria-hidden="true" className="size-3.5" strokeWidth={3} />
                      )}
                    </RadixCheckbox.Indicator>
                  </RadixCheckbox.Root>
                </div>
              ) : null}
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
                    {selection ? (
                      <div className="float-left mt-0.5 mr-2.5">
                        <RowCheck
                          id={rowId}
                          checked={selection.selected.has(rowId)}
                          disabled={!(canSelect?.(original) ?? true)}
                          label={checkLabel(original)}
                          onCheck={onCheck}
                        />
                      </div>
                    ) : null}
                    {renderCard ? (
                      renderCard(original)
                    ) : (
                      <>
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
                      </>
                    )}
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
                checked={selection ? selection.selected.has(rowId) : null}
                checkable={selection ? (canSelect?.(original) ?? true) : false}
                checkLabel={selection ? checkLabel(original) : ""}
                onCheck={onCheck}
              />
            );
          })}
        </div>
      </div>
    </div>
  );
}
