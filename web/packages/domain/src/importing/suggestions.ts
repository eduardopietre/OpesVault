/**
 * Category suggestions for review items (docs/05 §3, step 8). Suggestions never approve anything.
 * Port of `importing/suggestions.py`.
 */
import type { Id } from "../lib/ids.ts";
import type { Ledger } from "../domain/ledger.ts";
import { AccountType } from "../domain/model.ts";
import { suggest as learnedSuggestion } from "./learning.ts";
import { type ExtractedItem, ItemKind, ItemStatus } from "./model.ts";
import { PyRe } from "./parsers/base.ts";
import { match, normalize } from "./rules.ts";
import { batches, items } from "./store.ts";

// Keyword rules for category suggestions. Suggestions never approve anything (docs/05 §5).
export const KEYWORD_RULES: readonly (readonly [string, string])[] = [
  [String.raw`\bIOF\b`, "Impostos e taxas"],
  ["JUROS|MULTA|ENCARGO|ANUIDADE|TARIFA", "Juros e encargos"],
  [String.raw`UBER|99\s*POP|POSTO|SHELL|IPIRANGA|ESTACIONA`, "Transporte"],
  ["IFOOD|MERCADO|SUPERMERC|PADARIA|RESTAURANTE|PAO DE ACUCAR|CARREFOUR", "Alimentação"],
  ["NETFLIX|SPOTIFY|AMAZON PRIME|DISNEY|YOUTUBE|ASSINATURA", "Serviços e assinaturas"],
  ["FARMACIA|DROGA|HOSPITAL|CLINICA|LABORAT", "Saúde"],
  ["ESCOLA|FACULDADE|CURSO|LIVRARIA", "Educação"],
  ["ALUGUEL|CONDOMINIO|ENERGIA|ENEL|SABESP|AGUA|INTERNET|VIVO|CLARO", "Moradia"],
  ["SALARIO|PROVENTOS|FOLHA", "Salário"],
];
const KEYWORD_RES = KEYWORD_RULES.map(([pattern, name]) => [new PyRe(pattern), name] as const);

/** Order of trust: the user's rule, then what the family chose before, then the keyword rules. */
export function suggest(ledger: Ledger, item: ExtractedItem): [Id | null, string | null] {
  if (item.kind === ItemKind.TRADE || item.kind === ItemKind.FEE || item.kind === ItemKind.CARD_PAYMENT)
    return [null, null];
  // a refund (CARD_CREDIT) reduces the original expense category
  const wanted = item.kind === ItemKind.CREDIT ? AccountType.INCOME : AccountType.EXPENSE;
  const batch = batches(ledger).get(item.batch_id);
  const accountId = batch !== undefined ? batch.account_id : null;
  const rule = match(ledger, item.description, accountId, wanted);
  if (rule !== null) return [rule.target_account_id, `user_rule:${rule.id}`];
  const learned = learnedSuggestion(ledger, item.description, wanted, accountId);
  if (learned !== null) return [learned.category_id, learned.source];
  const key = normalize(item.description);
  for (const [re, categoryName] of KEYWORD_RES) {
    if (re.search(key)) {
      for (const account of ledger.categories(wanted)) if (account.name === categoryName) return [account.id, "rule"];
    }
  }
  return [null, null];
}

/** Re-suggests pending items after the rules changed. Categories chosen by hand stay. */
export function applyRules(ledger: Ledger, batchId: Id | null = null): number {
  let changed = 0;
  const store = items(ledger);
  for (const item of [...store.values()]) {
    if (batchId !== null && item.batch_id !== batchId) continue;
    if (item.status !== ItemStatus.READY && item.status !== ItemStatus.NEEDS_REVIEW) continue;
    if (item.target_account_id !== null && item.suggestion_source === null) continue; // a person chose this category
    const [target, source] = suggest(ledger, { ...item, target_account_id: null });
    const oldRule = (item.suggestion_source ?? "").startsWith("user_rule:");
    if (target === null && !oldRule) continue; // nothing better than the current suggestion (e.g. from the local AI)
    if (target !== item.target_account_id || source !== item.suggestion_source) {
      store.set(item.id, { ...item, target_account_id: target, suggestion_source: source });
      changed += 1;
    }
  }
  return changed;
}
