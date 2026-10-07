/**
 * The assistant's tools, described the way MCP describes them (name, description, inputSchema).
 * Port of `assistant/tools.py`.
 *
 * The app is the host: the local model only asks for a tool; the app validates the arguments, runs
 * reads itself and prepares each change for the user to approve. There is no MCP server process and
 * no port: nothing outside this app can reach the vault through these tools.
 *
 * A tool is either a read (`run` returns data) or an edit (`prepare` checks everything and returns
 * a `PreparedEdit` that says in words what will change; only `PreparedEdit.apply`, called after the
 * user approves, touches the ledger). Arguments are validated against a field list with Pydantic's
 * lax-mode rules and `extra="forbid"`, so an unknown field or a wrong type is an error sent back to
 * the model, never a guess.
 *
 * Accounts, categories and members are referred to by name (a small model copies names better than
 * UUIDs); operations by the short `id` the read tools return (the first 8 hex digits).
 */
import { parseJson, type JsonValue } from "../ai/ollama.ts";
import { DomainError, type Ledger } from "../domain/ledger.ts";
import { AccountSubtype, AccountType, type LedgerAccount, type Operation } from "../domain/model.ts";
import { CENT, MoneyError, parseBrl, toDecimal } from "../domain/money.ts";
import {
  type IsoDate,
  isIsoDate,
  addDays,
  fromOrdinal,
  toOrdinal,
  weekday,
  makeDate,
  type YearMonth,
  ym,
} from "../lib/dates.ts";
import { Dec } from "../lib/dec.ts";
import type { Id } from "../lib/ids.ts";
import { PyRe } from "../importing/parsers/base.ts";
import { casefold, sortedBy } from "../lib/text.ts";
import { collapseSpaces, pyLen, pyStrip } from "../lib/py.ts";

export const MAX_ROWS = 50; // rows a read returns at most; the total says how many matched
export const SHORT_ID = 8;

export const ToolKind = { READ: "read", EDIT: "edit" } as const;
export type ToolKind = (typeof ToolKind)[keyof typeof ToolKind];

/** The arguments are wrong in a way the model can fix; the message goes back to it. */
export class ToolError extends Error {
  override name = "ToolError";
}

/** What the tools need from the outside: Python's `date.today()`. */
export interface ToolContext {
  readonly today: IsoDate;
}

/** A change checked and described, waiting for the user. Nothing has changed yet. */
export interface PreparedEdit {
  readonly tool: string;
  readonly summary: string; // one line, shown as the title of the approval
  readonly details: readonly string[]; // what exactly changes, one line each
  readonly apply: () => Record<string, unknown>; // runs on the UI thread, after the approval
}

// ── arguments (Pydantic's lax mode, extra="forbid") ──

export type Field =
  | { kind: "str"; description: string; required: boolean; min?: number; max?: number }
  | { kind: "int"; description: string; default: number; ge: number; le: number }
  | { kind: "bool"; description: string; default: boolean }
  | { kind: "literal"; description: string; values: readonly string[]; default: string }
  | { kind: "strlist"; description: string; min: number; max: number }
  /** Kept as the model sent it; `money` converts it (`AmountText`). */
  | { kind: "any"; description: string };

export type ArgSpec = readonly (readonly [string, Field])[];

/** Optional text (`str | None = None`) with its length limits. */
export function optionalText(description: string): Field {
  return { kind: "str", description, required: false };
}
export function text(description: string, min?: number, max?: number): Field {
  return {
    kind: "str",
    description,
    required: true,
    ...(min !== undefined && { min }),
    ...(max !== undefined && { max }),
  };
}

interface Problem {
  readonly loc: readonly (string | number)[];
  readonly type: "missing" | "extra_forbidden" | "other";
  readonly msg: string;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function isPlainObject(v: unknown): v is Record<string, JsonValue> {
  return v !== null && typeof v === "object" && !Array.isArray(v) && !(v instanceof Dec);
}

const INT_TEXT = /^[+-]?\d+(?:_\d+)*(?:\.0*)?$/;

/** Pydantic's lax `int`: integers, integral decimals, booleans and integer text. */
function laxInt(value: unknown): { ok: bigint } | { error: string } {
  if (typeof value === "boolean") return { ok: value ? 1n : 0n };
  if (typeof value === "bigint") return { ok: value };
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return { error: "Input should be a finite number" };
    if (!Number.isInteger(value))
      return { error: "Input should be a valid integer, got a number with a fractional part" };
    return { ok: BigInt(value) };
  }
  if (value instanceof Dec) {
    if (!value.eq(value.toIntegral("ROUND_FLOOR")))
      return { error: "Input should be a valid integer, got a number with a fractional part" };
    return { ok: BigInt(value.toIntegral("ROUND_FLOOR").toFixed()) };
  }
  if (typeof value === "string") {
    const trimmed = pyStrip(value);
    if (INT_TEXT.test(trimmed))
      return { ok: BigInt(trimmed.replaceAll("_", "").replace(/\..*$/, "").replace(/^\+/, "")) };
    return { error: "Input should be a valid integer, unable to parse string as an integer" };
  }
  return { error: "Input should be a valid integer" };
}

const I64_MAX = 2n ** 63n - 1n;
const TRUE_TEXT = new Set(["1", "on", "t", "true", "y", "yes"]);
const FALSE_TEXT = new Set(["0", "off", "f", "false", "n", "no"]);

function laxBool(value: unknown): { ok: boolean } | { error: string } {
  if (typeof value === "boolean") return { ok: value };
  const unknownValue = { error: "Input should be a valid boolean, unable to interpret input" };
  const plain = { error: "Input should be a valid boolean" };
  if (typeof value === "number" || typeof value === "bigint") {
    if (value === 0 || value === 0n) return { ok: false };
    if (value === 1 || value === 1n) return { ok: true };
    return BigInt(value) > I64_MAX || BigInt(value) < -I64_MAX - 1n ? plain : unknownValue;
  }
  if (value instanceof Dec) {
    if (value.isZero()) return { ok: false };
    if (value.eq(Dec.from(1))) return { ok: true };
    if (!value.eq(value.toIntegral("ROUND_FLOOR"))) return plain;
    const whole = BigInt(value.toIntegral("ROUND_FLOOR").toFixed());
    return whole > I64_MAX || whole < -I64_MAX - 1n ? plain : unknownValue;
  }
  if (typeof value === "string") {
    const lowered = value.toLowerCase();
    if (TRUE_TEXT.has(lowered)) return { ok: true };
    if (FALSE_TEXT.has(lowered)) return { ok: false };
    return unknownValue;
  }
  return { error: "Input should be a valid boolean" };
}

function quoted(values: readonly string[]): string {
  const marked = values.map((v) => `'${v}'`);
  return marked.length === 1 ? marked[0]! : `${marked.slice(0, -1).join(", ")} or ${marked.at(-1)}`;
}

function checkText(
  name: string,
  field: Extract<Field, { kind: "str" }>,
  value: unknown,
  out: Problem[],
): string | null {
  if (typeof value !== "string") {
    out.push({ loc: [name], type: "other", msg: "Input should be a valid string" });
    return null;
  }
  const n = pyLen(value);
  if (field.min !== undefined && n < field.min) {
    out.push({ loc: [name], type: "other", msg: `String should have at least ${plural(field.min, "character")}` });
    return null;
  }
  if (field.max !== undefined && n > field.max) {
    out.push({ loc: [name], type: "other", msg: `String should have at most ${plural(field.max, "character")}` });
    return null;
  }
  return value;
}

/** Validates `input` against `spec`: the parsed arguments, or the problems in Pydantic's order. */
export function validateArgs(
  spec: ArgSpec,
  input: Record<string, unknown>,
): { value: Record<string, unknown> } | { problems: Problem[] } {
  const problems: Problem[] = [];
  const value: Record<string, unknown> = {};
  for (const [name, field] of spec) {
    const present = Object.hasOwn(input, name);
    const raw = input[name];
    switch (field.kind) {
      case "str": {
        if (!present) {
          if (field.required) problems.push({ loc: [name], type: "missing", msg: "Field required" });
          else value[name] = null;
        } else if (raw === null && !field.required) value[name] = null;
        else {
          const checked = checkText(name, field, raw, problems);
          if (checked !== null) value[name] = checked;
        }
        break;
      }
      case "int": {
        if (!present) {
          value[name] = field.default;
          break;
        }
        const parsed = laxInt(raw);
        if ("error" in parsed) problems.push({ loc: [name], type: "other", msg: parsed.error });
        else if (parsed.ok < BigInt(field.ge))
          problems.push({ loc: [name], type: "other", msg: `Input should be greater than or equal to ${field.ge}` });
        else if (parsed.ok > BigInt(field.le))
          problems.push({ loc: [name], type: "other", msg: `Input should be less than or equal to ${field.le}` });
        else value[name] = Number(parsed.ok);
        break;
      }
      case "bool": {
        if (!present) {
          value[name] = field.default;
          break;
        }
        const parsed = laxBool(raw);
        if ("error" in parsed) problems.push({ loc: [name], type: "other", msg: parsed.error });
        else value[name] = parsed.ok;
        break;
      }
      case "literal": {
        if (!present) value[name] = field.default;
        else if (typeof raw === "string" && field.values.includes(raw)) value[name] = raw;
        else problems.push({ loc: [name], type: "other", msg: `Input should be ${quoted(field.values)}` });
        break;
      }
      case "strlist": {
        if (!present) problems.push({ loc: [name], type: "missing", msg: "Field required" });
        else if (!Array.isArray(raw))
          problems.push({ loc: [name], type: "other", msg: "Input should be a valid list" });
        else if (raw.length > field.max)
          problems.push({
            loc: [name],
            type: "other",
            msg: `List should have at most ${plural(field.max, "item")} after validation, not ${raw.length}`,
          });
        else {
          let bad = false;
          raw.forEach((item, i) => {
            if (typeof item !== "string") {
              bad = true;
              problems.push({ loc: [name, i], type: "other", msg: "Input should be a valid string" });
            }
          });
          if (!bad && raw.length < field.min)
            problems.push({
              loc: [name],
              type: "other",
              msg: `List should have at least ${plural(field.min, "item")} after validation, not ${raw.length}`,
            });
          else if (!bad) value[name] = [...(raw as string[])];
        }
        break;
      }
      case "any": {
        if (!present) problems.push({ loc: [name], type: "missing", msg: "Field required" });
        else value[name] = raw;
        break;
      }
    }
  }
  const known = new Set(spec.map(([name]) => name));
  for (const key of Object.keys(input))
    if (!known.has(key)) problems.push({ loc: [key], type: "extra_forbidden", msg: "Extra inputs are not permitted" });
  return problems.length ? { problems } : { value };
}

function problemText(p: Problem): string {
  if (p.type === "missing") return "obrigatório";
  if (p.type === "extra_forbidden") return "campo que não existe";
  return p.msg;
}

/** The JSON Schema Pydantic gives the model (`model_json_schema()` without titles). */
function desc(field: { description: string }): { description?: string } {
  return field.description ? { description: field.description } : {};
}

export function jsonSchema(spec: ArgSpec): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const [name, field] of spec) {
    switch (field.kind) {
      case "str":
        if (field.required) {
          required.push(name);
          properties[name] = {
            ...desc(field),
            type: "string",
            ...(field.min !== undefined && { minLength: field.min }),
            ...(field.max !== undefined && { maxLength: field.max }),
          };
        } else {
          properties[name] = {
            anyOf: [{ type: "string" }, { type: "null" }],
            default: null,
            ...desc(field),
          };
        }
        break;
      case "int":
        properties[name] = {
          default: field.default,
          ...desc(field),
          maximum: field.le,
          minimum: field.ge,
          type: "integer",
        };
        break;
      case "bool":
        properties[name] = { default: field.default, ...desc(field), type: "boolean" };
        break;
      case "literal":
        properties[name] = {
          default: field.default,
          ...desc(field),
          enum: [...field.values],
          type: "string",
        };
        break;
      case "strlist":
        required.push(name);
        properties[name] = {
          ...desc(field),
          items: { type: "string" },
          maxItems: field.max,
          minItems: field.min,
          type: "array",
        };
        break;
      case "any":
        required.push(name);
        properties[name] = { ...desc(field), type: "string" };
        break;
    }
  }
  return { additionalProperties: false, properties, ...(required.length && { required }), type: "object" };
}

// ── tools and their registry ────────────────────────

export interface Tool {
  readonly name: string;
  readonly description: string;
  readonly arguments: ArgSpec;
  readonly kind: ToolKind;
  readonly run: ((ledger: Ledger, args: Args, ctx: ToolContext) => unknown) | null; // reads
  /** edits; the string is the origin */
  readonly prepare: ((ledger: Ledger, args: Args, origin: string, ctx: ToolContext) => PreparedEdit) | null;
}

/** Validated arguments: field names as the model wrote them. */
export type Args = Record<string, unknown>;

export function toolSchema(tool: Tool): Record<string, unknown> {
  return jsonSchema(tool.arguments);
}

/** The MCP `Tool` shape (tools/list). */
export function mcp(tool: Tool): Record<string, unknown> {
  return { name: tool.name, description: tool.description, inputSchema: toolSchema(tool) };
}

/** The same tool as Ollama's chat API expects it. */
export function ollama(tool: Tool): Record<string, unknown> {
  return {
    type: "function",
    function: { name: tool.name, description: tool.description, parameters: toolSchema(tool) },
  };
}

export class Registry {
  readonly tools = new Map<string, Tool>();

  add(tool: Tool): void {
    this.tools.set(tool.name, tool);
  }

  mcpList(): Record<string, unknown>[] {
    return [...this.tools.values()].map(mcp);
  }

  ollamaList(): Record<string, unknown>[] {
    return [...this.tools.values()].map(ollama);
  }

  /** The tool and its validated arguments; ToolError says what is wrong, for the model to fix. */
  parse(name: string, argumentsIn: unknown): [Tool, Args] {
    const tool = this.tools.get(name);
    if (tool === undefined) {
      const known = sortedBy([...this.tools.keys()], (k) => k).join(", ");
      throw new ToolError(`Ferramenta desconhecida: '${name}'. Use uma destas: ${known}.`);
    }
    let given = argumentsIn;
    if (given === null || given === undefined) given = {};
    if (typeof given === "string") {
      try {
        given = parseJson(given || "{}", true);
      } catch {
        throw new ToolError(`Argumentos ilegíveis para ${name}: não são JSON.`);
      }
    }
    if (!isPlainObject(given)) throw new ToolError(`Os argumentos de ${name} devem ser um objeto JSON.`);
    const checked = validateArgs(tool.arguments, given);
    if ("problems" in checked) {
      const text = checked.problems
        .slice(0, 5)
        .map((p) => `${p.loc.map(String).join(".") || "argumentos"}: ${problemText(p)}`)
        .join("; ");
      throw new ToolError(`Argumentos inválidos para ${name}: ${text}.`);
    }
    return [tool, checked.value];
  }
}

/** What a tool result looks like to the model: compact JSON, money and dates as text. */
export function resultText(data: unknown): string {
  return dumps(data);
}

function dumps(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return String(value);
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "string") return JSON.stringify(value);
  if (value instanceof Dec) return JSON.stringify(value.toString());
  if (Array.isArray(value)) return `[${value.map(dumps).join(",")}]`;
  if (value instanceof Map) return dumps(Object.fromEntries(value));
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).map(
      ([k, v]) => `${JSON.stringify(k)}:${dumps(v)}`,
    );
    return `{${entries.join(",")}}`;
  }
  throw new TypeError(typeof value);
}

// ── reading what the model typed ────────────────────

const PLAIN_NUMBER = new PyRe(String.raw`\s*-?\d+(\.\d+)?\s*`);

/** A positive amount in cents: "123.45", "123,45", "R$ 1.234,56" or a JSON number (as Dec). */
export function money(value: unknown, what = "valor"): Dec {
  let amount: Dec;
  try {
    amount = typeof value === "string" && PLAIN_NUMBER.fullmatch(value) === null ? parseBrl(value) : toDecimal(value);
  } catch (error) {
    if (error instanceof MoneyError) throw new ToolError(`${what} ilegível: use números como 123.45.`);
    throw error;
  }
  if (!amount.isPositive()) throw new ToolError(`${what} deve ser positivo.`);
  if (!amount.eq(amount.quantize(CENT))) throw new ToolError(`${what} deve ter no máximo duas casas decimais.`);
  return amount;
}

/** Python 3.12's `date.fromisoformat`: YYYY-MM-DD, YYYYMMDD and ISO week dates; null when invalid. */
export function fromIsoFormat(text: string): IsoDate | null {
  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text) ?? /^(\d{4})(\d{2})(\d{2})$/.exec(text);
  if (m !== null) {
    const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
    return y >= 1 && isIsoDate(`${m[1]}-${m[2]}-${m[3]}`) ? makeDate(y, mo, d) : null;
  }
  m = /^(\d{4})-W(\d{2})(?:-(\d))?$/.exec(text) ?? /^(\d{4})W(\d{2})(\d)?$/.exec(text);
  if (m === null) return null;
  const year = Number(m[1]);
  const week = Number(m[2]);
  const day = m[3] === undefined ? 1 : Number(m[3]);
  if (year < 1 || week < 1 || week > 53 || day < 1 || day > 7) return null;
  const jan4 = makeDate(year, 1, 4);
  const monday1 = addDays(jan4, -weekday(jan4));
  const found = addDays(monday1, (week - 1) * 7 + (day - 1));
  if (week === 53) {
    // week 53 exists only in years whose Dec 28 falls in it
    const dec28 = makeDate(year, 12, 28);
    const last = Math.floor((toOrdinal(dec28) - toOrdinal(monday1)) / 7) + 1;
    if (last < 53) return null;
  }
  return fromOrdinal(toOrdinal(found));
}

export function day(input: string | null, what = "data"): IsoDate | null {
  if (input === null || !pyStrip(input)) return null;
  const found = fromIsoFormat(pyStrip(input));
  if (found === null) throw new ToolError(`${what} inválida: use AAAA-MM-DD.`);
  return found;
}

const MONTH_TEXT = new PyRe(String.raw`\s*(\d{4})-(\d{1,2})\s*`);

/** AAAA-MM; a year outside 1900..2999 is not a ToolError (YearMonth refuses it, as on the desktop). */
export function month(input: string | null, what = "mês"): YearMonth | null {
  if (input === null || !pyStrip(input)) return null;
  const found = MONTH_TEXT.fullmatch(input);
  if (found === null || !(Number(found[2]) >= 1 && Number(found[2]) <= 12))
    throw new ToolError(`${what} inválido: use AAAA-MM.`);
  return ym(Number(found[1]), Number(found[2]));
}

export function accountLabel(ledger: Ledger, account: LedgerAccount): string {
  const parent = account.parent_id ? ledger.accounts.get(account.parent_id) : undefined;
  return parent ? `${parent.name} › ${account.name}` : account.name;
}

/** Python's `NFKD`, ASCII-only, casefolded, single-spaced text (non-ASCII letters are dropped). */
function fold(text: string): string {
  // eslint-disable-next-line no-control-regex
  const plain = text.normalize("NFKD").replace(/[^\x00-\x7f]/g, "");
  return collapseSpaces(casefold(plain).replaceAll(">", "›"));
}

/**
 * By name, ignoring case and accents; a category also by "Pai › Filho".
 * `categories`: true only categories, false only balance accounts, null either.
 */
export function findAccount(ledger: Ledger, name: string, categories: boolean | null = null): LedgerAccount {
  const wanted = fold(name);
  const pool = [...ledger.accounts.values()].filter(
    (a) =>
      !a.archived &&
      (categories === null || (a.subtype === AccountSubtype.CATEGORY) === categories) &&
      a.type !== AccountType.EQUITY,
  );
  let exact = pool.filter((a) => fold(accountLabel(ledger, a)) === wanted);
  if (!exact.length) exact = pool.filter((a) => fold(a.name) === wanted);
  if (exact.length === 1) return exact[0]!;
  const what = categories ? "categoria" : categories === false ? "conta" : "conta ou categoria";
  if (exact.length > 1) {
    const options = sortedBy(
      exact.map((a) => accountLabel(ledger, a)),
      (s) => s,
    ).join(", ");
    throw new ToolError(`Há mais de uma ${what} chamada '${name}': ${options}. Use o nome completo.`);
  }
  const hint = categories ? "list_categories" : "list_accounts";
  throw new ToolError(`Não existe ${what} chamada '${name}'. Consulte ${hint}.`);
}

export function findCategory(ledger: Ledger, name: string, kind: AccountType | null = null): LedgerAccount {
  const found = findAccount(ledger, name, true);
  if (kind !== null && found.type !== kind) {
    const expected = kind === AccountType.EXPENSE ? "despesa" : "receita";
    throw new ToolError(`'${name}' não é uma categoria de ${expected}.`);
  }
  return found;
}

export function findMember(ledger: Ledger, name: string): Id {
  const wanted = fold(name);
  for (const member of ledger.members.values()) if (member.active && fold(member.name) === wanted) return member.id;
  throw new ToolError(`Não existe integrante chamado '${name}'. Consulte list_members.`);
}

/** A UUID's 32 hex digits (Python's `UUID.hex`). */
export function hex(id: Id): string {
  return id.replaceAll("-", "");
}

export function shortId(opId: Id): string {
  return hex(opId).slice(0, SHORT_ID);
}

export function findOperation(ledger: Ledger, ref: string): Operation {
  const text = pyStrip(ref).toLowerCase().replaceAll("-", "");
  if (pyLen(text) < SHORT_ID || !/^[0-9a-f]+$/.test(text))
    throw new ToolError(`id de lançamento inválido: '${ref}'. Use o 'id' devolvido por search_operations.`);
  const found = [...ledger.operations.values()].filter((op) => hex(op.id).startsWith(text));
  if (found.length !== 1)
    throw new ToolError(`Não existe lançamento com id '${ref}'. Use o 'id' devolvido por search_operations.`);
  return found[0]!;
}

/** Domain checks become ToolErrors: the model reads the reason and may correct itself. */
export function guarded<T>(action: () => T): T {
  try {
    return action();
  } catch (error) {
    if (error instanceof DomainError) throw new ToolError(error.message);
    throw error;
  }
}
