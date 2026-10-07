/**
 * Import pipeline (docs/05 §3): validate, extract, detect, parse, reconcile, review, approve.
 * Port of `importing/pipeline.py`.
 *
 * Nothing here writes anywhere but the session. Approved items become ledger operations with
 * their evidence; everything else stays visible as pending. This module reads a document into a
 * batch; the later steps live in `checks` (problems, totals, duplicates), `suggestions`
 * (categories) and `approval` (review decisions). Callers use them through this module.
 *
 * Reading a document is split in two so it can run off the main thread: `analyzeDocument`
 * (extraction, layout detection and parsing; no ledger, async) runs in `parser_worker.ts`, and
 * `importAnalyzed` stores the outcome in the session (sync, main thread). `importDocument` does
 * both in one call, in the order the desktop did.
 */
import { nowInstant } from "../lib/dates.ts";
import type { Id } from "../lib/ids.ts";
import { sortedBy } from "../lib/text.ts";
import { DomainError, type Ledger } from "../domain/ledger.ts";
import { type Session, sha256Hex } from "../session.ts";
import { BatchNotFound, refreshBatch } from "./checks.ts";
import {
  BatchStatus,
  DocFormat,
  DocType,
  EvidenceSchema,
  type ExtractedItem,
  ExtractedItemSchema,
  type ImportBatch,
  ImportBatchSchema,
} from "./model.ts";
import { AMBIGUITY_MARGIN, DETECTION_THRESHOLD, PARSERS, parserById } from "./parsers/index.ts";
import { type ParsedItem, type Parser, type ParseResult, pyHead } from "./parsers/base.ts";
import {
  loadSource,
  type PdfTextExtractor,
  PROBLEM_MESSAGES,
  type Source,
  SourceError,
  SourceProblem,
} from "./source.ts";
import { batches } from "./store.ts";

export {
  BANK_KINDS,
  CARD_KINDS,
  itemProblems,
  MATCH_WINDOW_DAYS,
  normalize,
  reconcile,
  refreshBatch,
} from "./checks.ts";
export {
  type ApprovalResult,
  approve,
  correctItem,
  EDITABLE_FIELDS,
  keepSeparate,
  rejectItems,
  setBatchTarget,
  updateBatchStatus,
} from "./approval.ts";
export { applyRules, KEYWORD_RULES } from "./suggestions.ts";
export { batches, evidence, items, itemsOf } from "./store.ts";

export class ImportRefused extends DomainError {
  constructor(message: string) {
    super(message);
    this.name = "ImportRefused";
  }
}

/** A parser could not read a document it accepted; the message has no document content. */
export class ParseFailed extends DomainError {
  constructor(message: string) {
    super(message);
    this.name = "ParseFailed";
  }
}

// ── step 1-6: from bytes to a batch in review ───────

export interface ImportRequest {
  readonly name: string;
  readonly data: Uint8Array;
  readonly password?: string | null; // used once, never stored (docs/05 §3)
  readonly parser_id?: string | null;
  readonly account_id?: Id | null;
  readonly card_id?: Id | null;
}

/** What reading a document gave, before anything is stored. */
export type Choice =
  | { readonly kind: "none"; readonly candidates: readonly string[] } // ambiguous or unknown layout
  | { readonly kind: "unknown_parser"; readonly parser_id: string } // a forced id that does not exist
  | { readonly kind: "failed"; readonly parser_id: string; readonly message: string } // ParseFailed
  | { readonly kind: "parsed"; readonly parser_id: string; readonly result: ParseResult };

export type Analysis =
  | { readonly kind: "problem"; readonly problem: SourceProblem } // never a password problem: those throw
  | { readonly kind: "read"; readonly source: Source; readonly choice: Choice };

/**
 * Extraction, layout detection and parsing, without the ledger (safe in a worker).
 * A missing or wrong PDF password throws `SourceError`: the UI asks and tries again.
 */
export async function analyzeDocument(request: ImportRequest, extractor: PdfTextExtractor): Promise<Analysis> {
  let src: Source;
  try {
    src = await loadSource(request.name, request.data, request.password ?? null, extractor);
  } catch (error) {
    if (!(error instanceof SourceError)) throw error;
    if (error.problem === SourceProblem.PASSWORD_REQUIRED || error.problem === SourceProblem.WRONG_PASSWORD)
      throw error;
    return { kind: "problem", problem: error.problem };
  }
  return { kind: "read", source: src, choice: choose(src, request.parser_id ?? null) };
}

function choose(src: Source, forced: string | null): Choice {
  let parser: Parser | null;
  let candidates: string[];
  try {
    [parser, candidates] = chooseParser(src, forced);
  } catch (error) {
    if (forced !== null && error instanceof Error && error.name === "KeyError")
      return { kind: "unknown_parser", parser_id: forced };
    throw error;
  }
  if (parser === null) return { kind: "none", candidates };
  try {
    return { kind: "parsed", parser_id: parser.id, result: runParser(parser, src) };
  } catch (error) {
    if (error instanceof ParseFailed) return { kind: "failed", parser_id: parser.id, message: error.message };
    throw error;
  }
}

/** Refuses a file already imported in this project (TA-12), before reading it. */
export function checkNotImported(session: Session, data: Uint8Array): void {
  const existing = session.findDocumentByHash(sha256Hex(data));
  if (existing !== null && [...batches(session.ledger).values()].some((b) => b.document_id === existing.meta.id))
    throw new ImportRefused("Este arquivo já foi importado neste cofre (mesmo conteúdo).");
}

export async function importDocument(
  session: Session,
  request: ImportRequest,
  extractor: PdfTextExtractor,
): Promise<ImportBatch> {
  checkNotImported(session, request.data);
  return importAnalyzed(session, request, await analyzeDocument(request, extractor));
}

/** Stores what `analyzeDocument` found (main thread): the document, its batch and items. */
export function importAnalyzed(session: Session, request: ImportRequest, analysis: Analysis): ImportBatch {
  const ledger = session.ledger;
  checkNotImported(session, request.data);
  const existing = session.findDocumentByHash(sha256Hex(request.data));
  if (analysis.kind === "problem") {
    const document = existing ?? session.addDocument(request.name, request.data);
    const pdf = request.data.length >= 4 && new TextDecoder("latin1").decode(request.data.subarray(0, 4)) === "%PDF";
    return storeBatch(
      ledger,
      ImportBatchSchema.parse({
        document_id: document.meta.id,
        parser_id: null,
        parser_version: null,
        doc_format: pdf ? DocFormat.PDF : DocFormat.CSV,
        status: BatchStatus.UNSUPPORTED,
        created_at: nowInstant(),
        warnings: [PROBLEM_MESSAGES[analysis.problem]],
      }),
    );
  }
  const document = existing ?? session.addDocument(request.name, request.data);
  const { source: src, choice } = analysis;
  if (choice.kind === "unknown_parser") {
    parserById(choice.parser_id); // throws KeyError after storing the document, like the desktop
    throw new Error("unreachable");
  }
  if (choice.kind === "none") {
    const warning = choice.candidates.length
      ? "Mais de um layout reconhece este documento; escolha o correto."
      : "Layout desconhecido: nenhum parser suportado reconhece este documento.";
    return storeBatch(
      ledger,
      ImportBatchSchema.parse({
        document_id: document.meta.id,
        parser_id: null,
        parser_version: null,
        doc_format: src.format,
        status: choice.candidates.length ? BatchStatus.AMBIGUOUS : BatchStatus.UNSUPPORTED,
        created_at: nowInstant(),
        warnings: [warning],
        candidates: choice.candidates,
      }),
    );
  }
  if (choice.kind === "failed") {
    // The document is kept so the user can try another layout; no item is invented.
    return storeBatch(
      ledger,
      ImportBatchSchema.parse({
        document_id: document.meta.id,
        parser_id: null,
        parser_version: null,
        doc_format: src.format,
        status: BatchStatus.UNSUPPORTED,
        created_at: nowInstant(),
        warnings: [choice.message],
        candidates: [choice.parser_id],
      }),
    );
  }
  return parseIntoBatch(session, document.meta.id, src, parserById(choice.parser_id), request, choice.result);
}

/**
 * Runs a parser as untrusted code over untrusted input (docs/05 §3, phase 10).
 *
 * Any failure becomes a classified error with the parser id only: no stack, no text from the
 * document, so nothing sensitive can reach a message or a log.
 */
export function runParser(parser: Parser, src: Source): ParseResult {
  if (parser.doc_format !== src.format)
    throw new ParseFailed(`O layout ${parser.id} não lê arquivos ${src.format.toUpperCase()}.`);
  try {
    return parser.parse(src);
  } catch {
    throw new ParseFailed(
      `O layout ${parser.id} não conseguiu interpretar este documento (código PARSE_FAILED). ` +
        "O arquivo foi guardado; tente outro layout ou registre manualmente.",
    );
  }
}

export function chooseParser(src: Source, forced: string | null = null): [Parser | null, string[]] {
  if (forced !== null) return [parserById(forced), []];
  const scored = sortedBy(
    PARSERS.map((p) => [p.detect(src), p] as const),
    (t) => t[0],
    true,
  );
  const viable = scored.filter(([score]) => score >= DETECTION_THRESHOLD);
  if (!viable.length) return [null, []];
  const [bestScore, best] = viable[0]!;
  const close = viable.filter(([score]) => bestScore - score < AMBIGUITY_MARGIN).map(([, p]) => p.id);
  if (close.length > 1) return [null, close];
  return [best, []];
}

/** Resolve an AMBIGUOUS batch by choosing the parser explicitly. */
export async function reparseWith(
  session: Session,
  batchId: Id,
  parserId: string,
  password: string | null,
  extractor: PdfTextExtractor,
): Promise<ImportBatch> {
  checkReparsable(session, batchId);
  const document = session.document(batches(session.ledger).get(batchId)!.document_id);
  const src = await loadSource(document.meta.original_name, document.data, password, extractor);
  const parser = parserById(parserId);
  const result = runParser(parser, src); // fails before the old batch is touched
  return storeReparsed(session, batchId, src, parser, result);
}

/** `reparseWith`'s check, before the document goes to the worker. */
export function checkReparsable(session: Session, batchId: Id): void {
  const batch = batches(session.ledger).get(batchId);
  if (batch === undefined) throw new BatchNotFound(batchId);
  if (batch.status !== BatchStatus.AMBIGUOUS && batch.status !== BatchStatus.UNSUPPORTED)
    throw new DomainError("Só lotes sem layout definido podem ser reprocessados.");
}

/** `reparseWith` for an analysis made in the worker with the chosen `parser_id`. */
export function storeReparseAnalysis(session: Session, batchId: Id, analysis: Analysis): ImportBatch {
  checkReparsable(session, batchId);
  if (analysis.kind === "problem") throw new SourceError(analysis.problem);
  const { choice } = analysis;
  if (choice.kind === "none") throw new DomainError("Escolha um layout.");
  if (choice.kind === "unknown_parser") {
    parserById(choice.parser_id);
    throw new Error("unreachable");
  }
  if (choice.kind === "failed") throw new ParseFailed(choice.message);
  return storeReparsed(session, batchId, analysis.source, parserById(choice.parser_id), choice.result);
}

/** The synchronous half of `reparseWith`, for a result parsed in the worker. */
function storeReparsed(session: Session, batchId: Id, src: Source, parser: Parser, result: ParseResult): ImportBatch {
  const batch = batches(session.ledger).get(batchId);
  if (batch === undefined) throw new BatchNotFound(batchId);
  const document = session.document(batch.document_id);
  batches(session.ledger).delete(batchId);
  const request: ImportRequest = { name: document.meta.original_name, data: document.data, parser_id: parser.id };
  return parseIntoBatch(session, document.meta.id, src, parser, request, result);
}

function storeBatch(ledger: Ledger, batch: ImportBatch): ImportBatch {
  return ledger.put("import_batch", batch);
}

function docType(parser: Parser, src: Source): DocType {
  if (src.ofx !== null && src.ofx.kind === "card") return DocType.CARD_STATEMENT;
  return parser.doc_type;
}

/** Find the card or account this document belongs to from its own identifiers. */
function guessTarget(ledger: Ledger, type: DocType, result: ParseResult): [Id | null, Id | null] {
  if (type === DocType.CARD_STATEMENT) {
    const last4s = new Set(result.items.map((i) => i.card_last4).filter((l): l is string => Boolean(l)));
    for (const card of ledger.cards.values()) {
      if (last4s.has(card.last4) || card.additional.some((a) => last4s.has(a.last4)))
        return [card.liability_account_id, card.id];
    }
    if (ledger.cards.size === 1) {
      const card = [...ledger.cards.values()][0]!;
      return [card.liability_account_id, card.id];
    }
    return [null, null];
  }
  const hint = (result.header.account_hint ?? "").replaceAll(".", "").replaceAll("-", "");
  if (hint) {
    for (const account of ledger.accounts.values()) {
      const masked = (account.masked_number ?? "").replaceAll(".", "").replaceAll("-", "");
      if (masked && (hint.includes(masked) || hint.endsWith(lastChars(masked, 4)))) return [account.id, null];
    }
  }
  return [null, null];
}

/** `text[-n:]` in code points. */
function lastChars(text: string, n: number): string {
  const units = [...text];
  return units.slice(Math.max(0, units.length - n)).join("");
}

function parseIntoBatch(
  session: Session,
  documentId: Id,
  src: Source,
  parser: Parser,
  request: ImportRequest,
  result: ParseResult,
): ImportBatch {
  const ledger = session.ledger;
  const type = docType(parser, src);
  let accountId = request.account_id ?? null;
  let cardId = request.card_id ?? null;
  if (cardId !== null) {
    const card = ledger.cards.get(cardId);
    if (card === undefined) throw new Error("KeyError");
    accountId = card.liability_account_id;
  }
  if (accountId === null) [accountId, cardId] = guessTarget(ledger, type, result);
  const warnings = [...result.warnings];
  if (!parser.validated_with_real_documents)
    warnings.push("Layout ainda não validado com documentos reais: confira cada item com o original.");
  const batch = ImportBatchSchema.parse({
    document_id: documentId,
    parser_id: parser.id,
    parser_version: parser.version,
    doc_format: src.format,
    doc_type: type,
    status: BatchStatus.IN_REVIEW,
    created_at: nowInstant(),
    account_id: accountId,
    card_id: cardId,
    header: result.header,
    warnings,
    unmapped_lines: result.unmapped.length,
  });
  storeBatch(ledger, batch);
  for (const parsed of result.items) storeItem(ledger, batch, parsed, documentId);
  refreshBatch(ledger, batch.id);
  return batches(ledger).get(batch.id)!;
}

function storeItem(ledger: Ledger, batch: ImportBatch, parsed: ParsedItem, documentId: Id): ExtractedItem {
  const evidenceIds: Id[] = [];
  for (const line of parsed.lines) {
    const ev = ledger.put(
      "evidence",
      EvidenceSchema.parse({
        document_id: documentId,
        page: line.page || null,
        bbox: line.bbox,
        line: line.number,
        text: pyHead(line.text, 2000),
      }),
    );
    evidenceIds.push(ev.id);
  }
  const item = ExtractedItemSchema.parse({
    batch_id: batch.id,
    kind: parsed.kind,
    occurred_on: parsed.occurred_on,
    description: parsed.description,
    amount: parsed.amount,
    evidence_ids: evidenceIds,
    installment: parsed.installment,
    card_last4: parsed.card_last4,
    bank_id: parsed.bank_id,
    foreign_amount: parsed.foreign_amount,
    foreign_currency: parsed.foreign_currency,
    quantity: parsed.quantity,
    unit_price: parsed.unit_price,
    ticker: parsed.ticker,
    credit: parsed.credit,
    warnings: parsed.warnings,
  });
  return ledger.put("extracted_item", item);
}
