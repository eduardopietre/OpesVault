/**
 * The Livro's columns (desktop `OperationsModel`): Data, Descrição, De → Para, Valor, Competência, Tipo,
 * Origem and Situação, plus a checkbox column to pick several operations (reclassify, tag, mark as checked).
 * A cancelled row is dimmed and also says "Cancelado": never color alone. The columns the person hides are
 * remembered on this computer.
 */
import { isActive, type Ledger, type Operation } from "@opesvault/domain";
import { Checkbox, cn, type DataColumn } from "@opesvault/ui";
import {
  KIND_LABELS,
  ORIGIN_LABELS,
  amountKey,
  competenceLabel,
  dateLabel,
  operationAccounts,
  operationAmount,
  operationDate,
} from "./rows.ts";

export const SELECT_COLUMN = "marcar";

/** Columns that cannot be hidden (the desktop's `required`). */
export const REQUIRED_COLUMNS: ReadonlySet<string> = new Set([SELECT_COLUMN, "data", "descricao", "valor"]);

/** Id and title of each optional column, for the "Colunas" menu. */
export const COLUMN_TITLES: readonly (readonly [string, string])[] = [
  ["data", "Data"],
  ["descricao", "Descrição"],
  ["contas", "De → Para"],
  ["valor", "Valor"],
  ["competencia", "Competência"],
  ["tipo", "Tipo"],
  ["origem", "Origem"],
  ["situacao", "Situação"],
];

const dim = (op: Operation) => (isActive(op) ? "" : "text-tertiary");

export interface ColumnContext {
  ledger: Ledger;
  checked: ReadonlySet<string>;
  onCheck: (id: string, value: boolean) => void;
  hidden: ReadonlySet<string>;
  readOnly?: boolean;
  /** Phone layout: each operation is a card whose title carries the checkbox, so there is no column for it. */
  cards?: boolean;
}

export function ledgerColumns({ ledger, checked, onCheck, hidden, cards }: ColumnContext): DataColumn<Operation>[] {
  const all: DataColumn<Operation>[] = [
    {
      id: SELECT_COLUMN,
      header: "Marcar",
      width: 72,
      cell: (op) => (
        // The cell is not the row: ticking must not move the current row or open the editor.
        <span
          className="inline-flex"
          onClick={(event) => event.stopPropagation()}
          onDoubleClick={(event) => event.stopPropagation()}
        >
          <Checkbox
            label={<span className="sr-only">Marcar {op.description}</span>}
            checked={checked.has(op.id)}
            onCheckedChange={(value) => onCheck(op.id, value)}
          />
        </span>
      ),
    },
    {
      id: "data",
      header: "Data",
      width: 104,
      cell: (op) => <span className={dim(op)}>{dateLabel(operationDate(op))}</span>,
      sortValue: (op) => operationDate(op),
    },
    {
      id: "descricao",
      header: "Descrição",
      width: 150,
      grow: 3,
      cell: (op) => (
        <span className={cn("truncate", dim(op))} title={op.notes ?? op.description}>
          {op.description}
        </span>
      ),
      sortValue: (op) => op.description.toLowerCase(),
    },
    {
      id: "contas",
      header: "De → Para",
      width: 160,
      grow: 3,
      priority: cards ? 1 : 2,
      cell: (op) => <span className={dim(op)}>{operationAccounts(ledger, op)}</span>,
      sortValue: (op) => operationAccounts(ledger, op).toLowerCase(),
    },
    {
      id: "valor",
      header: "Valor",
      width: 108,
      align: "end",
      cell: (op) => <span className={dim(op)}>{operationAmount(op)}</span>,
      sortValue: amountKey,
    },
    {
      id: "competencia",
      header: "Competência",
      width: 100,
      priority: 3,
      cell: (op) => <span className={dim(op)}>{competenceLabel(op)}</span>,
      sortValue: (op) => (op.accrual_month ? op.accrual_month.year * 12 + op.accrual_month.month : null),
    },
    {
      id: "tipo",
      header: "Tipo",
      width: 150,
      priority: 3,
      cell: (op) => <span className={dim(op)}>{KIND_LABELS[op.kind] ?? op.kind}</span>,
      sortValue: (op) => (KIND_LABELS[op.kind] ?? op.kind).toLowerCase(),
    },
    {
      id: "origem",
      header: "Origem",
      width: 88,
      priority: 3,
      cell: (op) => <span className={dim(op)}>{ORIGIN_LABELS[op.origin.kind]}</span>,
      sortValue: (op) => ORIGIN_LABELS[op.origin.kind].toLowerCase(),
    },
    {
      id: "situacao",
      header: "Situação",
      width: 92,
      cell: (op) => <span className={dim(op)}>{isActive(op) ? "Ativo" : "Cancelado"}</span>,
      sortValue: (op) => (isActive(op) ? 1 : 0),
    },
  ];
  return all.filter((column) => {
    // The first column of a card is its title, which the page draws (checkbox and description).
    if (cards) return column.id !== "descricao";
    return REQUIRED_COLUMNS.has(column.id) || !hidden.has(column.id);
  });
}
