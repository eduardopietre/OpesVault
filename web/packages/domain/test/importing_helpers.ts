/** Shared helpers for the import tests: golden sources in, parse results out, synthetic documents. */
import { DocFormat, StatementHeaderSchema, type StatementHeader } from "../src/importing/model.ts";
import type { ParsedItem, ParseResult } from "../src/importing/parsers/base.ts";
import { type Line, type OfxData, PdfJsExtractor, type Source } from "../src/importing/source.ts";
import { golden, j } from "./golden.ts";
import { PARSERS } from "../src/importing/parsers/index.ts";

export interface LineJson {
  page: number;
  text: string;
  bbox: [number, number, number, number] | null;
  number: number | null;
}

export interface SourceJson {
  name: string;
  format: DocFormat;
  pages: number;
  producer: string | null;
  lines: LineJson[];
  rows: [number, string[]][];
  ofx: (Omit<OfxData, "transactions"> & { transactions: { line: number; fields: [string, string][] }[] }) | null;
}

export type Outcome = { ok: unknown } | { error: string; message?: string };

export interface DocumentCase {
  name: string;
  bytes: string;
  problem?: string;
  source?: SourceJson;
  detect?: Record<string, number>;
  choice?: { parser: string | null; candidates: string[] };
  results?: Record<string, Outcome>;
}

export interface ParsersGolden {
  parsers: Record<string, unknown>[];
  documents: DocumentCase[];
  text_fuzz: { doc: string; lines: string[]; detect: Record<string, number>; results: Record<string, Outcome> }[];
  bytes_fuzz: DocumentCase[];
  encrypted: {
    algorithm: string;
    user: string;
    bytes: string;
    cases: Record<string, { lines?: string[]; problem?: string }>;
  }[];
}

let cached: ParsersGolden | null = null;
export function parsersGolden(): ParsersGolden {
  cached ??= golden<ParsersGolden>("parsers");
  return cached;
}

export function bytesOf(b64: string): Uint8Array {
  return new Uint8Array(Buffer.from(b64, "base64"));
}

/** The synthetic documents as Python built them (tests/synthetic_docs.py), by golden name. */
export function doc(name: string): Uint8Array {
  const found = parsersGolden().documents.find((d) => d.name === name);
  if (!found) throw new Error(`no golden document ${name}`);
  return bytesOf(found.bytes);
}

export function lineFrom(json: LineJson): Line {
  return { page: json.page, text: json.text, bbox: json.bbox, number: json.number };
}

export function sourceFrom(json: SourceJson): Source {
  return {
    name: json.name,
    format: json.format,
    pages: json.pages,
    producer: json.producer,
    lines: json.lines.map(lineFrom),
    rows: json.rows.map(([n, cells]) => [n, [...cells]]),
    ofx:
      json.ofx === null
        ? null
        : {
            ...json.ofx,
            transactions: json.ofx.transactions.map((t) => ({ line: t.line, fields: new Map(t.fields) })),
          },
  };
}

export function lineJson(line: Line): LineJson {
  return { page: line.page, text: line.text, bbox: line.bbox ? [...line.bbox] : null, number: line.number };
}

export function sourceJson(src: Source): SourceJson {
  return {
    name: src.name,
    format: src.format,
    pages: src.pages,
    producer: src.producer,
    lines: src.lines.map(lineJson),
    rows: src.rows.map(([n, cells]) => [n, [...cells]]),
    ofx:
      src.ofx === null
        ? null
        : {
            ...src.ofx,
            transactions: src.ofx.transactions.map((t) => ({ line: t.line, fields: [...t.fields] })),
          },
  };
}

export function headerJson(header: StatementHeader): unknown {
  const keys = Object.keys(StatementHeaderSchema.shape) as (keyof StatementHeader)[];
  return Object.fromEntries(keys.map((k) => [k, j(header[k])]));
}

export function itemJson(item: ParsedItem): unknown {
  return {
    kind: item.kind,
    occurred_on: item.occurred_on,
    description: item.description,
    amount: j(item.amount),
    lines: item.lines.map(lineJson),
    installment: item.installment ? [...item.installment] : null,
    card_last4: item.card_last4,
    bank_id: item.bank_id,
    foreign_amount: j(item.foreign_amount),
    foreign_currency: item.foreign_currency,
    quantity: j(item.quantity),
    unit_price: j(item.unit_price),
    ticker: item.ticker,
    credit: item.credit,
    warnings: [...item.warnings],
  };
}

export function resultJson(result: ParseResult): unknown {
  return {
    header: headerJson(result.header),
    items: result.items.map(itemJson),
    warnings: [...result.warnings],
    unmapped: result.unmapped.map(lineJson),
  };
}

/** One extractor for every test: pdf.js is loaded once. */
export const extractor = new PdfJsExtractor();

/**
 * The layouts the golden files know: every parser but the ones written for the web after the desktop was retired
 * (the generic CSV statement), which have their own tests.
 */
export const WEB_ONLY_PARSERS: ReadonlySet<string> = new Set(["csv-extrato-generico"]);
export const GOLDEN_PARSERS = PARSERS.filter((p) => !WEB_ONLY_PARSERS.has(p.id));

/**
 * The layout chosen now against the golden choice: the same, except that a file no golden layout recognized
 * may now be read by a web-only one.
 */
export function sameChoice(ours: { parser: string | null; candidates: string[] }, theirs: unknown): boolean {
  const golden = theirs as { parser: string | null; candidates: string[] };
  if (ours.parser !== null && WEB_ONLY_PARSERS.has(ours.parser))
    return golden.parser === null && !golden.candidates.length;
  return JSON.stringify(ours) === JSON.stringify(golden);
}
