/**
 * Turn document bytes into parser input: PDF lines with geometry, CSV rows or OFX records.
 * Port of `importing/source.py`.
 *
 * Everything stays in memory (docs/03 §6). PDF passwords are used once and never stored.
 *
 * The desktop extracted PDF text with pdfplumber; here a `PdfTextExtractor` gives the parsers the
 * same structure (one `Line` per text line, with its page and box in PDF points from the top-left
 * corner). `PdfJsExtractor` implements it with pdf.js and runs in Node and in a Web Worker alike:
 * no DOM, no canvas, no network, no font fetching.
 */
import { DocFormat } from "./model.ts";
import { pyHead, pyLen, PyRe, pyStrip, PY_WS } from "./parsers/base.ts";

export const MAX_DOCUMENT_BYTES = 50 * 1024 * 1024;
export const MAX_PAGES = 300;

export const SourceProblem = {
  TOO_LARGE: "too_large",
  UNKNOWN_FORMAT: "unknown_format",
  PASSWORD_REQUIRED: "password_required",
  WRONG_PASSWORD: "wrong_password",
  INVALID: "invalid",
  NO_TEXT: "no_text", // scanned: OCR is a planned expansion (docs/00 §5)
  TOO_MANY_PAGES: "too_many_pages",
} as const;
export type SourceProblem = (typeof SourceProblem)[keyof typeof SourceProblem];

export const PROBLEM_MESSAGES: Readonly<Record<SourceProblem, string>> = {
  [SourceProblem.TOO_LARGE]: "Arquivo grande demais para importar.",
  [SourceProblem.UNKNOWN_FORMAT]: "Formato não reconhecido (aceitos: PDF, CSV, OFX).",
  [SourceProblem.PASSWORD_REQUIRED]: "PDF protegido por senha.",
  [SourceProblem.WRONG_PASSWORD]: "Senha do PDF incorreta.",
  [SourceProblem.INVALID]: "Arquivo corrompido ou inválido.",
  [SourceProblem.NO_TEXT]: "PDF sem texto selecionável (provavelmente escaneado). OCR ainda não é suportado.",
  [SourceProblem.TOO_MANY_PAGES]: "PDF com páginas demais para importar.",
};

export class SourceError extends Error {
  readonly problem: SourceProblem;

  constructor(problem: SourceProblem) {
    super(problem);
    this.name = "SourceError";
    this.problem = problem;
  }
}

export type Bbox = readonly [number, number, number, number]; // x0, top, x1, bottom in PDF points

/** One line of a document. Python's frozen dataclass; identity matters to some parsers. */
export interface Line {
  readonly page: number; // 1-based; 0 for text formats
  readonly text: string;
  readonly bbox: Bbox | null;
  readonly number: number | null; // 1-based line number for text formats
}

export function line(page: number, text: string, bbox: Bbox | null = null, number: number | null = null): Line {
  return { page, text, bbox, number };
}

export interface OfxTransaction {
  line: number;
  fields: Map<string, string>;
}

export interface OfxData {
  kind: string; // "bank" or "card"
  account_id: string | null;
  bank_id: string | null;
  currency: string | null;
  ledger_balance: string | null;
  ledger_balance_date: string | null;
  start: string | null;
  end: string | null;
  transactions: OfxTransaction[];
}

export interface Source {
  name: string;
  format: DocFormat;
  lines: Line[];
  rows: [number, string[]][]; // (line number, cells) for CSV
  ofx: OfxData | null;
  pages: number;
  producer: string | null;
}

export function source(name: string, format: DocFormat, fields: Partial<Source> = {}): Source {
  return { name, format, lines: [], rows: [], ofx: null, pages: 0, producer: null, ...fields };
}

/** Python's `Source.text` property. */
export function textOf(src: Source): string {
  return src.lines.map((l) => l.text).join("\n");
}

// ── format and text decoding ────────────────────────

const LSTRIP_BYTES = new Set([0xef, 0xbb, 0xbf, 0x20, 0x0d, 0x0a, 0x09]);

function startsWith(data: Uint8Array, prefix: string, at = 0): boolean {
  if (data.length - at < prefix.length) return false;
  for (let i = 0; i < prefix.length; i++) if (data[at + i] !== prefix.charCodeAt(i)) return false;
  return true;
}

function includesAscii(data: Uint8Array, needle: string): boolean {
  outer: for (let i = 0; i + needle.length <= data.length; i++) {
    for (let k = 0; k < needle.length; k++) if (data[i + k] !== needle.charCodeAt(k)) continue outer;
    return true;
  }
  return false;
}

export function detectFormat(data: Uint8Array): DocFormat {
  let start = 0;
  const end = Math.min(data.length, 2048);
  while (start < end && LSTRIP_BYTES.has(data[start]!)) start++; // bytes.lstrip strips any of these bytes
  if (startsWith(data.subarray(0, end), "%PDF", start)) return DocFormat.PDF;
  const upper = data.slice(start, end).map((b) => (b >= 0x61 && b <= 0x7a ? b - 32 : b));
  if (includesAscii(upper, "OFXHEADER") || includesAscii(upper, "<OFX>") || includesAscii(upper, "<?OFX")) {
    return DocFormat.OFX;
  }
  if (decodeText(data) === null) throw new SourceError(SourceProblem.UNKNOWN_FORMAT);
  return DocFormat.CSV;
}

// Python's cp1252 codec: 0x81, 0x8D, 0x8F, 0x90 and 0x9D are undefined and fail to decode
// (the WHATWG decoder would map them to control characters instead).
const CP1252_HIGH = [
  0x20ac, -1, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160, 0x2039, 0x0152, -1, 0x017d, -1,
  -1, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, -1, 0x017e,
  0x0178,
];

function decodeCp1252(data: Uint8Array): string | null {
  const parts: string[] = [];
  let chunk = "";
  for (const b of data) {
    let cp = b;
    if (b >= 0x80 && b <= 0x9f) {
      cp = CP1252_HIGH[b - 0x80]!;
      if (cp < 0) return null;
    }
    chunk += String.fromCharCode(cp);
    if (chunk.length >= 8192) {
      parts.push(chunk);
      chunk = "";
    }
  }
  parts.push(chunk);
  return parts.join("");
}

/** utf-8-sig, then cp1252, like the desktop; null when neither decodes. */
export function decodeText(data: Uint8Array): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(data);
  } catch {
    return decodeCp1252(data);
  }
}

// ── loading ─────────────────────────────────────────

/** Text lines of a PDF with their geometry, as the parsers consume them. */
export interface PdfText {
  readonly pages: number;
  readonly producer: string | null;
  readonly lines: readonly Line[];
}

/**
 * Reads the text of a PDF. Implementations raise `SourceError` for a missing or wrong password
 * and for too many pages; any other failure is an invalid file. Lines carry the text as the
 * PDF prints it (whitespace is normalized by `loadSource`) and boxes in points from the top.
 */
export interface PdfTextExtractor {
  extract(data: Uint8Array, password: string | null): Promise<PdfText>;
}

/** Structured formats (CSV, OFX) need no extractor and load synchronously. */
export function loadStructured(name: string, data: Uint8Array): Source {
  if (data.length > MAX_DOCUMENT_BYTES) throw new SourceError(SourceProblem.TOO_LARGE);
  const fmt = detectFormat(data);
  if (fmt === DocFormat.PDF) throw new SourceError(SourceProblem.INVALID);
  if (fmt === DocFormat.OFX) return source(name, fmt, { ofx: parseOfx(decodeText(data)!) });
  return loadCsv(name, data);
}

export async function loadSource(
  name: string,
  data: Uint8Array,
  password: string | null,
  extractor: PdfTextExtractor,
): Promise<Source> {
  if (data.length > MAX_DOCUMENT_BYTES) throw new SourceError(SourceProblem.TOO_LARGE);
  const fmt = detectFormat(data);
  if (fmt === DocFormat.PDF) return loadPdf(name, data, password, extractor);
  return loadStructured(name, data);
}

const SPACES = new PyRe(String.raw`\s+`);

/** The desktop's line cleanup: whitespace runs become one space; empty lines are dropped. */
export function pdfSource(name: string, text: PdfText): Source {
  const src = source(name, DocFormat.PDF, { pages: text.pages, producer: text.producer });
  for (const raw of text.lines) {
    const clean = pyStrip(SPACES.sub(" ", raw.text));
    if (clean) src.lines.push(line(raw.page, clean, raw.bbox));
  }
  return src;
}

async function loadPdf(
  name: string,
  data: Uint8Array,
  password: string | null,
  extractor: PdfTextExtractor,
): Promise<Source> {
  let src: Source;
  try {
    src = pdfSource(name, await extractor.extract(data, password));
  } catch (error) {
    if (error instanceof SourceError) throw error;
    // Malformed structures surface lazily, page by page: still just an invalid file.
    throw new SourceError(SourceProblem.INVALID);
  }
  let chars = 0;
  for (const l of src.lines) chars += pyLen(l.text);
  if (chars < 20) throw new SourceError(SourceProblem.NO_TEXT);
  return src;
}

// ── CSV ─────────────────────────────────────────────

const FIELD_LIMIT = 131072; // csv.field_size_limit()

class CsvError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CsvError";
  }
}

/** Lines as `io.StringIO(text, newline="")` yields them: split after \n, \r or \r\n, endings kept. */
function* physicalLines(text: string): Generator<string> {
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "\n") {
      yield text.slice(start, i + 1);
      start = i + 1;
    } else if (c === "\r") {
      const end = text[i + 1] === "\n" ? i + 2 : i + 1;
      yield text.slice(start, end);
      start = end;
      i = end - 1;
    }
  }
  if (start < text.length) yield text.slice(start);
}

/** Python's `csv.reader` with the excel dialect (CPython's `_csv.c` state machine). */
export function* csvRows(text: string, delimiter: string): Generator<string[]> {
  const START_RECORD = 0;
  const START_FIELD = 1;
  const IN_FIELD = 2;
  const IN_QUOTED_FIELD = 3;
  const QUOTE_IN_QUOTED_FIELD = 4;
  const EAT_CRNL = 5;
  const EOL = null;
  let state = START_RECORD;
  let fields: string[] = [];
  let field: string[] = [];
  let fieldLen = 0;
  const save = () => {
    fields.push(field.join(""));
    field = [];
    fieldLen = 0;
  };
  const add = (c: string) => {
    if (fieldLen >= FIELD_LIMIT) throw new CsvError(`field larger than field limit (${FIELD_LIMIT})`);
    field.push(c);
    fieldLen++;
  };
  const process = (c: string | null) => {
    switch (state) {
      case START_RECORD:
        if (c === EOL) return;
        if (c === "\n" || c === "\r") {
          state = EAT_CRNL;
          return;
        }
        state = START_FIELD; // a normal character: handled as the start of a field
        process(c);
        return;
      case START_FIELD:
        if (c === "\n" || c === "\r" || c === EOL) {
          save();
          state = c === EOL ? START_RECORD : EAT_CRNL;
        } else if (c === '"') state = IN_QUOTED_FIELD;
        else if (c === delimiter) save();
        else {
          add(c);
          state = IN_FIELD;
        }
        return;
      case IN_FIELD:
        if (c === "\n" || c === "\r" || c === EOL) {
          save();
          state = c === EOL ? START_RECORD : EAT_CRNL;
        } else if (c === delimiter) {
          save();
          state = START_FIELD;
        } else add(c);
        return;
      case IN_QUOTED_FIELD:
        if (c === EOL) return;
        if (c === '"') state = QUOTE_IN_QUOTED_FIELD;
        else add(c);
        return;
      case QUOTE_IN_QUOTED_FIELD:
        if (c === '"') {
          add(c);
          state = IN_QUOTED_FIELD;
        } else if (c === delimiter) {
          save();
          state = START_FIELD;
        } else if (c === "\n" || c === "\r" || c === EOL) {
          save();
          state = c === EOL ? START_RECORD : EAT_CRNL;
        } else {
          add(c); // not strict: the quote ends and the field goes on
          state = IN_FIELD;
        }
        return;
      case EAT_CRNL:
        if (c === "\n" || c === "\r") return;
        if (c === EOL) {
          state = START_RECORD;
          return;
        }
        throw new CsvError("new-line character seen in unquoted field");
    }
  };
  const lines = physicalLines(text);
  for (;;) {
    let done = false;
    do {
      const next = lines.next();
      if (next.done) {
        if (fieldLen !== 0 || state === IN_QUOTED_FIELD) {
          save();
          done = true;
          break;
        }
        return;
      }
      for (const c of next.value) process(c);
      process(EOL);
    } while (state !== START_RECORD);
    const row = fields;
    fields = [];
    yield row;
    if (done) return;
  }
}

function countOf(text: string, needle: string): number {
  let n = 0;
  for (let i = text.indexOf(needle); i >= 0; i = text.indexOf(needle, i + needle.length)) n++;
  return n;
}

function loadCsv(name: string, data: Uint8Array): Source {
  const text = decodeText(data)!;
  const sample = pyHead(text, 4096);
  let delimiter = ",";
  for (const d of [";", "\t"]) if (countOf(sample, d) > countOf(sample, delimiter)) delimiter = d; // max() keeps the first
  const src = source(name, DocFormat.CSV);
  try {
    let number = 0;
    for (const row of csvRows(text, delimiter)) {
      number += 1;
      const cells = row.map((c) => pyStrip(c));
      if (cells.some((c) => c !== "")) {
        src.rows.push([number, cells]);
        src.lines.push(line(0, cells.join(delimiter), null, number));
      }
    }
  } catch (error) {
    if (error instanceof CsvError) throw new SourceError(SourceProblem.INVALID);
    throw error;
  }
  if (!src.rows.length) throw new SourceError(SourceProblem.INVALID);
  return src;
}

// ── OFX ─────────────────────────────────────────────

const TAG = new PyRe(String.raw`<([A-Z0-9.]+)>([^<\r\n]*)`, "i");
const BALANCE_BLOCK = new PyRe(String.raw`<LEDGERBAL>(.*?)(</LEDGERBAL>|<AVAILBAL>|</STMTRS>|</CCSTMTRS>)`, "is");
const TRANSACTION = new PyRe(String.raw`<STMTTRN>(.*?)(?=</STMTTRN>|<STMTTRN>|</BANKTRANLIST>)`, "is");
const FIRST = new Map<string, PyRe>();

/** Tolerant reader for OFX 1.x (SGML, unclosed tags) and 2.x (XML). */
export function parseOfx(text: string): OfxData {
  const upper = text.toUpperCase();
  const kind = upper.includes("<CCSTMTRS>") || upper.includes("CREDITCARDMSGSRSV1") ? "card" : "bank";
  const first = (tag: string, scope: string = text): string | null => {
    let re = FIRST.get(tag);
    if (re === undefined) {
      re = new PyRe(`<${tag}>([^<\\r\\n]*)`, "i");
      FIRST.set(tag, re);
    }
    const m = re.search(scope);
    const value = m ? pyStrip(m[1]!) : "";
    return value ? value : null;
  };
  const balanceBlock = BALANCE_BLOCK.search(text);
  const data: OfxData = {
    kind,
    account_id: first("ACCTID"),
    bank_id: first("BANKID"),
    currency: first("CURDEF"),
    ledger_balance: balanceBlock ? first("BALAMT", balanceBlock[1]!) : null,
    ledger_balance_date: balanceBlock ? first("DTASOF", balanceBlock[1]!) : null,
    start: first("DTSTART"),
    end: first("DTEND"),
    transactions: [],
  };
  let counted = 0;
  let newlines = 0;
  for (const m of TRANSACTION.finditer(text)) {
    const block = m[1]!;
    const fields = new Map<string, string>();
    for (const t of TAG.finditer(block)) {
      const value = pyStrip(t[2]!);
      if (value) fields.set(t[1]!.toUpperCase(), value);
    }
    newlines += countOf(text.slice(counted, m.index), "\n");
    counted = m.index;
    data.transactions.push({ line: newlines + 1, fields });
  }
  if (!data.transactions.length && data.ledger_balance === null) throw new SourceError(SourceProblem.INVALID);
  return data;
}

// ── pdf.js ──────────────────────────────────────────

/** The part of the pdf.js API the extractor uses (`pdfjs-dist`, legacy build in Node). */
export interface PdfJsModule {
  getDocument(params: Record<string, unknown>): { promise: Promise<PdfJsDocument>; destroy(): Promise<void> };
}
interface PdfJsDocument {
  numPages: number;
  getMetadata(): Promise<{ info: unknown }>;
  getPage(n: number): Promise<PdfJsPage>;
}
interface PdfJsPage {
  view: number[];
  getTextContent(params: Record<string, unknown>): Promise<{
    items: unknown[];
    styles: Record<string, { ascent?: number; descent?: number; vertical?: boolean }>;
  }>;
  cleanup(): void;
}
interface TextItem {
  str: string;
  transform: number[];
  width: number;
  height: number;
  fontName: string;
}

/** pdfplumber's defaults for grouping characters into words and lines. */
export const X_TOLERANCE = 3;
export const Y_TOLERANCE = 3;
const DEDUPE_TOLERANCE = 1;
const LEADING_WS = new RegExp(`^[${PY_WS}]+`, "u");
const TRAILING_WS = new RegExp(`[${PY_WS}]+$`, "u");

interface Box {
  text: string;
  font: string;
  x0: number;
  x1: number;
  top: number;
  bottom: number;
}

/**
 * Groups pdf.js text items into lines the way pdfplumber's `extract_text_lines(layout=False,
 * strip=True)` groups characters after `dedupe_chars()`:
 *
 * - duplicated runs (generators that fake bold by printing twice) are dropped when the same text in
 *   the same font sits within 1 pt;
 * - items whose tops are within 3 pt of the previous one (sorted by top) form a line;
 * - in a line, items are ordered by x; a gap over 3 pt or whitespace at the joint means a space.
 *
 * pdf.js reports runs, not characters, so a run with spaces at its edges has its box trimmed in
 * proportion to the characters removed (pdfplumber strips those characters exactly).
 */
export function linesFromItems(page: number, items: readonly Box[]): Line[] {
  const kept: Box[] = [];
  for (const item of items) {
    const dup = kept.some(
      (k) =>
        k.text === item.text &&
        k.font === item.font &&
        Math.abs(k.x0 - item.x0) <= DEDUPE_TOLERANCE &&
        Math.abs(k.top - item.top) <= DEDUPE_TOLERANCE,
    );
    if (!dup) kept.push(item);
  }
  const sorted = kept.map((b, i) => ({ b, i })).sort((a, z) => a.b.top - z.b.top || a.i - z.i);
  const clusters: Box[][] = [];
  let last: number | null = null;
  for (const { b } of sorted) {
    if (last === null || b.top > last + Y_TOLERANCE) clusters.push([]);
    clusters.at(-1)!.push(b);
    last = b.top;
  }
  const out: Line[] = [];
  for (const cluster of clusters) {
    const ordered = cluster.map((b, i) => ({ b, i })).sort((a, z) => a.b.x0 - z.b.x0 || a.i - z.i);
    let text = "";
    let prev: Box | null = null;
    for (const { b } of ordered) {
      if (prev !== null) {
        const gap = b.x0 > prev.x1 + X_TOLERANCE;
        const spaced = TRAILING_WS.test(prev.text) || LEADING_WS.test(b.text);
        if (gap && !spaced) text += " ";
      }
      text += b.text;
      prev = b;
    }
    const x0 = Math.min(...cluster.map((b) => b.x0));
    const x1 = Math.max(...cluster.map((b) => b.x1));
    const top = Math.min(...cluster.map((b) => b.top));
    const bottom = Math.max(...cluster.map((b) => b.bottom));
    out.push(line(page, text, [x0, top, x1, bottom]));
  }
  return out;
}

function isTextItem(item: unknown): item is TextItem {
  return typeof item === "object" && item !== null && typeof (item as TextItem).str === "string";
}

function boxOf(item: TextItem, view: number[], descent: number): Box | null {
  const units = [...item.str];
  const lead = units.length - [...item.str.replace(LEADING_WS, "")].length;
  const trimmedText = pyStrip(item.str);
  if (!trimmedText) return null;
  const trail = units.length - lead - [...trimmedText].length;
  const [a = 1, b = 0, , d = 1, e = 0, f = 0] = item.transform;
  const size = item.height || Math.hypot(b, d) || Math.abs(a);
  const perChar = units.length ? item.width / units.length : 0;
  const x0 = e - (view[0] ?? 0) + lead * perChar;
  const x1 = e - (view[0] ?? 0) + item.width - trail * perChar;
  const y0 = f + descent * size;
  const top = (view[3] ?? 0) - (y0 + size);
  return { text: trimmedText, font: item.fontName, x0, x1, top, bottom: top + size };
}

function passwordProblem(error: unknown, password: string | null): SourceError | null {
  if (typeof error === "object" && error !== null && (error as { name?: string }).name === "PasswordException") {
    return new SourceError(password ? SourceProblem.WRONG_PASSWORD : SourceProblem.PASSWORD_REQUIRED);
  }
  return null;
}

/** pdf.js loaded on demand: the legacy build runs in Node and in workers without modern-only APIs. */
async function defaultPdfJs(): Promise<PdfJsModule> {
  return (await import("pdfjs-dist/legacy/build/pdf.mjs")) as unknown as PdfJsModule;
}

/**
 * PDF text with pdf.js. Nothing is fetched: fonts are not loaded (`disableFontFace`, no system or
 * standard font data; glyph widths come from the PDF or pdf.js's built-in metrics), no eval, no
 * range or stream requests, no worker fetches. Text is not Unicode-normalized, like pdfplumber.
 */
export class PdfJsExtractor implements PdfTextExtractor {
  private readonly load: () => Promise<PdfJsModule>;

  constructor(load: () => Promise<PdfJsModule> = defaultPdfJs) {
    this.load = load;
  }

  async extract(data: Uint8Array, password: string | null): Promise<PdfText> {
    const pdfjs = await this.load();
    const task = pdfjs.getDocument({
      data: data.slice(), // pdf.js takes ownership of the buffer
      password: password ?? "",
      disableFontFace: true,
      useSystemFonts: false,
      isEvalSupported: false,
      isOffscreenCanvasSupported: false,
      isImageDecoderSupported: false,
      useWorkerFetch: false,
      disableAutoFetch: true,
      disableStream: true,
      disableRange: true,
      enableXfa: false,
      stopAtErrors: false,
      verbosity: 0,
    });
    let doc: PdfJsDocument;
    try {
      doc = await task.promise;
    } catch (error) {
      throw passwordProblem(error, password) ?? new SourceError(SourceProblem.INVALID);
    }
    try {
      if (doc.numPages > MAX_PAGES) throw new SourceError(SourceProblem.TOO_MANY_PAGES);
      const info = (await doc.getMetadata()).info as Record<string, unknown> | null;
      const producer = info && info["Producer"] ? pyHead(String(info["Producer"]), 80) : null;
      const lines: Line[] = [];
      for (let n = 1; n <= doc.numPages; n++) {
        const page = await doc.getPage(n);
        const content = await page.getTextContent({ includeMarkedContent: false, disableNormalization: true });
        const boxes: Box[] = [];
        for (const item of content.items) {
          if (!isTextItem(item)) continue;
          const style = content.styles[item.fontName];
          if (style?.vertical) continue; // vertical writing: not in any supported layout
          const box = boxOf(item, page.view, style?.descent ?? 0);
          if (box !== null) boxes.push(box);
        }
        lines.push(...linesFromItems(n, boxes));
        page.cleanup();
      }
      return { pages: doc.numPages, producer, lines };
    } finally {
      await task.destroy();
    }
  }
}
