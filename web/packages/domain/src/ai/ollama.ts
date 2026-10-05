/**
 * Optional local AI suggestions through Ollama (docs/05 §5, docs/02 §7, docs/18 §3.6).
 * Port of `ai/ollama.py`.
 *
 * - Only the loopback interface is ever contacted (the port may change, the host never); remote
 *   hosts and cloud models are refused.
 * - Only descriptions and category names are sent: no amounts, people, accounts or passwords.
 * - Text from documents is data, never instructions; every answer is validated against what was
 *   asked (known indexes, allowed categories, names made of the description's own words) and is a
 *   suggestion the user must approve.
 * - No streaming, no prompt logging. The suggestion tasks send no tools. The assistant
 *   (`chatTools`) offers the app's own tools: the model only asks for them; the app runs reads
 *   itself and every change only after the user approves it.
 * - Thinking is turned off: classifying a short description gains little from it.
 * - A bad answer costs one batch, not the whole run: it is asked once more, then skipped, and what
 *   the other batches suggested is kept.
 * - Ollama keeps the last prompt cached while a model is loaded, so the app unloads the models it
 *   used when the project is closed (`unload`).
 *
 * The domain never touches the network: the client receives a `Transport` (a `fetch`-like
 * function) from the app. In the browser it is `fetch` to `http://127.0.0.1:<port>`, which needs
 * `OLLAMA_ORIGINS` set to the app's origin.
 */
import { Dec } from "../lib/dec.ts";
import { cmpStr } from "../lib/text.ts";
import * as prompts from "./prompts.ts";

export const DEFAULT_PORT = 11434;
export const DEFAULT_URL = `http://127.0.0.1:${DEFAULT_PORT}`;
export const PROMPT_VERSION = prompts.CATEGORY_VERSION;
export const TIMEOUT_S = 180; // the first call also loads the model into memory
export const INFO_TIMEOUT_S = 5;
export const UNLOAD_TIMEOUT_S = 2;
export const BATCH_SIZE = 40; // descriptions per request: keeps the prompt small and the answer short
export const MAX_EXAMPLES = 24; // past classifications sent with each batch
export const MAX_NAME = 60; // the longest merchant name the ledger keeps
export const CONTEXT_TOKENS = 8192;
export const ASSISTANT_CONTEXT_TOKENS = 16384; // a conversation carries tool results, longer than a batch
export const KEEP_ALIVE = "10m"; // unloaded from RAM/VRAM after a while; nothing is promised about clearing it
const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);
const NONE = new Set(["NENHUMA", "NENHUM"]);

// Measured with scripts/avaliar_modelos.py on 02/10/2026 (RTX 4070 Ti 12 GB). docs/09 §4.
export const RECOMMENDED_MODELS = ["gemma4:12b"] as const;

/** The model could not help. `fatal`: the server is off or the model missing, so retrying is pointless. */
export class AiUnavailable extends Error {
  readonly fatal: boolean;

  constructor(message: string, options: { fatal?: boolean } = {}) {
    super(message);
    this.name = "AiUnavailable";
    this.fatal = options.fatal ?? false;
  }
}

/** The Ollama address on this computer; only the port can change (OLLAMA_HOST=127.0.0.1:<port>). */
export function localUrl(port: number = DEFAULT_PORT): string {
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new AiUnavailable("Porta do Ollama inválida.", { fatal: true });
  return `http://127.0.0.1:${port}`;
}

// ── transport ───────────────────────────────────────

/** What the client needs from `fetch`. The app passes `fetch` (or a fake in tests). */
export interface TransportInit {
  readonly method: "GET" | "POST";
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string;
  readonly signal: AbortSignal;
}
export interface TransportResponse {
  readonly status: number;
  text(): Promise<string>;
}
export type Transport = (url: string, init: TransportInit) => Promise<TransportResponse>;

// ── JSON as Python's json module reads it ───────────

/** A JSON value; with `exact`, numbers with a fraction or exponent are `Dec` and big integers `bigint`. */
export type JsonValue = null | boolean | number | bigint | string | Dec | JsonValue[] | { [key: string]: JsonValue };

class RawNumber {
  readonly text: string;
  readonly isInt: boolean;
  constructor(text: string, isInt: boolean) {
    this.text = text;
    this.isInt = isInt;
  }
}
type Raw = null | boolean | number | string | RawNumber | Raw[] | { [key: string]: Raw };

export class JsonError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JSONDecodeError";
  }
}

const NUMBER = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][-+]?\d+)?/y;

/** Python's `json.loads`: also NaN, Infinity and -Infinity; duplicate keys keep the last; no control characters in strings. */
function parseRaw(text: string): Raw {
  let i = 0;
  const ws = () => {
    while (i < text.length && " \t\n\r".includes(text[i]!)) i++;
  };
  const fail = (): never => {
    throw new JsonError("invalid JSON");
  };
  const value = (): Raw => {
    ws();
    const c = text[i];
    if (c === "{") {
      i++;
      const obj: { [key: string]: Raw } = {};
      ws();
      if (text[i] === "}") {
        i++;
        return obj;
      }
      for (;;) {
        ws();
        if (text[i] !== '"') fail();
        const key = string();
        ws();
        if (text[i] !== ":") fail();
        i++;
        Object.defineProperty(obj, key, { value: value(), enumerable: true, writable: true, configurable: true });
        ws();
        if (text[i] === ",") {
          i++;
          continue;
        }
        if (text[i] === "}") {
          i++;
          return obj;
        }
        fail();
      }
    }
    if (c === "[") {
      i++;
      const arr: Raw[] = [];
      ws();
      if (text[i] === "]") {
        i++;
        return arr;
      }
      for (;;) {
        arr.push(value());
        ws();
        if (text[i] === ",") {
          i++;
          continue;
        }
        if (text[i] === "]") {
          i++;
          return arr;
        }
        fail();
      }
    }
    if (c === '"') return string();
    for (const [word, v] of [
      ["true", true],
      ["false", false],
      ["null", null],
      ["NaN", new RawNumber("NaN", false)],
      ["Infinity", new RawNumber("Infinity", false)],
      ["-Infinity", new RawNumber("-Infinity", false)],
    ] as const) {
      if (text.startsWith(word, i)) {
        i += word.length;
        return v;
      }
    }
    NUMBER.lastIndex = i;
    const m = NUMBER.exec(text);
    if (!m) return fail();
    i += m[0].length;
    return new RawNumber(m[0], !/[.eE]/.test(m[0]));
  };
  const string = (): string => {
    i++; // opening quote
    let out = "";
    for (;;) {
      const c = text[i];
      if (c === undefined) fail();
      if (c === '"') {
        i++;
        return out;
      }
      if (c! < " ") fail();
      if (c === "\\") {
        const e = text[i + 1];
        const simple: Record<string, string> = {
          '"': '"',
          "\\": "\\",
          "/": "/",
          b: "\b",
          f: "\f",
          n: "\n",
          r: "\r",
          t: "\t",
        };
        if (e !== undefined && e in simple) {
          out += simple[e];
          i += 2;
          continue;
        }
        if (e === "u" && /^[0-9a-fA-F]{4}$/.test(text.slice(i + 2, i + 6))) {
          out += String.fromCharCode(Number.parseInt(text.slice(i + 2, i + 6), 16));
          i += 6;
          continue;
        }
        fail();
      }
      out += c;
      i++;
    }
  };
  const result = value();
  ws();
  if (i !== text.length) fail(); // "Extra data"
  return result;
}

function finish(raw: Raw, exact: boolean): JsonValue {
  if (raw instanceof RawNumber) {
    if (!/^-?\d/.test(raw.text)) return Number(raw.text); // NaN, ±Infinity: floats in Python too
    if (!exact) return Number(raw.text);
    if (raw.isInt) {
      const n = Number(raw.text);
      return Number.isSafeInteger(n) ? n : BigInt(raw.text);
    }
    return Dec.parse(raw.text);
  }
  if (Array.isArray(raw)) return raw.map((v) => finish(v, exact));
  if (raw !== null && typeof raw === "object") {
    const out: { [key: string]: JsonValue } = {};
    for (const [k, v] of Object.entries(raw))
      Object.defineProperty(out, k, { value: finish(v, exact), enumerable: true, writable: true, configurable: true });
    return out;
  }
  return raw;
}

/** `json.loads(text)`, or `json.loads(text, parse_float=Decimal)` with `exact`. */
export function parseJson(text: string, exact = false): JsonValue {
  return finish(parseRaw(text), exact);
}

/**
 * `json.dumps`. A Decimal is not JSON serializable on the desktop (TypeError), and neither is a
 * Dec here; a big integer is a plain JSON number, as Python's int.
 */
export function dumpJson(value: unknown): string {
  const raw = (JSON as unknown as { rawJSON?: (text: string) => unknown }).rawJSON;
  // The replacer sees a Dec only after its toJSON ran: look for one first.
  const visit = (v: unknown): void => {
    if (v instanceof Dec) throw new TypeError("Object of type Decimal is not JSON serializable");
    if (v !== null && typeof v === "object") for (const child of Object.values(v)) visit(child);
  };
  visit(value);
  return JSON.stringify(value, (_key, v: unknown) => {
    if (typeof v === "bigint") {
      if (raw === undefined) throw new TypeError("big integers need JSON.rawJSON");
      return raw(v.toString());
    }
    return v;
  });
}

// ── validating answers by shape (pydantic, lax mode) ─

export class ValidationError extends Error {
  constructor() {
    super("answer does not match the expected format");
    this.name = "ValidationError";
  }
}

const INT_TEXT = /^[+-]?\d+(?:_\d+)*(?:\.0+)?$/;
const STRIP_WS = /^[\s\u0085]+|[\s\u0085]+$/g;

/** Pydantic's lax `int` from JSON: integers, integral floats, booleans and integer text. */
function laxInt(raw: Raw): number {
  if (typeof raw === "boolean") return raw ? 1 : 0;
  if (raw instanceof RawNumber) {
    if (raw.isInt) return Number(raw.text);
    const n = Number(raw.text);
    if (Number.isInteger(n) && Math.abs(n) < 2 ** 63) return n;
    throw new ValidationError();
  }
  if (typeof raw === "string") {
    const text = raw.replace(STRIP_WS, "");
    if (INT_TEXT.test(text)) return Number(text.replaceAll("_", "").replace(/\..*$/, ""));
  }
  throw new ValidationError();
}

function strictObject(raw: Raw, keys: readonly string[]): { [key: string]: Raw } {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw) || raw instanceof RawNumber)
    throw new ValidationError();
  const own = Object.keys(raw);
  if (own.some((k) => !keys.includes(k)) || keys.some((k) => !own.includes(k))) throw new ValidationError();
  return raw;
}

/** `{"<key>": [{"index": int, "<field>": str}, …]}`, as `_Answer` and `_Names` validate it. */
function validateList(text: string, key: string, field: string): { index: number; value: string }[] {
  let raw: Raw;
  try {
    raw = parseRaw(text);
  } catch {
    throw new ValidationError();
  }
  const list = strictObject(raw, [key])[key];
  if (!Array.isArray(list)) throw new ValidationError();
  return list.map((entry) => {
    const obj = strictObject(entry, ["index", field]);
    const value = obj[field];
    if (typeof value !== "string") throw new ValidationError();
    return { index: laxInt(obj["index"]!), value };
  });
}

// ── results ─────────────────────────────────────────

export interface Suggestion {
  readonly index: number;
  readonly category: string;
  readonly source: string; // "ollama:<model>:<prompt version>[@<digest>]"
}

export interface NameSuggestion {
  readonly index: number;
  readonly name: string;
  readonly source: string;
}

export class ServerInfo {
  readonly version: string;
  readonly models: readonly string[]; // installed local models (cloud ones are left out)
  readonly seconds: number;
  readonly digests: ReadonlyMap<string, string>; // model -> content digest (its exact version)

  constructor(
    version: string,
    models: readonly string[],
    seconds: number,
    digests: ReadonlyMap<string, string> = new Map(),
  ) {
    this.version = version;
    this.models = models;
    this.seconds = seconds;
    this.digests = digests;
  }

  /** The installed name for `model` ("gemma4" is "gemma4:latest"), or null. */
  installed(model: string): string | null {
    for (const name of [model, `${model}:latest`]) if (this.models.includes(name)) return name;
    return null;
  }
}

/** Python's `round()` of a float: ties to even. */
function pyRound(x: number): number {
  const f = Math.floor(x);
  const d = x - f;
  if (d > 0.5) return f + 1;
  if (d < 0.5) return f;
  return f % 2 === 0 ? f : f + 1;
}

/** Where a loaded model sits: all in the GPU is fast; any part in the CPU is many times slower. */
export class Placement {
  readonly size: number; // bytes in memory
  readonly vram: number; // of those, bytes in the GPU

  constructor(size: number, vram: number) {
    this.size = size;
    this.vram = vram;
  }

  get gpuPercent(): number {
    return this.size ? pyRound((100 * this.vram) / this.size) : 0;
  }
}

/** What one batched call got back, and how much it could not get. */
export interface Run<T> {
  suggestions: T[];
  failed: number[]; // indexes left unanswered (bad answer, interruption)
  cancelled: boolean;
}
export type CategoryRun = Run<Suggestion>;
export type NameRun = Run<NameSuggestion>;

function run<T>(suggestions: T[] = []): Run<T> {
  return { suggestions, failed: [], cancelled: false };
}

export function schema(key: string, fieldName: string): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      [key]: {
        type: "array",
        items: {
          type: "object",
          properties: { index: { type: "integer" }, [fieldName]: { type: "string" } },
          required: ["index", fieldName],
        },
      },
    },
    required: [key],
  };
}

function isCloud(name: string): boolean {
  return name.endsWith("-cloud") || name.includes(":cloud");
}

// Python whitespace includes the separators U+001C-001F.
const PY_WS = new RegExp(
  // eslint-disable-next-line no-control-regex
  "[\\t\\n\\v\\f\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000]+",
  "u",
);

/** `str.split()` */
function words(text: string): string[] {
  return text.split(PY_WS).filter(Boolean);
}

/** `text[:n]` in code points. */
function head(text: string, n: number): string {
  return text.length <= n ? text : [...text].slice(0, n).join("");
}

/** One line per description, so a document's text cannot fake another line of the listing. */
export function clean(description: string, limit: number): string {
  return head(words(description).join(" "), limit);
}

function letters(text: string): string {
  // NFKD, then drop everything outside ASCII (Python's encode("ascii", "ignore")).
  const plain = [...text.normalize("NFKD")].filter((c) => c.codePointAt(0)! < 128).join("");
  return plain.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/**
 * The name tidied, when it is made of the description's own words; otherwise null.
 *
 * A model may "recognize" a brand that is not there: at least one word of three or more letters of
 * the name must appear in the description (ignoring case, accents and spaces, so "PAG*JOSEDASILVA"
 * → "José da Silva" passes and "PADARIA" → "Carrefour" does not).
 */
export function plausibleName(description: string, name: string): string | null {
  const tidy = words(name).join(" ");
  if (!tidy || NONE.has(tidy.toUpperCase()) || [...tidy].length > MAX_NAME) return null;
  const source = letters(description);
  if (!words(tidy).some((w) => letters(w).length >= 3 && source.includes(letters(w)))) return null;
  return tidy;
}

/** `urlparse(url)`: the scheme and the lowercase host, as Python reads them (no normalization). */
function urlParts(url: string): { scheme: string; host: string | null } {
  const m = /^([A-Za-z][A-Za-z0-9+.-]*):(.*)$/s.exec(url);
  if (!m) return { scheme: "", host: null };
  const scheme = m[1]!.toLowerCase();
  const rest = m[2]!;
  if (!rest.startsWith("//")) return { scheme, host: null };
  const netloc = rest.slice(2).split(/[/?#]/)[0]!;
  const hostport = netloc.slice(netloc.lastIndexOf("@") + 1);
  let host: string;
  if (hostport.startsWith("[")) {
    const end = hostport.indexOf("]");
    host = end < 0 ? hostport.slice(1) : hostport.slice(1, end);
  } else host = hostport.split(":")[0]!;
  return { scheme, host: host ? host.toLowerCase() : null };
}

class HttpError extends Error {
  readonly code: number;
  readonly detail: string;

  constructor(code: number, detail: string) {
    super(String(code));
    this.code = code;
    this.detail = detail;
    this.name = "HttpError";
  }
}

export interface ToolCall {
  readonly name: string;
  readonly arguments: JsonValue | undefined; // as the model sent it: usually an object, sometimes a JSON string
}

/** One answer of the model in a conversation: text, tool calls, or (wrongly) neither. */
export interface ModelTurn {
  readonly content: string;
  readonly tool_calls: readonly ToolCall[];
  readonly raw: Readonly<Record<string, JsonValue>>; // the assistant message, sent back as it came in the next request
}

function isObject(v: unknown): v is Record<string, JsonValue> {
  return v !== null && typeof v === "object" && !Array.isArray(v) && !(v instanceof Dec);
}

export function turnOf(body: Record<string, JsonValue>): ModelTurn {
  const message = body["message"];
  if (!isObject(message)) throw new AiUnavailable("Resposta do Ollama sem mensagem.");
  const content = message["content"];
  const calls: ToolCall[] = [];
  const listed = message["tool_calls"];
  // Python iterates whatever is there (`or ()`): a string yields its characters, an object its keys.
  const entries: JsonValue[] = !listed
    ? []
    : Array.isArray(listed)
      ? listed
      : typeof listed === "string"
        ? [...listed]
        : isObject(listed)
          ? Object.keys(listed)
          : [];
  for (const entry of entries) {
    const fn = isObject(entry) ? entry["function"] : undefined;
    if (isObject(fn)) calls.push({ name: pyStr(fn["name"]) || "", arguments: fn["arguments"] });
    else calls.push({ name: "", arguments: entry }); // malformed: the conversation answers with an error
  }
  const raw: Record<string, JsonValue> = {};
  for (const [k, v] of Object.entries(message)) if (k === "role" || k === "content" || k === "tool_calls") raw[k] = v;
  return { content: typeof content === "string" ? content : "", tool_calls: calls, raw };
}

/** `str(value or "")` for the values a tool call's name may carry. */
function pyStr(value: JsonValue | undefined): string {
  if (value === undefined || value === null || value === false || value === "" || value === 0) return "";
  if (value === true) return "True";
  if (typeof value === "string") return value;
  if (value instanceof Dec) return value.isZero() ? "" : value.toString();
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}

export interface Clock {
  now(): number; // seconds, monotonic
}
const defaultClock: Clock = { now: () => globalThis.performance.now() / 1000 };

export type Progress = (handled: number) => void;
export type Cancelled = () => boolean;

export class OllamaClient {
  readonly model: string;
  readonly baseUrl: string;
  /** Known after `checkModel`; recorded with each suggestion. */
  digest: string | null = null;
  private thinkSupported = true; // turned off for servers or models that reject the option
  private readonly transport: Transport;
  private readonly clock: Clock;

  constructor(model: string, transport: Transport, baseUrl: string = DEFAULT_URL, clock: Clock = defaultClock) {
    const { scheme, host } = urlParts(baseUrl);
    if (host === null || !LOCAL_HOSTS.has(host) || scheme !== "http")
      throw new AiUnavailable("Somente o Ollama local (127.0.0.1) é permitido.", { fatal: true });
    if (isCloud(model)) throw new AiUnavailable("Modelos em nuvem do Ollama não são permitidos.", { fatal: true });
    this.model = model;
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.transport = transport;
    this.clock = clock;
  }

  /** `exact`: numbers in the answer become Dec, never float (tool arguments carry money). */
  private async request(
    path: string,
    payload: Record<string, unknown> | null = null,
    timeoutS: number = TIMEOUT_S,
    exact = false,
  ): Promise<JsonValue> {
    const body = payload !== null ? dumpJson(payload) : undefined;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutS * 1000);
    let status: number;
    let text: string;
    try {
      const response = await this.transport(this.baseUrl + path, {
        method: payload !== null ? "POST" : "GET",
        headers: { "Content-Type": "application/json" },
        ...(body !== undefined ? { body } : {}),
        signal: controller.signal,
      });
      status = response.status;
      text = await response.text();
    } catch {
      if (controller.signal.aborted)
        throw new AiUnavailable("O Ollama demorou demais para responder.", { fatal: true });
      throw new AiUnavailable("Ollama indisponível.", { fatal: true });
    } finally {
      clearTimeout(timer);
    }
    if (status >= 400) {
      const detail = head(text, 300);
      if (status === 404 && detail.includes("not found")) throw this.missing();
      throw new HttpError(status, detail);
    }
    try {
      return parseJson(text, exact);
    } catch {
      throw new AiUnavailable("Resposta do Ollama ilegível.");
    }
  }

  private async requestObject(
    path: string,
    payload: Record<string, unknown> | null = null,
    timeoutS: number = TIMEOUT_S,
    exact = false,
  ): Promise<Record<string, JsonValue>> {
    const body = await this.request(path, payload, timeoutS, exact);
    if (!isObject(body)) throw new TypeError("AttributeError: the answer is not an object"); // `.get` on a non-dict
    return body;
  }

  private missing(): AiUnavailable {
    return new AiUnavailable(
      `O modelo ${this.model} não está instalado no Ollama. Instale com “ollama pull ${this.model}”.`,
      { fatal: true },
    );
  }

  /** Version and installed local models; also proves the server answers. */
  async serverInfo(): Promise<ServerInfo> {
    const started = this.clock.now();
    // Quick calls: a server that does not answer fast is "off".
    const version = (await this.requestObject("/api/version", null, INFO_TIMEOUT_S))["version"];
    const tags = (await this.requestObject("/api/tags", null, INFO_TIMEOUT_S))["models"];
    const names: string[] = [];
    const digests = new Map<string, string>();
    for (const entry of Array.isArray(tags) ? tags : []) {
      const name = isObject(entry) ? entry["name"] : undefined;
      if (isObject(entry) && typeof name === "string" && !isCloud(name) && !entry["remote_host"]) {
        names.push(name);
        const digest = entry["digest"];
        if (typeof digest === "string") digests.set(name, digest);
      }
    }
    names.sort(cmpStr);
    return new ServerInfo(String(version || "?"), names, this.clock.now() - started, digests);
  }

  /** Fails early, saying what to do, when the server is off or the model is not installed. */
  async checkModel(): Promise<ServerInfo> {
    const info = await this.serverInfo();
    const name = info.installed(this.model);
    if (name === null) throw this.missing();
    this.digest = info.digests.get(name) ?? null;
    return info;
  }

  /** Loads the model into memory ahead of the first batch. Best effort. */
  async warmUp(): Promise<void> {
    try {
      await this.request("/api/generate", { model: this.model, keep_alive: KEEP_ALIVE });
    } catch (error) {
      if (!(error instanceof AiUnavailable || error instanceof HttpError)) throw error;
    }
  }

  /** Asks Ollama to drop the model, and the prompts it still caches, from memory. Best effort. */
  async unload(): Promise<void> {
    try {
      await this.request("/api/generate", { model: this.model, keep_alive: 0 }, UNLOAD_TIMEOUT_S);
    } catch (error) {
      if (!(error instanceof AiUnavailable || error instanceof HttpError)) throw error;
    }
  }

  /** How much of this model, if loaded, is in the GPU (Ollama /api/ps). Null when unknown. */
  async placement(): Promise<Placement | null> {
    let loaded: JsonValue | undefined;
    try {
      loaded = (await this.requestObject("/api/ps", null, INFO_TIMEOUT_S))["models"];
    } catch (error) {
      if (error instanceof AiUnavailable || error instanceof HttpError) return null;
      throw error;
    }
    for (const entry of Array.isArray(loaded) ? loaded : []) {
      if (isObject(entry) && (entry["name"] === this.model || entry["name"] === `${this.model}:latest`)) {
        const size = entry["size"];
        const vram = entry["size_vram"];
        if (
          typeof size === "number" &&
          typeof vram === "number" &&
          Number.isInteger(size) &&
          Number.isInteger(vram) &&
          size > 0
        )
          return new Placement(size, Math.min(vram, size));
      }
    }
    return null;
  }

  /** What a suggestion records about its origin: model, prompt version and model digest. */
  sourceFor(version: string): string {
    const tag = `ollama:${this.model}:${version}`;
    return this.digest ? `${tag}@${this.digest.replace(/^sha256:/, "").slice(0, 12)}` : tag;
  }

  get source(): string {
    return this.sourceFor(prompts.CATEGORY_VERSION);
  }

  private async chat(system: string, user: string, format: Record<string, unknown>): Promise<string> {
    const payload: Record<string, unknown> = {
      model: this.model,
      stream: false,
      format,
      keep_alive: KEEP_ALIVE,
      options: { temperature: 0, num_ctx: CONTEXT_TOKENS },
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    };
    if (this.thinkSupported) payload["think"] = false;
    let body: Record<string, JsonValue>;
    try {
      body = await this.requestObject("/api/chat", payload);
    } catch (error) {
      if (!(error instanceof HttpError)) throw error;
      if (this.thinkSupported && error.detail.toLowerCase().includes("think")) {
        this.thinkSupported = false; // older server or a model without the option
        return this.chat(system, user, format);
      }
      throw new AiUnavailable(`Ollama recusou o pedido (${error.code}).`);
    }
    const message = body["message"];
    const content = isObject(message) ? message["content"] : undefined;
    if (typeof content !== "string") throw new AiUnavailable("Resposta do Ollama sem conteúdo.");
    return content;
  }

  /** One batch; a malformed answer is asked once more before giving up on it. */
  private async ask<T>(
    system: string,
    user: string,
    format: Record<string, unknown>,
    validate: (text: string) => T,
  ): Promise<T> {
    try {
      return validate(await this.chat(system, user, format));
    } catch (error) {
      if (error instanceof AiUnavailable) {
        if (error.fatal) throw error;
      } else if (!(error instanceof ValidationError)) throw error;
    }
    try {
      return validate(await this.chat(system, user, format));
    } catch (error) {
      if (error instanceof ValidationError) throw new AiUnavailable("Resposta do Ollama fora do formato esperado.");
      throw error;
    }
  }

  /** Runs `askBatch(offset, size)` over `count` entries; it returns what it found by global index. */
  private async batched<T>(
    count: number,
    askBatch: (offset: number, size: number) => Promise<Map<number, T>>,
    onProgress: Progress | null,
    cancelled: Cancelled | null,
  ): Promise<Run<T>> {
    const result = run<T>();
    const out = new Map<number, T>();
    let answered = 0;
    let error: AiUnavailable | null = null;
    for (let offset = 0; offset < count; offset += BATCH_SIZE) {
      const size = Math.min(BATCH_SIZE, count - offset);
      if (cancelled !== null && cancelled()) {
        result.cancelled = true;
        for (let i = offset; i < count; i++) result.failed.push(i);
        break;
      }
      try {
        const found = await askBatch(offset, size);
        answered += 1;
        for (const [index, value] of found) if (!out.has(index)) out.set(index, value);
      } catch (exc) {
        if (!(exc instanceof AiUnavailable)) throw exc;
        error = exc;
        if (exc.fatal) {
          // the next batches would fail the same way
          for (let i = offset; i < count; i++) result.failed.push(i);
          break;
        }
        for (let i = offset; i < offset + size; i++) result.failed.push(i);
      }
      onProgress?.(offset + size);
    }
    if (!answered && error !== null) throw error;
    result.suggestions = [...out.keys()].sort((a, b) => a - b).map((i) => out.get(i)!);
    return result;
  }

  /** Whether the model declares tool calling (Ollama /api/show); null when the server does not say. */
  async supportsTools(): Promise<boolean | null> {
    let shown: Record<string, JsonValue>;
    try {
      shown = await this.requestObject("/api/show", { model: this.model }, INFO_TIMEOUT_S);
    } catch (error) {
      if (error instanceof HttpError) return null;
      throw error;
    }
    const capabilities = shown["capabilities"];
    return Array.isArray(capabilities) ? capabilities.includes("tools") : null;
  }

  /**
   * One step of a conversation with tools. The model only asks; the caller decides what runs.
   * Numbers in tool arguments arrive as Dec (`exact`), so money never passes through float.
   */
  async chatTools(
    system: string,
    messages: readonly Record<string, unknown>[],
    tools: readonly Record<string, unknown>[],
  ): Promise<ModelTurn> {
    const payload: Record<string, unknown> = {
      model: this.model,
      stream: false,
      keep_alive: KEEP_ALIVE,
      options: { temperature: 0, num_ctx: ASSISTANT_CONTEXT_TOKENS },
      messages: [{ role: "system", content: system }, ...messages],
      tools: [...tools],
    };
    if (this.thinkSupported) payload["think"] = false;
    let body: Record<string, JsonValue>;
    try {
      body = await this.requestObject("/api/chat", payload, TIMEOUT_S, true);
    } catch (error) {
      if (!(error instanceof HttpError)) throw error;
      if (this.thinkSupported && error.detail.toLowerCase().includes("think")) {
        this.thinkSupported = false;
        return this.chatTools(system, messages, tools);
      }
      if (error.detail.toLowerCase().includes("tools")) {
        throw new AiUnavailable(
          `O modelo ${this.model} não aceita ferramentas. Escolha outro em Configurações › IA local.`,
          { fatal: true },
        );
      }
      throw new AiUnavailable(`Ollama recusou o pedido (${error.code}).`);
    }
    return turnOf(body);
  }

  /**
   * Suggests a category per description, in batches.
   *
   * `examples` are (description, category) pairs the family already chose: they show how this
   * family classifies. `onProgress` receives how many descriptions were handled so far;
   * `cancelled` is checked between batches. Throws AiUnavailable only when no batch worked.
   */
  async suggestCategories(
    descriptions: readonly string[],
    categories: readonly string[],
    examples: readonly (readonly [string, string])[] = [],
    onProgress: Progress | null = null,
    cancelled: Cancelled | null = null,
  ): Promise<CategoryRun> {
    if (!descriptions.length || !categories.length) return run();
    const allowed = new Set(categories);
    const source = this.sourceFor(prompts.CATEGORY_VERSION);
    const guide = examples
      .filter(([, c]) => allowed.has(c))
      .map(([d, c]) => `- ${clean(d, 120)} → ${c}`)
      .slice(0, MAX_EXAMPLES);
    const format = schema("suggestions", "category");
    const askBatch = async (offset: number, size: number) => {
      const chunk = descriptions.slice(offset, offset + size);
      const listing = chunk.map((d, i) => `${i}: ${clean(d, 200)}`).join("\n");
      const user = prompts.categoryRequest(categories, guide, listing);
      const answer = await this.ask(prompts.CATEGORY_SYSTEM, user, format, (t) =>
        validateList(t, "suggestions", "category"),
      );
      // Valid JSON proves nothing: unknown indexes or categories are dropped.
      const found = new Map<number, Suggestion>();
      for (const c of [...answer].reverse()) {
        // the first answer for an index wins
        if (0 <= c.index && c.index < size && allowed.has(c.value))
          found.set(offset + c.index, { index: offset + c.index, category: c.value, source });
      }
      return found;
    };
    return this.batched(descriptions.length, askBatch, onProgress, cancelled);
  }

  /**
   * Suggests a readable merchant name per description ("IFD*IFOOD.COM AGENCIA" → "iFood").
   * Names not made of the description's own words are dropped (`plausibleName`).
   */
  async suggestNames(
    descriptions: readonly string[],
    onProgress: Progress | null = null,
    cancelled: Cancelled | null = null,
  ): Promise<NameRun> {
    if (!descriptions.length) return run();
    const source = this.sourceFor(prompts.MERCHANT_VERSION);
    const format = schema("names", "name");
    const askBatch = async (offset: number, size: number) => {
      const chunk = descriptions.slice(offset, offset + size);
      const listing = chunk.map((d, i) => `${i}: ${clean(d, 200)}`).join("\n");
      const answer = await this.ask(prompts.MERCHANT_SYSTEM, prompts.merchantRequest(listing), format, (t) =>
        validateList(t, "names", "name"),
      );
      const found = new Map<number, NameSuggestion>();
      for (const entry of [...answer].reverse()) {
        if (!(0 <= entry.index && entry.index < size)) continue;
        const name = plausibleName(chunk[entry.index]!, entry.value);
        if (name !== null) found.set(offset + entry.index, { index: offset + entry.index, name, source });
      }
      return found;
    };
    return this.batched(descriptions.length, askBatch, onProgress, cancelled);
  }
}
