/**
 * Readable merchant names: "IFD*IFOOD.COM AGENCIA" → "iFood" (docs/09 §1.3 D).
 * Port of `domain/merchants.py`.
 *
 * The bank's description stays untouched in the operation. A name approved by the user is an
 * alias kept beside it, matched by the cleaned description, so search, reports and rules can read
 * "iFood" without changing a single record. The cleaning is deterministic; the local AI may
 * suggest names elsewhere, but nothing here depends on it.
 */
import { z } from "zod";

import type { IsoDate } from "../lib/dates.ts";
import { Dec } from "../lib/dec.ts";
import type { Id } from "../lib/ids.ts";
import { collapseSpaces } from "../lib/py.ts";
import { sortedBy } from "../lib/text.ts";
import { normalize } from "../importing/rules.ts";
import { DomainError, Ledger } from "./ledger.ts";
import { AccountType, cashDate, type Operation, zEntityId } from "./model.ts";
import { ZERO } from "./money.ts";

// Payment processors that prefix the merchant on card statements.
const SPACE = "\\t\\n\\v\\f\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
export const PREFIXES = new RegExp(
  `^(?:IFD|MP|PAG|PG|EC|EBN|PP|DL|SUMUP|STONE|PAYPAL|GOOGLE|APPLE\\.COM/BILL|HTM|CIELO|GETNET)[${SPACE}]*\\*[${SPACE}]*`,
  "u",
);
const INSTALLMENT = /\(\p{Nd}+\/\p{Nd}+\)|\p{Nd}+\/\p{Nd}+/gu;
// Python's `\b` is Unicode-aware: a word boundary after "COM" means no letter, digit or "_" follows.
const DOT_COM = /\.COM(\.BR)?(?![\p{L}\p{N}_])/gu;
const SEPARATORS = new RegExp(`[${SPACE}*/\\-_.,]+`, "u");
/** Characters for which Python's `str.isdigit()` is true (decimal digits and superscripts/subscripts). */
const DIGIT = /[\p{Nd}\u00b2\u00b3\u00b9\u2070\u2074-\u2079\u2080-\u2089]/u;

export const NOISE: ReadonlySet<string> = new Set([
  "LTDA",
  "ME",
  "EIRELI",
  "SA",
  "S/A",
  "BR",
  "BRA",
  "BRASIL",
  "COM",
  "WWW",
  "AGENCIA",
  "PARCELA",
]);
export const MAX_WORDS = 3;

export const MerchantAliasSchema = z.strictObject({
  id: zEntityId,
  key: z.string().min(1).max(120), // normalized cleaned description
  name: z.string().min(1).max(60),
});
export type MerchantAlias = Readonly<z.output<typeof MerchantAliasSchema>>;

Ledger.registerKind("merchant_alias", MerchantAliasSchema);

export function aliases(ledger: Ledger) {
  return ledger.entities<MerchantAlias>("merchant_alias");
}

const PY_STRIP = new RegExp(`^[${SPACE}]+|[${SPACE}]+$`, "gu");

function capitalize(word: string): string {
  const [first = "", ...rest] = [...word];
  return first.toUpperCase() + rest.join("").toLowerCase();
}

/** The merchant part of a card or bank description, in title case ('Padaria Real'). */
export function clean(description: string): string {
  let text = description.toUpperCase().replace(PY_STRIP, "");
  text = text.replace(PREFIXES, "");
  text = text.replace(INSTALLMENT, " "); // installment marks
  text = text.replace(DOT_COM, " ");
  const words = text.split(SEPARATORS).filter((w) => w);
  const kept = words.filter((w) => !NOISE.has(w) && !DIGIT.test(w));
  if (!kept.length) return [...description.replace(PY_STRIP, "")].slice(0, 60).join("") || "?";
  return kept.slice(0, MAX_WORDS).map(capitalize).join(" ");
}

export function keyOf(description: string): string {
  return normalize(clean(description));
}

function aliasFor(ledger: Ledger, key: string): MerchantAlias | null {
  for (const a of aliases(ledger).values()) if (a.key === key) return a;
  return null;
}

/** The approved name for this description, or the cleaned description. */
export function merchantOf(ledger: Ledger, description: string): string {
  const found = aliasFor(ledger, keyOf(description));
  return found !== null ? found.name : clean(description);
}

/**
 * Approves a readable name for every operation whose description cleans to the same key.
 *
 * `origin` goes to the history with the approval (a name the local AI suggested records the model
 * and prompt version that suggested it, docs/05 §5).
 */
export function nameMerchant(
  ledger: Ledger,
  description: string,
  name: string,
  origin: string | null = null,
): MerchantAlias {
  const display = collapseSpaces(name);
  if (!display) throw new DomainError("Informe o nome do estabelecimento.");
  if ([...display].length > 60) throw new DomainError("Use até 60 caracteres.");
  const key = keyOf(description);
  const current = aliasFor(ledger, key);
  if (current === null) {
    return ledger.put("merchant_alias", MerchantAliasSchema.parse({ key, name: display }), { reason: origin });
  }
  if (current.name === display) return current;
  return ledger.put("merchant_alias", { ...current, name: display }, { reason: origin || "nome alterado" });
}

export function removeAlias(ledger: Ledger, aliasId: Id): void {
  if (aliases(ledger).has(aliasId)) aliases(ledger).delete(aliasId);
}

export interface MerchantTotal {
  readonly name: string;
  readonly expense: Dec;
  readonly count: number;
  /** The name was approved by the user (otherwise it is the cleaned description). */
  readonly approved: boolean;
}

/** Expense per merchant between two dates (occurrence date), largest first. */
export function totals(ledger: Ledger, start: IsoDate, end: IsoDate): MerchantTotal[] {
  const approved = new Set([...aliases(ledger).values()].map((a) => a.key));
  const sums = new Map<string, Dec>();
  const counts = new Map<string, number>();
  const flags = new Map<string, boolean>();
  for (const op of ledger.activeOperations()) {
    const when = op.occurred_on ?? cashDate(op);
    if (when === null || !(start <= when && when <= end)) continue;
    const value = expenseOf(ledger, op);
    if (value.isZero()) continue;
    const name = merchantOf(ledger, op.description);
    sums.set(name, (sums.get(name) ?? ZERO).add(value));
    counts.set(name, (counts.get(name) ?? 0) + 1);
    flags.set(name, (flags.get(name) ?? false) || approved.has(keyOf(op.description)));
  }
  const out: MerchantTotal[] = [];
  for (const [n, v] of sums) {
    if (!v.isZero()) out.push({ name: n, expense: v, count: counts.get(n)!, approved: flags.get(n)! });
  }
  return sortedBy(out, (m) => m.expense, true);
}

function expenseOf(ledger: Ledger, op: Operation): Dec {
  return Dec.sum(
    op.postings.filter((p) => ledger.account(p.account_id).type === AccountType.EXPENSE).map((p) => p.amount),
    ZERO,
  );
}
