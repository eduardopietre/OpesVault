/**
 * Shared replay machinery for the W5 golden files (scripts/golden/cases_investments.py and
 * cases_tax.py): ids created while replaying are random on both sides, so every id that is not
 * in the base records is written "<new>"; "$N" is the id returned by command N and "@name" a base id.
 */
import { DomainError, type Ledger, type LedgerRecord } from "../src/domain/ledger.ts";
import { dump } from "../src/domain/model.ts";
import type { IsoDate } from "../src/lib/dates.ts";
import type { Id } from "../src/lib/ids.ts";

const UUID_TEXT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const UUID_IN_TEXT = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
export const MISSING_REF = "00000000-0000-4000-8000-0000000000ff";

export interface Command {
  readonly cmd: string;
  readonly args?: unknown[];
  readonly opts?: Record<string, unknown>;
}

export interface Scenario<S = unknown> {
  readonly name: string;
  readonly records: LedgerRecord[];
  readonly names: Record<string, Id>;
  readonly commands: Command[];
  readonly results: unknown[];
  readonly snapshot: S;
}

export function norm(value: unknown, known: ReadonlySet<string>): unknown {
  if (typeof value === "string") return value.replace(UUID_IN_TEXT, (id) => (known.has(id) ? id : "<new>"));
  if (Array.isArray(value)) return value.map((v) => norm(v, known));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, norm(v, known)]));
  }
  return value;
}

/** `entity.model_dump(mode="json")`, or null. */
export function dumpOrNull(entity: unknown): unknown {
  return entity === null || entity === undefined ? null : dump(entity);
}

function collect(value: unknown, out: Set<string>): void {
  if (typeof value === "string") {
    if (UUID_TEXT.test(value)) out.add(value);
  } else if (Array.isArray(value)) {
    for (const v of value) collect(v, out);
  } else if (value && typeof value === "object") {
    for (const v of Object.values(value)) collect(v, out);
  }
}

export function knownIds(records: readonly LedgerRecord[]): Set<string> {
  const out = new Set<string>();
  for (const r of records) {
    out.add(r.id);
    collect(r.payload, out);
  }
  return out;
}

export type CommandTable = Record<string, (ledger: Ledger, args: unknown[], opts: Record<string, unknown>) => unknown>;

/** Python's `isinstance(result, BaseModel) and hasattr(result, "id")`: entities have a string id. */
function entityId(result: unknown): string | null {
  if (result && typeof result === "object" && !Array.isArray(result) && !(result instanceof Map)) {
    const id = (result as { id?: unknown }).id;
    if (typeof id === "string") return id;
  }
  return null;
}

export function runCommands(
  ledger: Ledger,
  commands: readonly Command[],
  names: Record<string, Id>,
  table: CommandTable,
  known: ReadonlySet<string>,
  result: (value: unknown) => unknown = entityJson,
): unknown[] {
  const refs = new Map<string, string>();
  const resolve = (value: unknown): unknown => {
    if (typeof value === "string" && value.startsWith("$")) return refs.get(value) ?? MISSING_REF;
    if (typeof value === "string" && value.startsWith("@")) return names[value.slice(1)];
    if (Array.isArray(value)) return value.map(resolve);
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolve(v)]));
    }
    return value;
  };
  const out: unknown[] = [];
  commands.forEach((command, index) => {
    const args = (command.args ?? []).map(resolve);
    const opts = resolve(command.opts ?? {}) as Record<string, unknown>;
    const run = table[command.cmd];
    if (run === undefined) throw new Error(`unknown command ${command.cmd}`);
    let value: unknown;
    try {
      value = run(ledger, args, opts);
    } catch (error) {
      out.push(error instanceof DomainError ? { error: error.message } : { raised: true });
      return;
    }
    const id = entityId(value);
    if (id !== null) refs.set(`$${index}`, id);
    out.push({ ok: norm(result(value), known) });
  });
  return out;
}

/** Python's `j()` of an entity: its persisted JSON (decimals as text). */
export function entityJson(value: unknown): unknown {
  return value === null || value === undefined ? null : dump(value);
}

export const asDate = (value: unknown) => value as IsoDate;
