/**
 * Plain-language words for the Assistente (the desktop prints the tool names as they are; the web names each
 * tool and each argument in Portuguese): what a call asked, how a link of the model becomes a Livro `ref`, and
 * the guard for CPF and CNPJ (the tools cannot reach them; nothing that looks like one is sent or shown).
 */
import { Dec, tax, type assistant } from "@opesvault/domain";
import { formatBrDate } from "@opesvault/ui";

export const TOOL_LABELS: Readonly<Record<string, string>> = {
  get_overview: "Resumo do projeto",
  list_accounts: "Contas e saldos",
  list_categories: "Categorias",
  list_members: "Integrantes",
  search_operations: "Busca de lançamentos",
  get_operation: "Detalhe de um lançamento",
  spending_by_category: "Despesas por categoria",
  month_summary: "Resumo do mês",
  budget_status: "Orçamento do mês",
  list_tags: "Marcadores",
  list_rules: "Regras de categoria",
  list_pending_import_items: "Itens importados pendentes",
  merchant_totals: "Despesas por estabelecimento",
  show_in_ledger: "Atalho para o Livro",
  reclassify_operations: "Reclassificar lançamentos",
  tag_operations: "Marcador em lançamentos",
  name_merchant: "Nome de estabelecimento",
  create_category_rule: "Regra de categoria",
  set_budget: "Orçamento de uma categoria",
  record_expense: "Registrar despesa",
  record_income: "Registrar receita",
  set_import_item_category: "Categoria de item importado",
};

const ARGUMENT_LABELS: Readonly<Record<string, string>> = {
  month: "mês",
  start: "início",
  end: "fim",
  text: "texto",
  account: "conta",
  member: "integrante",
  tag: "marcador",
  min_amount: "valor mínimo",
  max_amount: "valor máximo",
  status: "situação",
  limit: "limite",
  id: "lançamento",
  kind: "tipo",
  ids: "lançamentos",
  category: "categoria",
  amount: "valor",
  date: "data",
  description: "descrição",
  name: "nome",
  pattern: "trecho",
  reason: "motivo",
  remove: "tirar",
  item: "item",
};

export function toolLabel(name: string): string {
  return TOOL_LABELS[name] ?? name;
}

/** One argument of a call, as a pair of words: ("início", "2026-09-01"). */
export interface CallArgument {
  label: string;
  value: string;
}

function show(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (value instanceof Dec) return value.toString();
  if (Array.isArray(value)) return value.map(show).join(", ");
  if (typeof value === "boolean") return value ? "sim" : "não";
  if (typeof value === "number" || typeof value === "bigint") return String(value);
  return "…";
}

const SPACES = /\s+/g;
const LONGEST = 120;

function clip(text: string): string {
  const flat = sanitize(text).replace(SPACES, " ").trim();
  return flat.length > LONGEST ? `${flat.slice(0, LONGEST - 1)}…` : flat;
}

/** "2026-09-01" → "01/09/2026" and "2026-09" → "09/2026": the dates of the tools are written as people read them. */
function plainDate(text: string): string {
  const month = /^(\d{4})-(\d{2})$/.exec(text);
  return month ? `${month[2]}/${month[1]}` : formatBrDate(text);
}

/** What the model passed, readable by a person; an empty value is left out. */
export function callArguments(raw: unknown): CallArgument[] {
  let given = raw;
  if (typeof raw === "string") {
    try {
      given = JSON.parse(raw) as unknown;
    } catch {
      const text = clip(raw);
      return text ? [{ label: "argumentos", value: text }] : [];
    }
  }
  if (given === null || typeof given !== "object" || Array.isArray(given) || given instanceof Dec) return [];
  return Object.entries(given as Record<string, unknown>).flatMap(([key, value]) => {
    const text = plainDate(clip(show(value)));
    return text ? [{ label: ARGUMENT_LABELS[key] ?? key, value: text }] : [];
  });
}

/** "Consultou search_operations (12 encontrado(s))" (the domain's line) as the tool and its count. */
export function parseActivity(line: string): { tool: string; found: number | null } | null {
  const match = /^Consultou (\S+?)(?: \((\d+) encontrado\(s\)\))?$/.exec(line);
  if (!match) return null;
  return { tool: match[1] as string, found: match[2] !== undefined ? Number(match[2]) : null };
}

/** The Livro's `ref` for a link the model offered (`links.ts`, `parseReveal`): a tag, an account, or an account in a period. */
export function livroRef(link: assistant.reads.LedgerLink): string {
  if (link[0] === "tag") return `marcador:${link[1]}`;
  const period = link[2];
  return period ? `filter:${link[1]}:${period[0]}..${period[1]}` : `conta:${link[1]}`;
}

// ── CPF and CNPJ ─────────────────────────────────────

/** True when the text holds a valid CPF or CNPJ: those never go to the model. */
export function hasTaxId(text: string): boolean {
  return (
    [...text.matchAll(tax.ids.CPF_IN_TEXT)].some((m) => tax.ids.isCpf(m[0] ?? "")) ||
    [...text.matchAll(tax.ids.CNPJ_IN_TEXT)].some((m) => tax.ids.isCnpj(m[0] ?? ""))
  );
}

/** Hides a valid CPF or CNPJ in text about to be shown. */
export function sanitize(text: string): string {
  return text
    .replace(tax.ids.CPF_IN_TEXT, (m) => (tax.ids.isCpf(m) ? "[CPF oculto]" : m))
    .replace(tax.ids.CNPJ_IN_TEXT, (m) => (tax.ids.isCnpj(m) ? "[CNPJ oculto]" : m));
}
