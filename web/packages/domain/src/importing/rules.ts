/**
 * User-defined categorization rules: "description contains X → category Y" (docs/05 §6).
 * Port of `importing/rules.py`.
 *
 * Rules are suggestions, like everything else in review: they fill the category of pending items
 * and never approve anything. A user rule wins over the history of past choices and over the
 * built-in keyword rules; a category picked by hand always wins over every rule.
 */
import { z } from "zod";

import { DomainError, Ledger } from "../domain/ledger.ts";
import { AccountSubtype, type AccountType, zEntityId } from "../domain/model.ts";
import type { Id } from "../lib/ids.ts";
import { zId } from "../lib/schema.ts";
import { items } from "./store.ts";

export const MIN_PATTERN = 3;

/** Uppercase without accents and with single spaces: how descriptions are compared. */
export function normalize(text: string): string {
  const stripped = text.normalize("NFKD").replace(/\p{M}/gu, "");
  return stripped.replace(/\s+/gu, " ").trim().toUpperCase();
}

export const CategoryRuleSchema = z.strictObject({
  id: zEntityId,
  pattern: z.string().min(MIN_PATTERN).max(120), // normalized text the description must contain
  target_account_id: zId, // an income or expense category
  account_id: zId.nullable().default(null), // only for documents of this account or card liability
  active: z.boolean().default(true),
  created_from_item: zId.nullable().default(null),
  version: z.number().int().default(1),
});
export type CategoryRule = Readonly<z.output<typeof CategoryRuleSchema>>;

Ledger.registerKind("category_rule", CategoryRuleSchema);

export function rules(ledger: Ledger) {
  return ledger.entities<CategoryRule>("category_rule");
}

function stripChars(text: string, chars: string): string {
  let start = 0;
  let end = text.length;
  while (start < end && chars.includes(text[start]!)) start++;
  while (end > start && chars.includes(text[end - 1]!)) end--;
  return text.slice(start, end);
}

/**
 * A starting pattern from one description: drops installments, numbers and card ids.
 * "UBER *TRIP 8812 PARCELA 2/3" → "UBER *TRIP"; "LOJA TV (6x)" → "LOJA TV". The user can still edit it.
 */
export function suggestPattern(description: string): string {
  let text = normalize(description);
  text = text.replace(/\bPARC(ELA)?\.?\s*\d+\s*\/\s*\d+\b/g, " ");
  text = text.replace(/\(\s*\d+\s*X\s*\)|\b\d+\s*X\b/g, " "); // "(6x)", "10X": installments
  text = text.replace(/\b\d+\s*\/\s*\d+\b/g, " ");
  text = text.replace(/[\d#]+/g, " ");
  // what is left of a removed number: "( )", a lone "-", "*" or "."
  const words = text.split(/\s+/u).filter((w) => w && /\p{L}/u.test(w));
  text = stripChars(words.join(" ").trim(), " -*.");
  return text || normalize(description);
}

function check(ledger: Ledger, rule: CategoryRule): void {
  const pattern = normalize(rule.pattern);
  if (pattern.length < MIN_PATTERN)
    throw new DomainError(`O texto da regra precisa ter ao menos ${MIN_PATTERN} caracteres.`);
  const target = ledger.accounts.get(rule.target_account_id);
  if (target === undefined || target.subtype !== AccountSubtype.CATEGORY)
    throw new DomainError("Escolha uma categoria de receita ou despesa.");
  if (rule.account_id !== null && !ledger.accounts.has(rule.account_id))
    throw new DomainError("Conta da regra inexistente.");
  for (const other of rules(ledger).values()) {
    if (other.id !== rule.id && other.active && other.pattern === pattern && other.account_id === rule.account_id) {
      throw new DomainError("Já existe uma regra ativa com esse texto para essa conta.");
    }
  }
}

export function addRule(
  ledger: Ledger,
  pattern: string,
  targetId: Id,
  accountId: Id | null = null,
  fromItem: Id | null = null,
): CategoryRule {
  if (normalize(pattern).length < MIN_PATTERN)
    throw new DomainError(`O texto da regra precisa ter ao menos ${MIN_PATTERN} caracteres.`);
  const rule = CategoryRuleSchema.parse({
    pattern: normalize(pattern),
    target_account_id: targetId,
    account_id: accountId,
    created_from_item: fromItem,
  });
  check(ledger, rule);
  return ledger.put("category_rule", rule);
}

export function updateRule(ledger: Ledger, rule: CategoryRule, reason: string): CategoryRule {
  const current = rules(ledger).get(rule.id);
  if (current === undefined) throw new DomainError("Regra inexistente.");
  if (normalize(rule.pattern).length < MIN_PATTERN)
    throw new DomainError(`O texto da regra precisa ter ao menos ${MIN_PATTERN} caracteres.`);
  const updated: CategoryRule = { ...rule, pattern: normalize(rule.pattern), version: current.version + 1 };
  if (updated.active) check(ledger, updated);
  return ledger.put("category_rule", updated, { reason });
}

/** Rules are switched off, not erased, so the history keeps why a category was suggested. */
export function setActive(ledger: Ledger, ruleId: Id, active: boolean, reason: string): CategoryRule {
  const current = rules(ledger).get(ruleId);
  if (current === undefined) throw new DomainError("Regra inexistente.");
  return updateRule(ledger, { ...current, active }, reason);
}

/** The most specific active rule: one limited to this account first, then the longest text. */
export function match(
  ledger: Ledger,
  description: string,
  accountId: Id | null,
  wanted: AccountType | Iterable<AccountType>,
): CategoryRule | null {
  const kinds = new Set<AccountType>(typeof wanted === "string" ? [wanted] : wanted);
  const text = normalize(description);
  let best: { specific: number; length: number; rule: CategoryRule } | null = null;
  for (const rule of rules(ledger).values()) {
    if (!rule.active || !text.includes(rule.pattern)) continue;
    if (rule.account_id !== null && rule.account_id !== accountId) continue;
    const target = ledger.accounts.get(rule.target_account_id);
    if (target === undefined || target.archived || !kinds.has(target.type)) continue;
    const specific = rule.account_id !== null ? 1 : 0;
    const length = [...rule.pattern].length;
    if (best === null || specific > best.specific || (specific === best.specific && length > best.length))
      best = { specific, length, rule };
  }
  return best?.rule ?? null;
}

/** How many review items this rule has categorized (approved or pending). */
export function usage(ledger: Ledger, ruleId: Id): number {
  let n = 0;
  for (const i of items(ledger).values()) if (i.suggestion_source === `user_rule:${ruleId}`) n++;
  return n;
}
