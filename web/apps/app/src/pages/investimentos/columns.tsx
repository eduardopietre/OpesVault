/** The columns of every table of Investimentos (desktop `COLUMNS` of the page and `detail.py`'s tables). */
import { Badge } from "@opesvault/ui";
import type { TierColumn } from "../../components/tier_columns.ts";
import { Warn } from "../../components/list_parts.tsx";
import type { EventRow, LotRow, NoteRow, PortfolioRow, ReturnRow, ValuationRow } from "./rows.ts";

export const PORTFOLIO_COLUMNS: TierColumn<PortfolioRow>[] = [
  {
    id: "name",
    header: "Investimento",
    cell: (r) => r.name,
    sortValue: (r) => r.name,
    grow: 3,
    width: 170,
    tier: 1,
  },
  {
    id: "class",
    header: "Classe",
    cell: (r) => r.assetClass,
    sortValue: (r) => r.assetClass,
    grow: 1,
    width: 130,
    tier: 3,
  },
  { id: "mode", header: "Modo", cell: (r) => r.mode, sortValue: (r) => r.mode, width: 100, tier: 5 },
  {
    id: "cost",
    header: "Custo remanescente",
    cell: (r) => r.cost,
    sortValue: (r) => r.costSort,
    align: "end",
    width: 150,
    tier: 4,
  },
  {
    id: "value",
    header: "Último valor",
    cell: (r) => r.value,
    sortValue: (r) => r.valueSort,
    align: "end",
    width: 130,
    tier: 1,
  },
  { id: "base", header: "Data-base", cell: (r) => r.base, grow: 1, width: 150, tier: 5 },
  {
    id: "unrealized",
    header: "Não realizado",
    // plain text, with the sign in the number: a colored text loses its contrast on a selected row
    cell: (r) => (r.unrealizedSort === null ? <Warn>{r.unrealized}</Warn> : r.unrealized),
    sortValue: (r) => r.unrealizedSort,
    align: "end",
    width: 140,
    tier: 2,
  },
  {
    id: "realized",
    header: "Realizado",
    cell: (r) => r.realized,
    sortValue: (r) => r.realizedSort,
    align: "end",
    width: 130,
    tier: 4,
  },
];

export const VALUATION_COLUMNS: TierColumn<ValuationRow>[] = [
  { id: "date", header: "Data", cell: (r) => r.date, sortValue: (r) => r.on, width: 108, tier: 1 },
  {
    id: "value",
    header: "Valor",
    cell: (r) => r.value,
    sortValue: (r) => r.valueSort,
    align: "end",
    width: 120,
    tier: 1,
  },
  { id: "nature", header: "Natureza", cell: (r) => r.nature, width: 110, tier: 2 },
  { id: "source", header: "Fonte", cell: (r) => r.source, grow: 1, width: 90, tier: 3 },
  {
    id: "used",
    header: "Usada",
    cell: (r) => (r.used ? <Badge tone="accent">usada</Badge> : <span className="text-secondary">não</span>),
    sortValue: (r) => (r.used ? 1 : 0),
    width: 78,
    tier: 2,
  },
  { id: "quantity", header: "Quantidade", cell: (r) => r.quantity, align: "end", width: 100, tier: 5 },
  { id: "note", header: "Observação", cell: (r) => r.note, grow: 2, width: 140, tier: 6 },
];

export const EVENT_COLUMNS: TierColumn<EventRow>[] = [
  { id: "date", header: "Data", cell: (r) => r.date, sortValue: (r) => r.on, width: 108, tier: 1 },
  { id: "kind", header: "Evento", cell: (r) => r.kind, sortValue: (r) => r.kind, grow: 1, width: 110, tier: 1 },
  {
    id: "gross",
    header: "Bruto",
    cell: (r) => r.gross,
    sortValue: (r) => r.grossSort,
    align: "end",
    width: 115,
    tier: 1,
  },
  { id: "cost", header: "Custo atribuído", cell: (r) => r.cost, align: "end", width: 130, tier: 4 },
  { id: "tax", header: "Imposto", cell: (r) => r.tax, align: "end", width: 105, tier: 3 },
  { id: "fees", header: "Taxas", cell: (r) => r.fees, align: "end", width: 90, tier: 5 },
  { id: "net", header: "Líquido", cell: (r) => r.net, align: "end", width: 115, tier: 2 },
  {
    id: "quality",
    header: "Qualidade",
    cell: (r) => (r.incomplete ? <Warn>incompleto</Warn> : r.quality),
    width: 110,
    tier: 3,
  },
];

export const LOT_COLUMNS: TierColumn<LotRow>[] = [
  { id: "acquired", header: "Aquisição", cell: (r) => r.acquired, width: 108, tier: 1 },
  { id: "source", header: "Origem", cell: (r) => r.source, grow: 1, width: 90, tier: 3 },
  { id: "quantity", header: "Quantidade", cell: (r) => r.quantity, align: "end", width: 100, tier: 2 },
  { id: "cost", header: "Custo", cell: (r) => r.cost, align: "end", width: 115, tier: 4 },
  {
    id: "remainingQuantity",
    header: "Qtd. restante",
    cell: (r) => r.remainingQuantity,
    align: "end",
    width: 110,
    tier: 1,
  },
  { id: "remainingCost", header: "Custo restante", cell: (r) => r.remainingCost, align: "end", width: 125, tier: 2 },
];

export const RETURN_COLUMNS: TierColumn<ReturnRow>[] = [
  { id: "method", header: "Método", cell: (r) => r.method, grow: 3, width: 200, tier: 1 },
  {
    id: "value",
    header: "Resultado",
    cell: (r) => (r.available ? r.value : <Warn>{r.value}</Warn>),
    align: "end",
    width: 130,
    tier: 1,
  },
  { id: "quality", header: "Qualidade", cell: (r) => r.quality, width: 105, tier: 3 },
  { id: "notes", header: "Observações", cell: (r) => r.notes, grow: 3, width: 220, tier: 2 },
];

export const NOTE_COLUMNS: TierColumn<NoteRow>[] = [
  { id: "number", header: "Nota", cell: (r) => r.number, sortValue: (r) => r.number, width: 100, tier: 1 },
  { id: "date", header: "Pregão", cell: (r) => r.date, sortValue: (r) => r.dateSort, width: 108, tier: 1 },
  { id: "trades", header: "Negócios", cell: (r) => r.trades, grow: 1, width: 150, tier: 2 },
  { id: "assets", header: "Ativos", cell: (r) => r.assets, grow: 2, width: 140, tier: 3 },
  { id: "gross", header: "Valor", cell: (r) => r.gross, align: "end", width: 115, tier: 1 },
  { id: "fees", header: "Custos", cell: (r) => r.fees, align: "end", width: 100, tier: 4 },
  { id: "tax", header: "IRRF", cell: (r) => r.tax, align: "end", width: 95, tier: 5 },
  {
    id: "state",
    header: "Situação",
    cell: (r) => (r.pending ? <Warn>aguarda aprovação</Warn> : "incorporada"),
    sortValue: (r) => (r.pending ? 0 : 1),
    width: 150,
    tier: 2,
  },
];
