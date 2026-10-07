/**
 * Readable merchant names suggested by the local AI ("IFD*IFOOD.COM AGENCIA" → "iFood").
 * Port of `importing/ai_merchants.py`.
 *
 * The same three steps as the category suggestions (`ai_suggestions`): `planNames` copies the
 * descriptions on the main thread, `askNames` talks to the model without the ledger, and
 * `applyNames` approves, on the main thread, only the names the user kept in the review. One
 * description per merchant key is asked (`merchants.keyOf`), so a store seen in a hundred
 * operations costs one line. The approval records which model suggested the name.
 */
import type { Id } from "../lib/ids.ts";
import { pyLen } from "../lib/py.ts";
import { DomainError, type Ledger } from "../domain/ledger.ts";
import { isActive } from "../domain/model.ts";
import type { OllamaClient } from "../ai/ollama.ts";
import type { CancelSignal } from "./ai_suggestions.ts";
import { categoryOf } from "./learning.ts";

// ── integration hook: merchant names (`domain/merchants.py`, ported by W4) ──

/** What this module uses of `domain/merchants`. */
export interface MerchantsApi {
  /** The merchant keys that already have an approved name (`a.key for a in aliases(ledger).values()`). */
  approvedKeys(ledger: Ledger): Iterable<string>;
  keyOf(description: string): string;
  merchantOf(ledger: Ledger, description: string): string;
  nameMerchant(ledger: Ledger, description: string, name: string, origin: string | null): unknown;
}
let merchants: MerchantsApi | null = null;

/** TODO(W6-integration): `domain/merchants.ts` registers itself here when it is ported. */
export function registerMerchants(api: MerchantsApi | null): void {
  merchants = api;
}

function api(): MerchantsApi {
  if (merchants === null) throw new Error("domain/merchants is not registered (W6 integration)");
  return merchants;
}

/** One line per merchant key; a plain copy, safe to use off the main thread. */
export interface NameRequest {
  readonly descriptions: readonly string[];
  readonly keys: readonly string[];
  readonly counts: readonly number[]; // operations behind each key
  readonly current: readonly string[]; // the name shown today (approved or cleaned)
}

export interface NameProposal {
  readonly key: string;
  readonly description: string;
  readonly count: number;
  readonly current: string;
  readonly name: string;
  readonly source: string;
}

export interface NameOutcome {
  proposals: NameProposal[];
  asked: number; // merchant keys asked about
  failed: number; // left unanswered (bad answer, interruption)
  cancelled: boolean;
}

/**
 * The merchants of these operations (only income and expenses: a transfer is no merchant).
 * Merchants that already have an approved name are left out unless `renamed`.
 */
export function planNames(ledger: Ledger, operationIds: readonly Id[], renamed = false): NameRequest {
  const m = api();
  const approved = new Set(m.approvedKeys(ledger));
  const found = new Map<string, string[]>();
  for (const opId of operationIds) {
    const op = ledger.operations.get(opId);
    if (op === undefined || !isActive(op) || categoryOf(ledger, op) === null) continue;
    const key = m.keyOf(op.description);
    if (pyLen(key) < 3 || (approved.has(key) && !renamed)) continue;
    found.set(key, [...(found.get(key) ?? []), op.description]);
  }
  const keys = [...found.keys()];
  return {
    descriptions: keys.map((k) => found.get(k)![0]!),
    keys,
    counts: keys.map((k) => found.get(k)!.length),
    current: keys.map((k) => m.merchantOf(ledger, found.get(k)![0]!)),
  };
}

/**
 * Asks the model (no ledger access). Names equal to today's are dropped.
 * Throws AiUnavailable only when nothing at all could be asked.
 */
export async function askNames(
  client: OllamaClient,
  request: NameRequest,
  onProgress: ((done: number, total: number) => void) | null = null,
  cancel: CancelSignal | null = null,
): Promise<NameOutcome> {
  const total = request.descriptions.length;
  const outcome: NameOutcome = { proposals: [], asked: total, failed: 0, cancelled: false };
  if (!total) return outcome;
  const result = await client.suggestNames(
    request.descriptions,
    onProgress !== null ? (handled) => onProgress(handled, total) : null,
    cancel !== null ? () => cancel.aborted : null,
  );
  outcome.cancelled = result.cancelled;
  outcome.failed = result.failed.length;
  for (const s of result.suggestions) {
    if (s.name === request.current[s.index]) continue; // "Ifood" → "iFood" is still worth offering
    outcome.proposals.push({
      key: request.keys[s.index]!,
      description: request.descriptions[s.index]!,
      count: request.counts[s.index]!,
      current: request.current[s.index]!,
      name: s.name,
      source: s.source,
    });
  }
  return outcome;
}

/** Approves the names the user kept (possibly edited). Returns how many and what was refused. */
export function applyNames(ledger: Ledger, chosen: readonly (readonly [NameProposal, string])[]): [number, string[]] {
  const m = api();
  let count = 0;
  const refused: string[] = [];
  for (const [proposal, name] of chosen) {
    try {
      m.nameMerchant(ledger, proposal.description, name, `sugestão ${proposal.source}`);
    } catch (error) {
      if (!(error instanceof DomainError)) throw error;
      refused.push(`${name}: ${error.message}`);
      continue;
    }
    count += 1;
  }
  return [count, refused];
}
