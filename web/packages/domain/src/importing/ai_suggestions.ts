/**
 * Optional Ollama category suggestions: for import items, ledger operations and a new entry.
 * Port of `importing/ai_suggestions.py`.
 *
 * Three steps, so the model never blocks the page and the ledger is only touched on the main
 * thread:
 *
 * 1. A plan copies what will be sent: the descriptions, the allowed categories and a few examples
 *    of how the family classified alike places. `planRequests` plans the pending items of an
 *    import, `planOperations` operations already in the ledger and `planDescription` the
 *    description typed in a new entry.
 * 2. `ask` talks to the model. It never sees the ledger, so the user can keep working while it runs.
 * 3. `applySuggestions` fills only import items still pending and without a category; for
 *    operations, the user reviews each change before the reclassification.
 *
 * Spending and income are asked separately, each with only its own categories. The same
 * description repeated (a monthly subscription, installments) is asked once.
 */
import type { IsoDate } from "../lib/dates.ts";
import type { Id } from "../lib/ids.ts";
import { cmpStr, sortedBy } from "../lib/text.ts";
import type { Ledger } from "../domain/ledger.ts";
import { AccountType, cashDate, isActive, type Operation } from "../domain/model.ts";
import { AiUnavailable, DEFAULT_URL, MAX_EXAMPLES, OllamaClient, type Transport } from "../ai/ollama.ts";
import { categoryOf } from "./learning.ts";
import { type ExtractedItem, ItemKind, ItemStatus } from "./model.ts";
import { PyRe } from "./parsers/base.ts";
import { normalize } from "./rules.ts";
import { items, itemsOf } from "./store.ts";

export const SPENDING: readonly ItemKind[] = [ItemKind.PURCHASE, ItemKind.DEBIT, ItemKind.CARD_CHARGE];
export const INCOME: readonly ItemKind[] = [ItemKind.CREDIT];
export const PENDING: readonly ItemStatus[] = [ItemStatus.READY, ItemStatus.NEEDS_REVIEW];
const DATE_MIN = "0001-01-01" as IsoDate;

// Words that say how something was paid, not what it was: they do not make two descriptions alike.
const NOISE = new Set([
  "PIX",
  "TED",
  "DOC",
  "PAG",
  "COMPRA",
  "CARTAO",
  "DEBITO",
  "CREDITO",
  "ENVIADO",
  "RECEBIDO",
  "PARC",
  "PAGAMENTO",
  "TRANSF",
  "TRANSFERENCIA",
  "LTDA",
  "COM",
  "BRASIL",
  "PARCELA",
]);

export interface PlannedSuggestion {
  readonly item_id: Id;
  readonly category_id: Id;
  readonly source: string;
}

/** One group (spending or income) as it will be sent; a plain copy, safe to use off the main thread. */
export class AiRequest {
  readonly descriptions: readonly string[]; // distinct descriptions
  readonly item_ids: readonly (readonly Id[])[]; // the items behind each description
  readonly categories: ReadonlyMap<string, Id>;
  readonly examples: readonly (readonly [string, string])[];

  constructor(
    descriptions: readonly string[],
    itemIds: readonly (readonly Id[])[],
    categories: ReadonlyMap<string, Id>,
    examples: readonly (readonly [string, string])[],
  ) {
    this.descriptions = descriptions;
    this.item_ids = itemIds;
    this.categories = categories;
    this.examples = examples;
  }

  get items(): number {
    return this.item_ids.reduce((n, ids) => n + ids.length, 0);
  }
}

export interface AiOutcome {
  planned: PlannedSuggestion[];
  asked: number; // items asked about
  failed: number; // items left unanswered (bad answer, interruption)
  cancelled: boolean;
}

// ── integration hook: project settings (`domain/settings.py`, ported by W4) ──

export interface AiSettings {
  readonly ai_enabled: boolean;
  readonly ai_model: string | null;
}
let settingsReader: ((ledger: Ledger) => AiSettings) | null = null;

/**
 * `domain/settings.get_settings`. TODO(W6-integration): `domain/settings.ts` registers it when it is
 * ported; until then the project's AI is off, the desktop's default (`ai_enabled=False`).
 */
export function registerSettingsReader(reader: ((ledger: Ledger) => AiSettings) | null): void {
  settingsReader = reader;
}

/** The client the project asks for (Configurações › IA local), or null when the AI is off. */
export function clientFromSettings(ledger: Ledger, transport: Transport, baseUrl = DEFAULT_URL): OllamaClient | null {
  const settings = settingsReader !== null ? settingsReader(ledger) : { ai_enabled: false, ai_model: null };
  if (!settings.ai_enabled || !settings.ai_model) return null;
  return new OllamaClient(settings.ai_model, transport, baseUrl);
}

/**
 * The categories the model may answer, by the name the user sees ("Alimentação › Mercado").
 * The parent goes along: it tells the model what a subcategory is about, and two subcategories with
 * the same name under different parents stay apart.
 */
export function categoryNames(ledger: Ledger, accountType: AccountType): Map<string, Id> {
  const out = new Map<string, Id>();
  for (const account of ledger.categories(accountType)) {
    const parent = account.parent_id ? (ledger.accounts.get(account.parent_id) ?? null) : null;
    out.set(parent ? `${parent.name} › ${account.name}` : account.name, account.id);
  }
  return out;
}

function pending(ledger: Ledger, batchId: Id): ExtractedItem[] {
  return itemsOf(ledger, batchId).filter(
    (i) =>
      PENDING.includes(i.status) &&
      i.target_account_id === null &&
      (SPENDING.includes(i.kind) || INCOME.includes(i.kind)),
  );
}

/** Items the model could help with: pending, without a category, of a kind it classifies. */
export function pendingCount(ledger: Ledger, batchId: Id): number {
  return pending(ledger, batchId).length;
}

const DIGITS = new PyRe(String.raw`\d+`);
const WORD = new PyRe("[A-Z]{3,}");

/** Two descriptions that differ only in numbers (installment, store number) are the same question. */
export function questionKey(description: string): string {
  return DIGITS.sub("#", normalize(description));
}

function wordsOf(description: string): Set<string> {
  const out = new Set<string>();
  for (const m of WORD.finditer(normalize(description))) if (!NOISE.has(m[0])) out.add(m[0]);
  return out;
}

function when(op: Operation): IsoDate {
  return cashDate(op) ?? op.occurred_on ?? DATE_MIN;
}

/**
 * Operations of these categories, the most alike to what is being asked first.
 *
 * They are read from the ledger as it is now, so a correction or a reclassification teaches the
 * model too. Exact repeats of what is asked are left out (for an import, the history suggestion
 * already covers them), so the examples teach the family's criteria for similar places, not the
 * answer to a known one. `skip`: operations being asked about, which must not answer themselves.
 */
function examplesFor(
  ledger: Ledger,
  categories: ReadonlyMap<string, Id>,
  asked: readonly string[],
  skip: ReadonlySet<Id> = new Set(),
): [string, string][] {
  const names = new Map<Id, string>();
  for (const [k, v] of categories) names.set(v, k);
  const askedKeys = new Set(asked.map(questionKey));
  const wanted = new Set<string>();
  for (const d of asked) for (const w of wordsOf(d)) wanted.add(w);
  const latest = new Map<string, readonly [Operation, Id]>();
  for (const op of ledger.activeOperations()) {
    if (skip.has(op.id)) continue;
    const found = categoryOf(ledger, op);
    if (found === null || !names.has(found[0])) continue;
    const key = questionKey(op.description);
    if (askedKeys.has(key)) continue;
    const current = latest.get(key);
    if (current === undefined || when(op) > when(current[0])) latest.set(key, [op, found[0]]);
  }
  const rank = ([op]: readonly [Operation, Id]) => {
    let overlap = 0;
    for (const w of wordsOf(op.description)) if (wanted.has(w)) overlap++;
    return [overlap, when(op)];
  };
  const chosen = sortedBy(latest.values(), rank, true).slice(0, MAX_EXAMPLES);
  return chosen.map(([op, category]) => [op.description, names.get(category)!]);
}

/** What `ask` will send for this batch (main thread: it reads the ledger). */
export function planRequests(ledger: Ledger, batchId: Id): AiRequest[] {
  const pend = pending(ledger, batchId);
  const requests: AiRequest[] = [];
  for (const [kinds, accountType] of [
    [SPENDING, AccountType.EXPENSE],
    [INCOME, AccountType.INCOME],
  ] as const) {
    const categories = categoryNames(ledger, accountType);
    const grouped = new Map<string, ExtractedItem[]>();
    for (const item of pend) {
      if (!kinds.includes(item.kind)) continue;
      const key = questionKey(item.description);
      grouped.set(key, [...(grouped.get(key) ?? []), item]);
    }
    if (!grouped.size || !categories.size) continue;
    const descriptions = [...grouped.values()].map((same) => same[0]!.description);
    requests.push(
      new AiRequest(
        descriptions,
        [...grouped.values()].map((same) => same.map((i) => i.id)),
        categories,
        examplesFor(ledger, categories, descriptions),
      ),
    );
  }
  return requests;
}

/**
 * What `ask` will send for operations already in the ledger (Livro › Sugerir categorias).
 *
 * Only operations with a single income or expense category are asked (a split stays as it is,
 * like in a reclassification). The answers are `PlannedSuggestion`s whose `item_id` is the
 * operation; the user reviews them before anything is reclassified.
 */
export function planOperations(ledger: Ledger, operationIds: readonly Id[]): AiRequest[] {
  const wanted = new Set(operationIds);
  const grouped = new Map<AccountType, Map<string, Operation[]>>();
  for (const opId of operationIds) {
    const op = ledger.operations.get(opId);
    const found = op !== undefined && isActive(op) ? categoryOf(ledger, op) : null;
    if (op === undefined || found === null) continue;
    const byKey = grouped.get(found[1]) ?? new Map<string, Operation[]>();
    grouped.set(found[1], byKey);
    const key = questionKey(op.description);
    byKey.set(key, [...(byKey.get(key) ?? []), op]);
  }
  const requests: AiRequest[] = [];
  for (const accountType of [AccountType.EXPENSE, AccountType.INCOME]) {
    const groups = grouped.get(accountType);
    const categories = categoryNames(ledger, accountType);
    if (!groups?.size || !categories.size) continue;
    const descriptions = [...groups.values()].map((same) => same[0]!.description);
    requests.push(
      new AiRequest(
        descriptions,
        [...groups.values()].map((same) => same.map((op) => op.id)),
        categories,
        examplesFor(ledger, categories, descriptions, wanted),
      ),
    );
  }
  return requests;
}

/** One description typed in a new entry; the answer only selects the category in the form. */
export function planDescription(ledger: Ledger, description: string, accountType: AccountType): AiRequest | null {
  const categories = categoryNames(ledger, accountType);
  if (!description.trim() || !categories.size) return null;
  return new AiRequest([description], [[]], categories, examplesFor(ledger, categories, [description]));
}

/** Something that can be cancelled, like an `AbortSignal`. */
export interface CancelSignal {
  readonly aborted: boolean;
}

/**
 * Asks the model (no ledger access). Progress counts distinct descriptions.
 * Throws AiUnavailable only when nothing at all could be asked.
 */
export async function ask(
  client: OllamaClient,
  requests: readonly AiRequest[],
  onProgress: ((done: number, total: number) => void) | null = null,
  cancel: CancelSignal | null = null,
): Promise<AiOutcome> {
  const outcome: AiOutcome = { planned: [], asked: 0, failed: 0, cancelled: false };
  const total = requests.reduce((n, r) => n + r.descriptions.length, 0);
  let done = 0;
  for (const request of requests) {
    outcome.asked += request.items;
    if (cancel !== null && cancel.aborted) {
      outcome.cancelled = true;
      outcome.failed += request.items;
      continue;
    }
    const base = done;
    let result;
    try {
      result = await client.suggestCategories(
        request.descriptions,
        [...request.categories.keys()].sort(cmpStr),
        request.examples,
        onProgress !== null ? (handled) => onProgress(base + handled, total) : null,
        cancel !== null ? () => cancel.aborted : null,
      );
    } catch (error) {
      if (error instanceof AiUnavailable && (outcome.planned.length || done)) {
        outcome.failed += request.items;
        break;
      }
      throw error;
    }
    done += request.descriptions.length;
    outcome.cancelled ||= result.cancelled;
    for (const suggestion of result.suggestions) {
      const category = request.categories.get(suggestion.category)!;
      for (const itemId of request.item_ids[suggestion.index]!)
        outcome.planned.push({ item_id: itemId, category_id: category, source: suggestion.source });
    }
    for (const n of result.failed) outcome.failed += request.item_ids[n]!.length;
  }
  return outcome;
}

/** Plans and asks in one go (scripts and tests). Reads only; never writes. */
export async function askAi(ledger: Ledger, batchId: Id, client: OllamaClient): Promise<PlannedSuggestion[]> {
  return (await ask(client, planRequests(ledger, batchId))).planned;
}

/** Fills items still pending and without a category (the user may have chosen meanwhile). */
export function applySuggestions(ledger: Ledger, planned: readonly PlannedSuggestion[]): number {
  const store = items(ledger);
  let count = 0;
  for (const plan of planned) {
    const item = store.get(plan.item_id);
    if (item === undefined || item.target_account_id !== null || !PENDING.includes(item.status)) continue;
    store.set(item.id, { ...item, target_account_id: plan.category_id, suggestion_source: plan.source });
    count += 1;
  }
  return count;
}

/** All steps at once (scripts and tests). Returns how many were suggested. */
export async function suggestWithAi(
  ledger: Ledger,
  batchId: Id,
  client: OllamaClient | null,
  transport: Transport | null = null,
): Promise<number> {
  const chosen = client ?? (transport !== null ? clientFromSettings(ledger, transport) : null);
  if (chosen === null) return 0;
  return applySuggestions(ledger, await askAi(ledger, batchId, chosen));
}

// ── models used in this session, released when the project closes ──

const used = new Map<string, { model: string; url: string; transport: Transport }>();

export function rememberUsed(client: OllamaClient, transport: Transport): void {
  used.set(`${client.model}\u0000${client.baseUrl}`, { model: client.model, url: client.baseUrl, transport });
}

/** Unloads the models this session used, and with them the prompts Ollama still caches. */
export async function releaseModels(): Promise<void> {
  const models = sortedBy(used.values(), (u) => [u.model, u.url]);
  used.clear();
  for (const { model, url, transport } of models) await new OllamaClient(model, transport, url).unload();
}
