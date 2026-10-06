/**
 * The columns of each sheet of the Imposto de renda page (the headers of desktop `page.py`), with the room
 * each needs and the order in which they give way on a narrow screen (`tier`: 1 always shows).
 *
 * The rows are text built by `rows.ts`; a money column sorts by its exact value, never by its text.
 */
import { MoneyError, parseBrl } from "@opesvault/domain";
import { ElidedText } from "@opesvault/ui";
import type { ReactNode } from "react";
import type { TierColumn } from "../contas/columns.ts";
import { Warn } from "../contas/parts.tsx";
import type { Row } from "./rows.ts";

type Kind = "text" | "money" | "date" | "month" | "count";

export interface Col {
  header: string;
  kind?: Kind;
  width: number;
  tier: number;
  /** Share of the leftover width (a text column grows; a number keeps its width). */
  grow?: number;
}

/** Cells that say something is missing: shown with a shape and the words, never by color alone. */
const MISSING = new Set(["falta", "a definir", "A definir", "não registrado", "não detalhado", "sem registro"]);

/** The exact cents of a money cell ("R$ 1.234,56 *", "-R$ 10,00"), or null for a dash or text. */
export function moneySort(text: string): bigint | null {
  try {
    const value = parseBrl(text.replace("R$", "").replace("*", "").trim());
    return BigInt(value.quantize("0.01", "ROUND_HALF_UP").toFixed().replace(".", ""));
  } catch (error) {
    if (error instanceof MoneyError) return null;
    throw error;
  }
}

function sortOf(kind: Kind, text: string): string | number | bigint | null {
  switch (kind) {
    case "money":
      return moneySort(text);
    case "date": {
      const [d, m, y] = text.split("/");
      return d && m && y ? `${y}-${m}-${d}` : null;
    }
    case "month": {
      const [m, y] = text.split("/");
      return m && y ? `${y}-${m}` : null;
    }
    case "count":
      return Number.parseInt(text, 10) || 0;
    default:
      return text;
  }
}

function render(kind: Kind, text: string): ReactNode {
  if (MISSING.has(text)) return <Warn>{text}</Warn>;
  return kind === "text" ? <ElidedText>{text}</ElidedText> : text;
}

/** The table columns of a sheet. */
export function sheetColumns(cols: readonly Col[]): TierColumn<Row>[] {
  return cols.map((col, index) => {
    const kind = col.kind ?? "text";
    return {
      id: `c${index}`,
      header: col.header,
      cell: (row: Row) => render(kind, row.cells[index] ?? ""),
      sortValue: (row: Row) => sortOf(kind, row.cells[index] ?? ""),
      ...(kind === "money" || kind === "count" ? { align: "end" as const } : {}),
      width: col.width,
      tier: col.tier,
      ...(col.grow ? { grow: col.grow } : {}),
    };
  });
}

export const TAXABLE: Col[] = [
  { header: "Fonte pagadora", width: 140, tier: 1, grow: 1 },
  { header: "CNPJ", width: 172, tier: 2 },
  { header: "Integrante", width: 100, tier: 3 },
  { header: "Rendimentos", kind: "money", width: 132, tier: 1 },
  { header: "INSS", kind: "money", width: 132, tier: 3 },
  { header: "IR retido", kind: "money", width: 132, tier: 2 },
  { header: "13º salário", kind: "money", width: 132, tier: 4 },
  { header: "IR 13º", kind: "money", width: 132, tier: 4 },
];

export const OTHER: Col[] = [
  { header: "Natureza", width: 172, tier: 1 },
  { header: "Fonte", width: 130, tier: 1, grow: 1 },
  { header: "CNPJ", width: 172, tier: 3 },
  { header: "Integrante", width: 100, tier: 3 },
  { header: "Valor", kind: "money", width: 132, tier: 1 },
  { header: "IR retido", kind: "money", width: 132, tier: 2 },
];

export const CARNE: Col[] = [
  { header: "Mês", kind: "month", width: 80, tier: 1 },
  { header: "Integrante", width: 100, tier: 2, grow: 1 },
  { header: "Recebido", kind: "money", width: 132, tier: 1 },
  { header: "DARF pago", kind: "money", width: 130, tier: 1 },
  { header: "Vence", kind: "date", width: 100, tier: 2 },
];

export const PAYMENTS: Col[] = [
  { header: "Tipo", width: 172, tier: 2 },
  { header: "Quem recebeu", width: 140, tier: 1, grow: 1 },
  { header: "CPF/CNPJ", width: 172, tier: 3 },
  { header: "Beneficiário", width: 100, tier: 3 },
  { header: "Pago", kind: "money", width: 132, tier: 1 },
  { header: "Não dedutível", kind: "money", width: 132, tier: 4 },
  { header: "Dedutível", kind: "money", width: 132, tier: 1 },
  { header: "Comprovantes", kind: "count", width: 110, tier: 2 },
];

export const ASSETS: Col[] = [
  { header: "Grupo", width: 100, tier: 2 },
  { header: "Código", width: 70, tier: 3 },
  { header: "Bem", width: 130, tier: 1, grow: 1 },
  { header: "Discriminação", width: 160, tier: 2, grow: 2 },
  { header: "CNPJ", width: 172, tier: 4 },
  { header: "31/12 anterior", kind: "money", width: 132, tier: 3 },
  { header: "31/12", kind: "money", width: 132, tier: 1 },
];

export const DEBTS: Col[] = [
  { header: "Dívida", width: 130, tier: 1, grow: 1 },
  { header: "CNPJ", width: 172, tier: 3 },
  { header: "31/12 anterior", kind: "money", width: 132, tier: 2 },
  { header: "31/12", kind: "money", width: 132, tier: 1 },
];

export const VARIABLE: Col[] = [
  { header: "Mês", kind: "month", width: 80, tier: 1 },
  { header: "Tipo", width: 172, tier: 1, grow: 1 },
  { header: "Vendas", kind: "money", width: 132, tier: 3 },
  { header: "Resultado", kind: "money", width: 132, tier: 1 },
  { header: "Isento", kind: "money", width: 132, tier: 4 },
  { header: "Compensado", kind: "money", width: 132, tier: 4 },
  { header: "Base", kind: "money", width: 132, tier: 2 },
  { header: "Imposto", kind: "money", width: 132, tier: 1 },
  { header: "IR fonte", kind: "money", width: 132, tier: 5 },
  { header: "DARF", kind: "money", width: 132, tier: 2 },
  { header: "Vence", kind: "date", width: 100, tier: 2 },
  { header: "Pago", kind: "money", width: 132, tier: 3 },
];

export const SIMULATION: Col[] = [
  { header: "Item", width: 170, tier: 1, grow: 1 },
  { header: "Simplificada", kind: "money", width: 130, tier: 1 },
  { header: "Completa", kind: "money", width: 130, tier: 1 },
];

export const REPORTS: Col[] = [
  { header: "Fonte", width: 130, tier: 1, grow: 1 },
  { header: "CNPJ", width: 172, tier: 2 },
  { header: "Linhas", kind: "count", width: 70, tier: 3 },
  { header: "Conferência", width: 140, tier: 1 },
];

export const CHECKS: Col[] = [
  { header: "Campo", width: 172, tier: 1, grow: 1 },
  { header: "Informe", kind: "money", width: 132, tier: 1 },
  { header: "Registrado", kind: "money", width: 132, tier: 1 },
  { header: "Diferença", kind: "money", width: 132, tier: 1 },
];

export const DOCUMENTS: Col[] = [
  { header: "Documento", width: 170, tier: 1, grow: 1 },
  { header: "Situação", width: 172, tier: 1 },
];
