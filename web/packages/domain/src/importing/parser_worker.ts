/**
 * Reading documents off the main thread: extraction (pdf.js), layout detection and parsing run in
 * a Web Worker, the equivalent of the desktop running parsers as untrusted code
 * (`pipeline.run_parser`, docs/05 §3). Web-only: no desktop counterpart.
 *
 * The worker gets the document bytes and answers with what `pipeline.analyzeDocument` found, as
 * plain JSON. The main thread never trusts that answer: `ParserWorkerClient` validates it with
 * zod (strict objects, decimals as text, ISO dates) before `pipeline.importAnalyzed` stores
 * anything. A worker that crashes, hangs past the timeout or answers garbage costs one document,
 * never the session.
 *
 * In the worker script:
 *
 *     import { serveParser } from "@opesvault/domain/…/parser_worker";
 *     serveParser(self, new PdfJsExtractor(() => import("pdfjs-dist/legacy/build/pdf.mjs")));
 *
 * Nothing here touches the ledger, the DOM or the network.
 */
import { z } from "zod";

import { Dec } from "../lib/dec.ts";
import { zDate } from "../lib/schema.ts";
import { DocFormat, ItemKind, StatementHeaderSchema } from "./model.ts";
import type { ParsedItem, ParseResult } from "./parsers/base.ts";
import { type Analysis, analyzeDocument, type Choice, type ImportRequest } from "./pipeline.ts";
import { type Line, type PdfTextExtractor, type Source, SourceError, SourceProblem } from "./source.ts";

const vals = <T extends Record<string, string>>(o: T) => Object.values(o) as [T[keyof T], ...T[keyof T][]];

// ── what crosses the boundary ───────────────────────

/** A decimal as text: never a JS number, so money never passes through a float. */
const zDecText = z.string().regex(/^-?\d+(\.\d+)?$|^-?\d+(\.\d+)?E[+-]\d+$/, "invalid decimal");

const LineJson = z.strictObject({
  page: z.number().int().min(0),
  text: z.string(),
  bbox: z.tuple([z.number(), z.number(), z.number(), z.number()]).nullable(),
  number: z.number().int().nullable(),
});

const SourceJson = z.strictObject({
  name: z.string(),
  format: z.enum(vals(DocFormat)),
  lines: z.array(LineJson),
  rows: z.array(z.tuple([z.number().int(), z.array(z.string())])),
  ofx: z
    .strictObject({
      kind: z.enum(["bank", "card"]),
      account_id: z.string().nullable(),
      bank_id: z.string().nullable(),
      currency: z.string().nullable(),
      ledger_balance: z.string().nullable(),
      ledger_balance_date: z.string().nullable(),
      start: z.string().nullable(),
      end: z.string().nullable(),
      transactions: z.array(
        z.strictObject({ line: z.number().int(), fields: z.array(z.tuple([z.string(), z.string()])) }),
      ),
    })
    .nullable(),
  pages: z.number().int().min(0),
  producer: z.string().nullable(),
});

const ItemJson = z.strictObject({
  kind: z.enum(vals(ItemKind)),
  occurred_on: zDate.nullable(),
  description: z.string(),
  amount: zDecText.nullable(),
  lines: z.array(LineJson),
  installment: z.tuple([z.number().int(), z.number().int()]).nullable(),
  card_last4: z.string().nullable(),
  bank_id: z.string().nullable(),
  foreign_amount: zDecText.nullable(),
  foreign_currency: z.string().nullable(),
  quantity: zDecText.nullable(),
  unit_price: zDecText.nullable(),
  ticker: z.string().nullable(),
  credit: z.boolean(),
  warnings: z.array(z.string()),
});

const HeaderJson = z.strictObject(
  Object.fromEntries(
    Object.keys(StatementHeaderSchema.shape).map((k) => [k, z.union([z.string(), z.null()])]),
  ) as Record<keyof typeof StatementHeaderSchema.shape, z.ZodUnion<[z.ZodString, z.ZodNull]>>,
);

const ResultJson = z.strictObject({
  header: HeaderJson,
  items: z.array(ItemJson),
  warnings: z.array(z.string()),
  unmapped: z.array(LineJson),
});

const ChoiceJson = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("none"), candidates: z.array(z.string()) }),
  z.strictObject({ kind: z.literal("unknown_parser"), parser_id: z.string() }),
  z.strictObject({ kind: z.literal("failed"), parser_id: z.string(), message: z.string() }),
  z.strictObject({ kind: z.literal("parsed"), parser_id: z.string(), result: ResultJson }),
]);

const AnalysisJson = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("problem"), problem: z.enum(vals(SourceProblem)) }),
  z.strictObject({ kind: z.literal("read"), source: SourceJson, choice: ChoiceJson }),
]);

export const WorkerRequestSchema = z.strictObject({
  id: z.number().int(),
  name: z.string(),
  data: z.custom<Uint8Array>((v) => v instanceof Uint8Array, "bytes"),
  password: z.string().nullable(),
  parser_id: z.string().nullable(),
});
export type WorkerRequest = z.output<typeof WorkerRequestSchema>;

/** Error codes only: nothing from the document or the exception text crosses back. */
export const WorkerReplySchema = z.discriminatedUnion("kind", [
  z.strictObject({ id: z.number().int(), kind: z.literal("analysis"), analysis: AnalysisJson }),
  z.strictObject({ id: z.number().int(), kind: z.literal("source_error"), problem: z.enum(vals(SourceProblem)) }),
  z.strictObject({ id: z.number().int(), kind: z.literal("error"), code: z.literal("WORKER_FAILED") }),
]);
export type WorkerReply = z.output<typeof WorkerReplySchema>;

// ── serializing ─────────────────────────────────────

const dec = (v: Dec | null) => (v === null ? null : v.toString());

function lineJson(line: Line): z.input<typeof LineJson> {
  return { page: line.page, text: line.text, bbox: line.bbox ? [...line.bbox] : null, number: line.number };
}

function resultJson(result: ParseResult): z.input<typeof ResultJson> {
  const header = Object.fromEntries(
    Object.entries(result.header).map(([k, v]) => [k, v instanceof Dec ? v.toString() : (v as string | null)]),
  ) as z.input<typeof HeaderJson>;
  return {
    header,
    items: result.items.map((i) => ({
      kind: i.kind,
      occurred_on: i.occurred_on,
      description: i.description,
      amount: dec(i.amount),
      lines: i.lines.map(lineJson),
      installment: i.installment ? [i.installment[0], i.installment[1]] : null,
      card_last4: i.card_last4,
      bank_id: i.bank_id,
      foreign_amount: dec(i.foreign_amount),
      foreign_currency: i.foreign_currency,
      quantity: dec(i.quantity),
      unit_price: dec(i.unit_price),
      ticker: i.ticker,
      credit: i.credit,
      warnings: [...i.warnings],
    })),
    warnings: [...result.warnings],
    unmapped: result.unmapped.map(lineJson),
  };
}

function choiceJson(choice: Choice): z.input<typeof ChoiceJson> {
  if (choice.kind === "parsed") return { ...choice, result: resultJson(choice.result) };
  if (choice.kind === "none") return { kind: "none", candidates: [...choice.candidates] };
  return { ...choice };
}

export function analysisJson(analysis: Analysis): z.input<typeof AnalysisJson> {
  if (analysis.kind === "problem") return analysis;
  const src = analysis.source;
  return {
    kind: "read",
    source: {
      name: src.name,
      format: src.format,
      lines: src.lines.map(lineJson),
      rows: src.rows.map(([n, cells]) => [n, [...cells]]),
      ofx:
        src.ofx === null
          ? null
          : {
              ...src.ofx,
              kind: src.ofx.kind === "card" ? "card" : "bank",
              transactions: src.ofx.transactions.map((t) => ({ line: t.line, fields: [...t.fields] })),
            },
      pages: src.pages,
      producer: src.producer,
    },
    choice: choiceJson(analysis.choice),
  };
}

// ── reviving ────────────────────────────────────────

const revDec = (v: string | null) => (v === null ? null : Dec.parse(v));

function lineFrom(json: z.output<typeof LineJson>): Line {
  return { page: json.page, text: json.text, bbox: json.bbox, number: json.number };
}

function resultFrom(json: z.output<typeof ResultJson>): ParseResult {
  const items: ParsedItem[] = json.items.map((i) => ({
    ...i,
    amount: revDec(i.amount),
    foreign_amount: revDec(i.foreign_amount),
    quantity: revDec(i.quantity),
    unit_price: revDec(i.unit_price),
    lines: i.lines.map(lineFrom),
  }));
  return {
    header: StatementHeaderSchema.parse(json.header),
    items,
    warnings: json.warnings,
    unmapped: json.unmapped.map(lineFrom),
  };
}

/** Validates a worker's analysis and turns it back into domain values (Dec, Map, Line). */
export function analysisFrom(raw: unknown): Analysis {
  const json = AnalysisJson.parse(raw);
  if (json.kind === "problem") return json;
  const s = json.source;
  const source: Source = {
    name: s.name,
    format: s.format,
    lines: s.lines.map(lineFrom),
    rows: s.rows,
    ofx:
      s.ofx === null
        ? null
        : { ...s.ofx, transactions: s.ofx.transactions.map((t) => ({ line: t.line, fields: new Map(t.fields) })) },
    pages: s.pages,
    producer: s.producer,
  };
  const c = json.choice;
  const choice: Choice = c.kind === "parsed" ? { ...c, result: resultFrom(c.result) } : c;
  return { kind: "read", source, choice };
}

// ── the worker side ─────────────────────────────────

/** Runs one request. Never throws: failures become a code. */
export async function handleRequest(raw: unknown, extractor: PdfTextExtractor): Promise<WorkerReply> {
  const parsed = WorkerRequestSchema.safeParse(raw);
  const id = parsed.success ? parsed.data.id : -1;
  if (!parsed.success) return { id, kind: "error", code: "WORKER_FAILED" };
  const request: ImportRequest = {
    name: parsed.data.name,
    data: parsed.data.data,
    password: parsed.data.password,
    parser_id: parsed.data.parser_id,
  };
  try {
    const analysis = await analyzeDocument(request, extractor);
    return { id, kind: "analysis", analysis: AnalysisJson.parse(analysisJson(analysis)) };
  } catch (error) {
    if (error instanceof SourceError) return { id, kind: "source_error", problem: error.problem };
    return { id, kind: "error", code: "WORKER_FAILED" };
  }
}

/** The message port the worker listens on (`self` in a Web Worker, a MessagePort in tests). */
export interface WorkerPort {
  postMessage(message: unknown): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
}

export function serveParser(port: WorkerPort, extractor: PdfTextExtractor): void {
  port.addEventListener("message", (event) => {
    void handleRequest(event.data, extractor).then((reply) => port.postMessage(reply));
  });
}

// ── the main-thread side ────────────────────────────

/** The worker failed, timed out or answered something invalid; the document can be tried again. */
export class WorkerFailed extends Error {
  constructor() {
    super("WORKER_FAILED");
    this.name = "WorkerFailed";
  }
}

export interface ClientPort extends WorkerPort {
  removeEventListener?(type: "message", listener: (event: { data: unknown }) => void): void;
}

export class ParserWorkerClient {
  private readonly port: ClientPort;
  private readonly timeoutMs: number;
  private next = 1;
  private readonly waiting = new Map<number, (reply: unknown) => void>();

  constructor(port: ClientPort, timeoutMs = 120_000) {
    this.port = port;
    this.timeoutMs = timeoutMs;
    port.addEventListener("message", (event) => {
      const id = (event.data as { id?: unknown } | null)?.id;
      if (typeof id === "number") this.waiting.get(id)?.(event.data);
    });
  }

  /**
   * `pipeline.analyzeDocument` in the worker. Throws `SourceError` for PDF password problems (the UI
   * asks again) and `WorkerFailed` for anything else that went wrong outside the main thread.
   */
  analyze(request: ImportRequest): Promise<Analysis> {
    const id = this.next++;
    const message: WorkerRequest = {
      id,
      name: request.name,
      data: request.data,
      password: request.password ?? null,
      parser_id: request.parser_id ?? null,
    };
    return new Promise<Analysis>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        reject(new WorkerFailed());
      }, this.timeoutMs);
      this.waiting.set(id, (raw) => {
        clearTimeout(timer);
        this.waiting.delete(id);
        const reply = WorkerReplySchema.safeParse(raw);
        if (!reply.success || reply.data.kind === "error") return reject(new WorkerFailed());
        if (reply.data.kind === "source_error") return reject(new SourceError(reply.data.problem));
        try {
          resolve(analysisFrom(reply.data.analysis));
        } catch {
          reject(new WorkerFailed());
        }
      });
      this.port.postMessage(message);
    });
  }
}
