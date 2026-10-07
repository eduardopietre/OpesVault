/**
 * Categories learned from use: what the family chose for alike descriptions (docs/05 §6).
 * Port of `importing/learning.py`.
 *
 * Nothing new is stored. What the app "learned" is read from the active operations, so it always
 * reflects the category an operation has now, after any correction or reclassification, whether
 * it came from a document, a manual entry or a recurrence. Descriptions are compared by their
 * merchant key: uppercase, no accents, no numbers, installments or card ids
 * ("UBER *TRIP 8812 PARCELA 2/3" → "UBER *TRIP").
 *
 * Learning sits between the user's explicit rules and the built-in keyword rules, and, like every
 * suggestion, it never approves anything. It also feeds back into the rules:
 *
 * - `proposals`: descriptions categorized the same way several times, offered as a rule;
 * - `contradictions`: user rules the family keeps overriding, so they can be revised.
 *
 * The result is cached until an operation or an account changes (`Ledger.changesOf`).
 */
import type { IsoDate } from "../lib/dates.ts";
import type { Id } from "../lib/ids.ts";
import { pyLen } from "../lib/py.ts";
import { cmpKeys, sortedBy } from "../lib/text.ts";
import type { Ledger } from "../domain/ledger.ts";
import { AccountSubtype, AccountType, cashDate, type Operation } from "../domain/model.ts";
import { match, normalize, rules, suggestPattern } from "./rules.ts";

// A description seen this many times with one category is offered as a rule.
export const PROPOSAL_MIN_COUNT = 3;
// Below this, a key is too generic to learn from ("PIX", "TED", "COMPRA").
export const MIN_KEY_LENGTH = 4;
// Only the most recent choices decide: a family that changed its mind is followed.
export const RECENT_CHOICES = 5;
// A rule is reported as contradicted when the family chose another category this often…
export const CONTRADICTION_MIN_COUNT = 2;
// …and in at least this share (out of 100) of the operations the rule matches.
export const CONTRADICTION_MIN_SHARE = 50;
export const KINDS: readonly AccountType[] = [AccountType.EXPENSE, AccountType.INCOME];
const DATE_MIN = "0001-01-01" as IsoDate;

export function merchantKey(description: string): string {
  return suggestPattern(description);
}

/** One categorized operation: when, where (the money account), which category and its text. */
export interface Choice {
  readonly on: IsoDate;
  readonly category_id: Id;
  readonly account_id: Id | null;
  readonly text: string; // the whole normalized description, for rules that keep numbers
}

export interface Suggestion {
  readonly key: string;
  readonly category_id: Id;
  readonly agreeing: number; // recent choices for this category
  readonly considered: number; // recent choices looked at
  /** Stored in `ExtractedItem.suggestion_source`; read back by `describeSource`. */
  readonly source: string;
}

function suggestion(key: string, categoryId: Id, agreeing: number, considered: number): Suggestion {
  return { key, category_id: categoryId, agreeing, considered, source: `learned:${agreeing}/${considered}` };
}

/** The choices for one merchant key, newest last. */
export class Learned {
  readonly key: string;
  readonly kind: AccountType;
  readonly choices: Choice[] = [];

  constructor(key: string, kind: AccountType) {
    this.key = key;
    this.kind = kind;
  }

  /**
   * The most frequent category among the recent choices; a tie goes to the newest.
   * Choices made on `accountId` win when there are any, like a rule limited to an account.
   */
  decide(accountId: Id | null = null): Suggestion | null {
    const own = this.choices.filter((c) => accountId !== null && c.account_id === accountId);
    const pool = (own.length ? own : this.choices).slice(-RECENT_CHOICES);
    if (!pool.length) return null;
    const counts = new Map<Id, number>();
    const newest = new Map<Id, number>();
    pool.forEach((c, i) => {
      counts.set(c.category_id, (counts.get(c.category_id) ?? 0) + 1);
      newest.set(c.category_id, i);
    });
    let best: Id | null = null;
    for (const category of counts.keys()) {
      if (
        best === null ||
        cmpKeys([counts.get(category)!, newest.get(category)!], [counts.get(best)!, newest.get(best)!]) > 0
      )
        best = category;
    }
    return suggestion(this.key, best!, counts.get(best!)!, pool.length);
  }
}

/** A rule the family's own choices suggest; creating it is the user's decision. */
export interface Proposal {
  readonly pattern: string;
  readonly category_id: Id;
  readonly count: number;
}

export interface Contradiction {
  readonly rule_id: Id;
  readonly matched: number; // operations whose description the rule matches
  readonly contrary: number; // of those, categorized differently by the family
  readonly usual_category_id: Id; // what the family chose instead, most often
}

/** The single income or expense category of an operation and the account the money moved in. */
export function categoryOf(ledger: Ledger, op: Operation): readonly [Id, AccountType, Id | null] | null {
  const categories = [];
  const others: Id[] = [];
  for (const posting of op.postings) {
    const account = ledger.accounts.get(posting.account_id);
    if (account === undefined) return null;
    if (account.subtype === AccountSubtype.CATEGORY && KINDS.includes(account.type)) categories.push(account);
    else others.push(account.id);
  }
  if (new Set(categories.map((c) => c.id)).size !== 1) return null; // a split or a transfer teaches nothing
  const category = categories[0]!;
  if (category.archived) return null;
  return [category.id, category.type, others[0] ?? null];
}

/** Keyed by "<kind>\u0000<merchant key>": Python's (key, kind) tuples. */
export type Knowledge = Map<string, Learned>;

function knowledgeKey(key: string, kind: AccountType): string {
  return `${kind}\u0000${key}`;
}

const CACHE = new WeakMap<Ledger, { stamp: string; found: Knowledge }>();

/** Every merchant key with the categories the family chose for it. */
export function knowledge(ledger: Ledger): Knowledge {
  // Only operations and accounts teach anything: review items changing during an import keep it.
  const stamp = ledger.changesOf("operation", "account").join(",");
  const cached = CACHE.get(ledger);
  if (cached !== undefined && cached.stamp === stamp) return cached.found;
  const found: Knowledge = new Map();
  const seenPlans = new Set<Id>();
  const when = (o: Operation) => cashDate(o) ?? o.occurred_on ?? DATE_MIN;
  for (const op of sortedBy(ledger.activeOperations(), when)) {
    if (op.installment !== null) {
      if (seenPlans.has(op.installment.plan_id)) continue; // one purchase in installments is one choice
      seenPlans.add(op.installment.plan_id);
    }
    const key = merchantKey(op.description);
    if (pyLen(key) < MIN_KEY_LENGTH) continue;
    const category = categoryOf(ledger, op);
    if (category === null) continue;
    const [categoryId, kind, accountId] = category;
    let learned = found.get(knowledgeKey(key, kind));
    if (learned === undefined) {
      learned = new Learned(key, kind);
      found.set(knowledgeKey(key, kind), learned);
    }
    learned.choices.push({
      on: when(op),
      category_id: categoryId,
      account_id: accountId,
      text: normalize(op.description),
    });
  }
  CACHE.set(ledger, { stamp, found });
  return found;
}

/**
 * What the family usually chose for this description: the same merchant key first, then the
 * longest learned key that starts it on a word boundary ("NETFLIX" for "NETFLIX.COM SP").
 */
export function suggest(
  ledger: Ledger,
  description: string,
  wanted: AccountType | Iterable<AccountType>,
  accountId: Id | null = null,
): Suggestion | null {
  const kinds: AccountType[] = typeof wanted === "string" ? [wanted] : [...wanted];
  const key = merchantKey(description);
  if (pyLen(key) < MIN_KEY_LENGTH) return null;
  const learned = knowledge(ledger);
  for (const kind of kinds) {
    const exact = learned.get(knowledgeKey(key, kind));
    if (exact !== undefined) return exact.decide(accountId);
  }
  let best: Learned | null = null;
  for (const entry of learned.values()) {
    if (!kinds.includes(entry.kind) || !key.startsWith(entry.key)) continue;
    const next = key.slice(entry.key.length, entry.key.length + 1);
    if (next !== " " && next !== ".") continue;
    if (best === null || pyLen(entry.key) > pyLen(best.key)) best = entry; // max() keeps the first
  }
  return best === null ? null : best.decide(accountId);
}

/** 'learned:3/4' → 'aprendida: 3 de 4 escolhas recentes'; null for other sources. */
export function describeSource(source: string): string | null {
  if (!source.startsWith("learned:")) return null;
  const rest = source.slice("learned:".length);
  const slash = rest.indexOf("/");
  const agreeing = slash < 0 ? rest : rest.slice(0, slash);
  const considered = slash < 0 ? "" : rest.slice(slash + 1);
  if (agreeing === considered) return `aprendida: ${agreeing} escolha(s) iguais`;
  return `aprendida: ${agreeing} de ${considered} escolhas recentes`;
}

/**
 * Keys always categorized the same way at least `minimum` times, not yet covered by a rule.
 * Most repeated first. A key whose recent choices disagree is left out: a rule would be wrong
 * part of the time.
 */
export function proposals(ledger: Ledger, minimum = PROPOSAL_MIN_COUNT): Proposal[] {
  const found: Proposal[] = [];
  for (const learned of knowledge(ledger).values()) {
    const recent = learned.choices.slice(-RECENT_CHOICES);
    const categories = new Set(recent.map((c) => c.category_id));
    if (learned.choices.length < minimum || categories.size !== 1) continue;
    const categoryId = [...categories][0]!;
    const existing = match(ledger, learned.key, null, learned.kind);
    if (existing !== null && existing.target_account_id === categoryId) continue; // a rule already says so
    found.push({ pattern: learned.key, category_id: categoryId, count: learned.choices.length });
  }
  return sortedBy(found, (p) => [-p.count, p.pattern]);
}

/**
 * Active user rules the family keeps overriding: operations the rule matches, categorized
 * differently after the fact (a correction in review or a reclassification in the ledger).
 */
export function contradictions(ledger: Ledger): Map<Id, Contradiction> {
  const found = new Map<Id, Contradiction>();
  const learned = knowledge(ledger);
  for (const rule of rules(ledger).values()) {
    if (!rule.active) continue;
    const target = ledger.accounts.get(rule.target_account_id);
    if (target === undefined) continue;
    let matched = 0;
    const contrary = new Map<Id, number>();
    for (const entry of learned.values()) {
      if (entry.kind !== target.type) continue;
      for (const choice of entry.choices) {
        if (!choice.text.includes(rule.pattern)) continue;
        if (rule.account_id !== null && choice.account_id !== rule.account_id) continue;
        matched += 1;
        if (choice.category_id !== rule.target_account_id)
          contrary.set(choice.category_id, (contrary.get(choice.category_id) ?? 0) + 1);
      }
    }
    let totalContrary = 0;
    for (const n of contrary.values()) totalContrary += n;
    if (totalContrary >= CONTRADICTION_MIN_COUNT && totalContrary * 100 >= matched * CONTRADICTION_MIN_SHARE) {
      let usual: Id | null = null;
      for (const [category, n] of contrary) if (usual === null || n > contrary.get(usual)!) usual = category; // most_common(1)
      found.set(rule.id, { rule_id: rule.id, matched, contrary: totalContrary, usual_category_id: usual! });
    }
  }
  return found;
}
