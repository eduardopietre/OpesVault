/**
 * The name of a user action in the undo history ("Desfazer: excluir lançamento"). A screen that knows what the
 * user did names it (`act(..., { label: "reclassificar 3 lançamentos" })`); otherwise the name comes from what
 * the action changed: the main kind of record, whether it was created, removed or changed, and how many.
 */
import { MISSING, describe, type JournalEntry } from "@opesvault/domain";

type Gender = "m" | "f";

/** [singular, plural, gender] by persisted kind, the more meaningful first (an action's main record). */
const NOUNS: readonly (readonly [string, string, string, Gender])[] = [
  ["goal", "meta", "metas", "f"],
  ["budget_line", "orçamento", "orçamentos", "m"],
  ["category_rule", "regra de categoria", "regras de categoria", "f"],
  ["recurrence_rule", "recorrência", "recorrências", "f"],
  ["forecast_link", "vínculo de recorrência", "vínculos de recorrência", "m"],
  ["period_close", "fechamento do mês", "fechamentos do mês", "m"],
  ["loan_plan", "financiamento", "financiamentos", "m"],
  ["loan_payment", "pagamento de financiamento", "pagamentos de financiamento", "m"],
  ["loan_prepayment", "amortização", "amortizações", "f"],
  ["installment_plan", "parcelamento", "parcelamentos", "m"],
  ["reimbursement", "reembolso", "reembolsos", "m"],
  ["member_settlement", "acerto", "acertos", "m"],
  ["balance_check", "conferência de saldo", "conferências de saldo", "f"],
  ["saved_filter", "filtro salvo", "filtros salvos", "m"],
  ["attachment", "comprovante", "comprovantes", "m"],
  ["operation_tags", "marcadores", "marcadores", "m"],
  ["merchant_alias", "nome de estabelecimento", "nomes de estabelecimento", "m"],
  ["reviewed_suspicion", "revisão de suspeita", "revisões de suspeita", "f"],
  ["deductible_category", "categoria dedutível", "categorias dedutíveis", "f"],
  ["import_batch", "importação", "importações", "f"],
  ["extracted_item", "item importado", "itens importados", "m"],
  ["bank_account", "conta bancária", "contas bancárias", "f"],
  ["position", "posição", "posições", "f"],
  ["valuation", "avaliação", "avaliações", "f"],
  ["investment_event", "movimento de investimento", "movimentos de investimento", "m"],
  ["lot", "lote", "lotes", "m"],
  ["asset", "ativo", "ativos", "m"],
  ["benchmark", "referência", "referências", "f"],
  ["investment_profile", "perfil de investimento", "perfis de investimento", "m"],
  ["tax_rule", "regra de imposto", "regras de imposto", "f"],
  ["tax_payment", "pagamento de imposto", "pagamentos de imposto", "m"],
  ["income_report", "informe de rendimentos", "informes de rendimentos", "m"],
  ["declared_asset", "bem declarado", "bens declarados", "m"],
  ["card", "cartão", "cartões", "m"],
  ["account", "conta", "contas", "f"],
  ["member", "integrante", "integrantes", "m"],
  ["operation", "lançamento", "lançamentos", "m"],
];

const VERBS = { change: "alterar", remove: "excluir" } as const;

/** "1 lançamento" stays "lançamento"; "3 lançamentos". */
function counted(count: number, singular: string, plural: string): string {
  return count === 1 ? singular : `${count} ${plural}`;
}

/** The name of an action from its journal entries (see the module comment). */
export function nameAction(entries: readonly JournalEntry[]): string {
  // Per record: what existed before the action and what exists after it.
  const records = new Map<string, { kind: string; before: unknown; after: unknown }>();
  for (const entry of entries) {
    if (entry[0] !== "entity") continue;
    const key = `${entry[1]}\u0000${entry[2]}`;
    const known = records.get(key);
    if (known) known.after = entry[4];
    else records.set(key, { kind: entry[1], before: entry[3], after: entry[4] });
  }
  const changed = [...records.values()].filter((record) => record.before !== record.after);
  for (const [kind, singular, plural, gender] of NOUNS) {
    const mine = changed.filter((record) => record.kind === kind);
    if (!mine.length) continue;
    const created = mine.filter((record) => record.before === MISSING).length;
    const removed = mine.filter((record) => record.after === MISSING).length;
    if (kind === "operation_tags") return "alterar marcadores";
    if (created === mine.length) {
      const adjective = mine.length === 1 ? (gender === "f" ? "nova" : "novo") : gender === "f" ? "novas" : "novos";
      return mine.length === 1 ? `${adjective} ${singular}` : `${mine.length} ${adjective} ${plural}`;
    }
    const verb = removed === mine.length ? VERBS.remove : VERBS.change;
    return `${verb} ${counted(mine.length, singular, plural)}`;
  }
  if (entries.some((entry) => entry[0] === "meta")) return "alterar configurações do projeto";
  const fallback = describe(entries);
  return fallback === "configurações" ? "alterar configurações do projeto" : fallback;
}

/** "reclassificar 3 lançamentos": a verb and a count, in the singular when there is one. */
export function actionName(verb: string, count: number, singular: string, plural: string): string {
  return `${verb} ${counted(count, singular, plural)}`;
}
