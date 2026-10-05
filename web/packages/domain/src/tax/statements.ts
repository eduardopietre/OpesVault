/**
 * Informes de rendimentos: reading one and checking it against what was recorded.
 * Port of `tax/statements.py`.
 *
 * The reader is generic and conservative: it looks for the calendar year, the payer's CNPJ and
 * lines that end in an amount and name a known field ("Saldo em 31/12/2025", "Imposto retido",
 * "Rendimentos isentos"...). Anything else stays out and is listed, never guessed. Layouts were
 * not validated with real documents yet (docs/15 §2): every line read is shown for review before
 * it is saved. Like the parsers, the text is data, never instructions.
 */
import type { Ledger } from "../domain/ledger.ts";
import { AccountType, cashDate } from "../domain/model.ts";
import { MoneyError, parseBrl, ZERO } from "../domain/money.ts";
import * as queries from "../domain/queries.ts";
import { makeDate } from "../lib/dates.ts";
import { Dec } from "../lib/dec.ts";
import type { Id } from "../lib/ids.ts";
import { PyRe, pyHead, pyLen, pyStrip } from "../importing/parsers/base.ts";
import { normalize } from "../importing/rules.ts";
import { type PdfTextExtractor, loadSource } from "../importing/source.ts";
import { EventKind, realizedGain } from "../investments/model.ts";
import { events, positions } from "../investments/service.ts";
import * as ids from "./ids.ts";
import {
  IncomeKind,
  type IncomeReport,
  IncomeNature,
  NatureSubject,
  ReportField,
  type ReportLine,
  ReportLineSchema,
  ReportSource,
} from "./model.ts";
import * as records from "./records.ts";

export const VERSION = "informe-generico v1";
export const LIMITATIONS = "Leitura genérica de informes; não validada com documentos reais. Confira cada linha.";
export const MAX_LINES = 400;

const AMOUNT = new PyRe(String.raw`(-?\s*R?\$?\s*-?\d{1,3}(?:\.\d{3})*,\d{2})\s*$`);
const YEAR = new PyRe(String.raw`ANO[- ]CALENDARIO\s*(?:DE)?\s*:?\s*(\d{4})`);
const EXERCISE = new PyRe(String.raw`EXERCICIO\s*(?:DE)?\s*:?\s*(\d{4})`);
const BALANCE = new PyRe(String.raw`SALDO\s+(?:EM|DE|NO DIA|ATE)\s+31/12/(\d{4})`);
const BEFORE_CNPJ = new PyRe(String.raw`\s*[-–,]?\s*CNPJ`, "i");
const NUMBERED = new PyRe(String.raw`^\d+\s*[.)-]`);

export interface ParsedReport {
  year: number | null;
  payer_tax_id: string | null;
  payer_name: string | null;
  lines: ReportLine[];
  skipped: string[]; // lines with an amount that matched no field
}

function fieldOf(text: string, year: number | null): ReportField | null {
  const balance = BALANCE.search(text);
  if (balance !== null) {
    const found = Number.parseInt(balance[1]!, 10);
    if (year !== null && found === year - 1) return ReportField.BALANCE_PREVIOUS;
    return ReportField.BALANCE_END;
  }
  if (text.includes("SALDO") && text.includes("31/12"))
    return text.includes("ANTERIOR") ? ReportField.BALANCE_PREVIOUS : ReportField.BALANCE_END;
  if (text.includes("PREVIDENCIA") && (text.includes("OFICIAL") || text.includes("CONTRIBUICAO")))
    return ReportField.SOCIAL_SECURITY;
  const thirteenth = text.includes("13O SALARIO") || text.includes("13 SALARIO") || text.includes("DECIMO TERCEIRO");
  if (thirteenth) return text.includes("IMPOSTO") || text.includes("IRRF") ? null : ReportField.THIRTEENTH;
  if ((text.includes("IMPOSTO") && text.includes("RETIDO")) || text.includes("IRRF")) return ReportField.WITHHELD;
  if (text.includes("TRIBUTACAO EXCLUSIVA") || text.includes("TRIBUTACAO DEFINITIVA")) return ReportField.EXCLUSIVE;
  if (text.includes("ISENTO") || text.includes("ISENTOS") || text.includes("NAO TRIBUTAVE")) return ReportField.EXEMPT;
  if (text.includes("RENDIMENTOS TRIBUTAVEIS") || text.includes("TOTAL DOS RENDIMENTOS")) return ReportField.TAXABLE;
  return null;
}

/** Reads the text lines of an informe. Never raises on bad input: what is unclear is skipped. */
export function parse(input: readonly string[]): ParsedReport {
  const lines = input.slice(0, MAX_LINES).filter((line) => typeof line === "string");
  let year: number | null = null;
  let payerTaxId: string | null = null;
  let payerName: string | null = null;
  for (const raw of lines) {
    const text = normalize(raw);
    if (year === null) {
      const match = YEAR.search(text);
      if (match !== null) {
        year = Number.parseInt(match[1]!, 10);
      } else {
        const exercise = EXERCISE.search(text);
        if (exercise !== null) year = Number.parseInt(exercise[1]!, 10) - 1;
      }
    }
    if (payerTaxId === null && text.includes("CNPJ")) {
      payerTaxId = ids.findCnpj(raw);
      if (payerTaxId !== null) {
        const cut = BEFORE_CNPJ.search(raw);
        const before = pyStrip(cut === null ? raw : raw.slice(0, cut.index), " :-–");
        payerName = pyHead(before, 150) || null;
      }
    }
  }
  const out: ParsedReport = {
    year: year !== null && year >= 1990 && year <= 2999 ? year : null,
    payer_tax_id: payerTaxId,
    payer_name: payerName,
    lines: [],
    skipped: [],
  };
  const found = new Map<ReportField, [boolean, ReportLine][]>();
  let section: ReportField | null = null; // informes list items under a heading ("Rendimentos isentos")
  for (const raw of lines) {
    const text = normalize(raw);
    const match = AMOUNT.search(pyStrip(raw));
    if (match === null) {
      if (pyLen(text) < 120) {
        const heading = fieldOf(text, out.year);
        if (heading !== null || NUMBERED.match(text) !== null) section = heading; // a numbered heading ends the last one
      }
      continue;
    }
    if (text.includes("CNPJ") || text.includes("CPF")) continue;
    let amount: Dec;
    try {
      amount = parseBrl(match[1]!.replaceAll(" ", ""));
    } catch (error) {
      if (error instanceof MoneyError) continue;
      throw error;
    }
    const kind = fieldOf(text, out.year) ?? section;
    if (kind === null) {
      out.skipped.push(pyHead(pyStrip(raw), 200));
      continue;
    }
    const isTotal = text.includes("TOTAL");
    const entry: [boolean, ReportLine] = [
      isTotal,
      ReportLineSchema.parse({ field: kind, amount: amount.abs(), label: pyHead(pyStrip(raw), 200) }),
    ];
    const list = found.get(kind);
    if (list === undefined) found.set(kind, [entry]);
    else list.push(entry);
  }
  for (const entries of found.values()) {
    const totals = entries.filter(([isTotal]) => isTotal).map(([, line]) => line);
    out.lines.push(...(totals.length ? totals : entries.map(([, line]) => line)));
  }
  return out;
}

/** Text of a PDF (or a text file) to a parsed informe. Runs off the UI thread. */
export async function read(
  data: Uint8Array,
  extractor: PdfTextExtractor,
  password: string | null = null,
): Promise<ParsedReport> {
  const source = await loadSource("informe", data, password, extractor);
  if (source.lines.length) return parse(source.lines.map((l) => l.text));
  return parse(source.rows.map(([, cells]) => cells.join(" ")));
}

// ── comparison with what was recorded ──────────

export interface Check {
  readonly field: ReportField;
  readonly informed: Dec;
  readonly recorded: Dec | null; // null: the app has no figure for this field
  readonly note: string;
}

export function checkOf(field: ReportField, informed: Dec, recorded: Dec | null, note = ""): Check {
  return { field, informed, recorded, note };
}

export function difference(c: Check): Dec | null {
  return c.recorded === null ? null : c.informed.sub(c.recorded);
}

const TOLERANCE = Dec.from("0.01");

export function matches(c: Check): boolean {
  return c.recorded !== null && c.informed.sub(c.recorded).abs().lte(TOLERANCE);
}

export function totals(report: IncomeReport): Map<ReportField, Dec> {
  const out = new Map<ReportField, Dec>();
  for (const line of report.lines) out.set(line.field, (out.get(line.field) ?? ZERO).add(line.amount));
  return out;
}

/** `value or ZERO`: a zero amount (any scale) reads as the plain zero, like Python's truthiness. */
function orZero(value: Dec | null): Dec {
  return value === null || value.isZero() ? ZERO : value;
}

/** What the app has for the same source and year, field by field. */
export function recorded(ledger: Ledger, report: IncomeReport): Map<ReportField, Dec> {
  const year = report.year;
  const out = new Map<ReportField, Dec>();
  if (report.source === ReportSource.ACCOUNT) {
    const account = ledger.account(report.source_id);
    out.set(ReportField.BALANCE_END, queries.balance(ledger, account.id, makeDate(year, 12, 31)));
    out.set(ReportField.BALANCE_PREVIOUS, queries.balance(ledger, account.id, makeDate(year - 1, 12, 31)));
    for (const [k, v] of accountIncome(ledger, report.source_id, year)) out.set(k, v);
    return out;
  }
  let taxable = ZERO;
  let thirteenth = ZERO;
  let withheld = ZERO;
  let social = ZERO;
  for (const op of ledger.activeOperations()) {
    const when = cashDate(op);
    if (when === null || Number(when.slice(0, 4)) !== year) continue;
    let value = ZERO;
    for (const p of op.postings) {
      if (p.account_id === report.source_id || under(ledger, p.account_id, report.source_id))
        value = value.add(p.amount.negate());
    }
    if (value.isZero()) continue;
    const detail = records.detailOf(ledger, op.id);
    const gross = detail !== null && detail.gross !== null ? detail.gross : value;
    if (detail !== null && detail.kind === IncomeKind.THIRTEENTH) {
      thirteenth = thirteenth.add(gross);
      continue;
    }
    taxable = taxable.add(gross);
    if (detail !== null) {
      withheld = withheld.add(orZero(detail.withheld));
      social = social.add(orZero(detail.social_security));
    }
  }
  out.set(ReportField.TAXABLE, taxable);
  out.set(ReportField.THIRTEENTH, thirteenth);
  out.set(ReportField.WITHHELD, withheld);
  out.set(ReportField.SOCIAL_SECURITY, social);
  return out;
}

function under(ledger: Ledger, accountId: Id, parentId: Id): boolean {
  const account = ledger.accounts.get(accountId);
  return account !== undefined && account.parent_id === parentId && account.type === AccountType.INCOME;
}

/** Investment income credited to this account (proventos, redemption gains) and tax withheld. */
function accountIncome(ledger: Ledger, accountId: Id, year: number): Map<ReportField, Dec> {
  const held = new Set<Id>();
  for (const p of positions(ledger).values()) if (p.account_id === accountId) held.add(p.id);
  let withheld = ZERO;
  let exempt = ZERO;
  let exclusive = ZERO;
  let seen = false;
  for (const event of events(ledger).values()) {
    if (Number(event.on.slice(0, 4)) !== year || (event.cash_account_id !== accountId && !held.has(event.position_id)))
      continue;
    seen = true;
    withheld = withheld.add(event.tax_withheld);
    const nature = records.natureOf(ledger, NatureSubject.POSITION, event.position_id);
    let value: Dec;
    if (event.kind === EventKind.DISTRIBUTION) {
      value = event.gross !== null ? event.gross : orZero(event.net);
    } else if (event.kind === EventKind.WITHDRAWAL || event.kind === EventKind.SELL) {
      const gain = orZero(realizedGain(event));
      value = gain.isNegative() ? ZERO : gain;
    } else {
      continue;
    }
    if (nature === IncomeNature.EXEMPT) exempt = exempt.add(value);
    else if (nature === IncomeNature.EXCLUSIVE) exclusive = exclusive.add(value);
  }
  if (!seen) return new Map();
  return new Map<ReportField, Dec>([
    [ReportField.WITHHELD, withheld],
    [ReportField.EXEMPT, exempt],
    [ReportField.EXCLUSIVE, exclusive],
  ]);
}

export function check(ledger: Ledger, report: IncomeReport): Check[] {
  const informed = totals(report);
  const have = recorded(ledger, report);
  return [...informed].map(([kind, value]) => checkOf(kind, value, have.get(kind) ?? null));
}

export function differences(ledger: Ledger, report: IncomeReport): Check[] {
  return check(ledger, report).filter((c) => c.recorded !== null && !matches(c));
}
