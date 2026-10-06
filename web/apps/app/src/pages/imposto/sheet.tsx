/**
 * One sheet of the return as a table: a work table that fits its rows, shows the columns its room allows
 * (`columns.tsx`) and becomes a list of cards on a phone. Selection is by row id.
 */
import { ElidedText } from "@opesvault/ui";
import { useMemo } from "react";
import { ListTable } from "../../components/list_parts.tsx";
import { sheetColumns, type Col } from "./columns.tsx";
import type { Row } from "./rows.ts";

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
      cardTitle={(row) => <ElidedText>{row.cells[titleCell] ?? ""}</ElidedText>}
    />
  );
}
