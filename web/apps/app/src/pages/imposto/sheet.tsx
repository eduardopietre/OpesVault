/**
 * One sheet of the return as a table: a work table that fits its rows, shows the columns its room allows
 * (`columns.tsx`) and becomes a list of cards on a phone. Selection is by row id.
 */
import { ElidedText, type TableSearch } from "@opesvault/ui";
import { useMemo } from "react";
import { ListTable } from "../../components/list_parts.tsx";
import { sheetColumns, type Col } from "./columns.tsx";
import type { Row } from "./rows.ts";

/** Sheets longer than this get a search box. */
export const SEARCH_FROM = 5;

const CELL_SEARCH: TableSearch<Row> = { text: (row) => row.cells.join(" ") };

export interface SheetTableProps {
  /** Accessible name of the table ("Pagamentos efetuados"). */
  label: string;
  cols: readonly Col[];
  rows: readonly Row[];
  selectedId?: string | null;
  onSelect?: (id: string) => void;
  /** Enter or double click. */
  onActivate?: (id: string) => void;
  /** Most rows shown before the table scrolls. */
  max?: number;
  /** A search box over the cells; by default when the sheet has more than `SEARCH_FROM` rows. */
  searchable?: boolean;
  /** Which cell titles the card on a phone (the first by default). */
  titleCell?: number;
}

export function SheetTable({
  label,
  cols,
  rows,
  selectedId,
  onSelect,
  onActivate,
  max = 10,
  titleCell = 0,
  searchable = rows.length > SEARCH_FROM,
}: SheetTableProps) {
  const columns = useMemo(() => sheetColumns(cols), [cols]);
  return (
    <ListTable
      label={label}
      rows={rows}
      columns={columns}
      getRowId={(row) => row.id}
      selectedId={selectedId ?? null}
      {...(onSelect ? { onSelect } : {})}
      {...(onActivate ? { onActivate } : {})}
      max={max}
      {...(searchable ? { search: CELL_SEARCH } : {})}
      cardTitle={(row) => <ElidedText>{row.cells[titleCell] ?? ""}</ElidedText>}
    />
  );
}
