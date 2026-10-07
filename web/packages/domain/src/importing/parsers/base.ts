/**
 * Parser contract: one parser per institution + product + document type + layout version
 * (docs/05 §1). Port of `importing/parsers/base.py`.
 *
 * Parsers are untrusted code over untrusted input: they run through `pipeline.runParser`, which
 * turns any failure into `ParseFailed`. A value that cannot be read or an impossible date is an
 * unmapped line or an unknown (`null`) field, never an exception.
 *
 * This file also holds `PyRe`, the bridge that gives the parsers' regular expressions Python's
 * `re` semantics where JavaScript differs (see its doc comment).
 */
import { type IsoDate, makeDate } from "../../lib/dates.ts";
import type { Dec } from "../../lib/dec.ts";
import { PY_WS, pyStrip } from "../../lib/py.ts";
import { casefold } from "../../lib/text.ts";
import { MoneyError, parseBrl } from "../../domain/money.ts";
import type { DocFormat, DocType, ItemKind, StatementHeader } from "../model.ts";
import type { Line, Source } from "../source.ts";

export const MONTHS_PT: ReadonlyMap<string, number> = new Map([
  ["JAN", 1],
  ["FEV", 2],
  ["MAR", 3],
  ["ABR", 4],
  ["MAI", 5],
  ["JUN", 6],
  ["JUL", 7],
  ["AGO", 8],
  ["SET", 9],
  ["OUT", 10],
  ["NOV", 11],
  ["DEZ", 12],
]);

export const AMOUNT_RE = String.raw`-?−?(?:R\$\s*)?-?\d{1,3}(?:\.\d{3})*,\d{2}-?`;

/** One extracted fact, still a suggestion of the document (Python's mutable `ParsedItem` dataclass). */
export interface ParsedItem {
  kind: ItemKind;
  occurred_on: IsoDate | null;
  description: string;
  amount: Dec | null;
  lines: Line[];
  installment: readonly [number, number] | null;
  card_last4: string | null;
  bank_id: string | null;
  foreign_amount: Dec | null;
  foreign_currency: string | null;
  quantity: Dec | null;
  unit_price: Dec | null;
  ticker: string | null;
  credit: boolean; // fee lines credited to the client
  warnings: string[];
}

export function parsedItem(
  fields: Pick<ParsedItem, "kind" | "occurred_on" | "description" | "amount" | "lines"> & Partial<ParsedItem>,
): ParsedItem {
  return {
    installment: null,
    card_last4: null,
    bank_id: null,
    foreign_amount: null,
    foreign_currency: null,
    quantity: null,
    unit_price: null,
    ticker: null,
    credit: false,
    warnings: [],
    ...fields,
  };
}

export interface ParseResult {
  header: StatementHeader;
  items: ParsedItem[];
  warnings: string[];
  unmapped: Line[];
}

export interface Parser {
  readonly id: string;
  readonly version: string;
  readonly institution: string;
  readonly product: string;
  readonly doc_type: DocType;
  readonly doc_format: DocFormat;
  /** Synthetic layouts are built from public descriptions and must be confirmed with real documents. */
  readonly validated_with_real_documents: boolean;
  readonly limitations: string;
  /** Confidence in [0, 1] that this parser understands the document. */
  detect(source: Source): number;
  parse(source: Source): ParseResult;
}

export function amount(text: string): Dec {
  return parseBrl(text.replaceAll("−", "-"));
}

export function tryAmount(text: string): Dec | null {
  try {
    return amount(text);
  } catch (error) {
    if (error instanceof MoneyError) return null;
    throw error;
  }
}

/** An impossible printed date is unknown, not an exception. */
export function safeDate(year: number, month: number, day: number): IsoDate | null {
  try {
    return makeDate(year, month, day);
  } catch {
    return null;
  }
}

const DMY = new RegExp(String.raw`^(\d{2})/(\d{2})/(\d{2}|\d{4})$`);

/** '31/01/2026' or '31/01/26'. Impossible dates return null (they are errors, docs/05 §4). */
export function dmy(text: string): IsoDate | null {
  const m = DMY.exec(pyStrip(text));
  if (!m) return null;
  const day = Number(m[1]);
  const month = Number(m[2]);
  let year = Number(m[3]);
  if (year < 100) year += 2000;
  return safeDate(year, month, day);
}

/**
 * Dates printed without year: pick the year that puts them on or before the reference date.
 *
 * The reference comes from the document (closing or due date), never the computer clock
 * (docs/05 §4). Purchases dated after the reference belong to the previous year.
 */
export function resolveYear(day: number, month: number, reference: IsoDate): IsoDate | null {
  const year = Number(reference.slice(0, 4));
  for (const y of [year, year - 1]) {
    const candidate = safeDate(y, month, day);
    if (candidate === null) continue;
    if (candidate <= reference) return candidate;
  }
  return null;
}

export function containsAll(text: string, ...needles: string[]): boolean {
  const folded = casefold(text);
  return needles.every((n) => folded.includes(casefold(n)));
}

// Python string semantics live in lib/py; the parsers import them from here.
export { PY_WS, pyHead, pyLen, pySplit, pyStrip } from "../../lib/py.ts";

const WORD = String.raw`[\p{L}\p{N}_]`;

/**
 * A regular expression with Python `re` semantics for the constructs the parsers use:
 *
 * - `\s` / `\S`: Python's whitespace set (JavaScript's differs at U+001C–1F, U+0085 and U+FEFF);
 * - `\b`: a Unicode word boundary (letters, numbers, `_`), as Python's `str` patterns; JavaScript's
 *   `\b` is ASCII-only, so "ÇIOF" would wrongly contain the word "IOF";
 * - `.`: anything but `\n` (JavaScript also stops at `\r`, U+2028, U+2029), or anything with `s`;
 * - `$`: end of text or before a final `\n`; with `m`, before any `\n` (JavaScript's `m` also
 *   stops at `\r`);
 * - `(?P<name>…)` named groups.
 *
 * `\d` stays ASCII: Python's `\d` also matches other scripts' digits (Arabic-Indic…), which
 * `parse_brl` in `money.ts` already treats as text; real statements print ASCII digits.
 */
export class PyRe {
  readonly source: string;
  private readonly searchRe: RegExp;
  private readonly matchRe: RegExp;
  private readonly fullRe: RegExp;
  private readonly globalRe: RegExp;

  constructor(pattern: string, flags = "") {
    const dotAll = flags.includes("s");
    const multiline = flags.includes("m");
    const body = translate(pattern, dotAll, multiline);
    const js = (flags.includes("i") ? "i" : "") + "u";
    this.source = pattern;
    this.searchRe = new RegExp(body, js);
    this.matchRe = new RegExp(`^(?:${body})`, js);
    this.fullRe = new RegExp(`^(?:${body})$`, js);
    this.globalRe = new RegExp(body, js + "g");
  }

  /** `re.search` */
  search(text: string): RegExpExecArray | null {
    return this.searchRe.exec(text);
  }

  /** `re.match`: anchored at the start. */
  match(text: string): RegExpExecArray | null {
    return this.matchRe.exec(text);
  }

  /** `re.fullmatch` */
  fullmatch(text: string): RegExpExecArray | null {
    return this.fullRe.exec(text);
  }

  /** `re.finditer` */
  *finditer(text: string): Generator<RegExpExecArray> {
    const re = new RegExp(this.globalRe.source, this.globalRe.flags);
    for (;;) {
      const m = re.exec(text);
      if (m === null) return;
      if (m[0] === "") re.lastIndex = advance(text, re.lastIndex);
      yield m;
    }
  }

  /** `re.sub(pattern, repl, text)` with a plain replacement text. */
  sub(repl: string, text: string): string {
    return text.replace(this.globalRe, () => repl);
  }
}

function advance(text: string, index: number): number {
  const cp = text.codePointAt(index);
  return index + (cp !== undefined && cp > 0xffff ? 2 : 1);
}

function translate(pattern: string, dotAll: boolean, multiline: boolean): string {
  let out = "";
  let inClass = false;
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!;
    if (c === "\\") {
      const n = pattern[i + 1] ?? "";
      i++;
      if (n === "s") out += inClass ? PY_WS : `[${PY_WS}]`;
      else if (n === "S")
        out += inClass ? "\\S" : `[^${PY_WS}]`; // \S inside a class is not used by the parsers
      else if (n === "b" && !inClass) out += `(?:(?<=${WORD})(?!${WORD})|(?<!${WORD})(?=${WORD}))`;
      else out += c + n;
      continue;
    }
    if (inClass) {
      if (c === "]") inClass = false;
      out += c;
      continue;
    }
    if (c === "[") {
      inClass = true;
      out += c;
      if (pattern[i + 1] === "^") out += pattern[++i];
      if (pattern[i + 1] === "]") out += pattern[++i]; // a literal "]" first in the class
      continue;
    }
    if (c === ".") out += dotAll ? "[\\s\\S]" : "[^\\n]";
    else if (c === "$") out += multiline ? "(?=\\n|$)" : "(?=\\n?$)";
    else if (c === "(" && pattern.startsWith("?P<", i + 1)) {
      out += "(?<";
      i += 3;
    } else out += c;
  }
  return out;
}

/** A capture group as Python returns it: the text, or null when the group did not take part. */
export function group(m: RegExpExecArray, key: number | string): string | null {
  const value = typeof key === "number" ? m[key] : m.groups?.[key];
  return value ?? null;
}

/** `int(text)` for the ASCII digits the parsers capture. */
export function pyInt(text: string): number {
  return Number.parseInt(text, 10);
}
