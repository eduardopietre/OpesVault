/**
 * Informes de rendimentos: reading one and checking it against what was recorded.
 * Port of `tax/statements.py`.
 *
 * The reader is generic and conservative: it looks for the calendar year, the payer's CNPJ and lines
 * that end in an amount and name a known field ("Saldo em 31/12/2025", "Imposto retido", "Rendimentos
 * isentos"...). Anything else stays out and is listed, never guessed. Layouts were not validated with
 * real documents yet (docs/15 §2): every line read is shown for review before it is saved. Like the
 * parsers, the text is data, never instructions.
 */
import { AccountType, cashDate } from "../domain/model.ts";
import { type Ledger } from "../domain/ledger.ts";
import { MoneyError, parseBrl, ZERO } from "../domain/money.ts";
import * as queries from "../domain/queries.ts";
import { EventKind, realizedGain } from "../investments/model.ts";
import { events, positions } from "../investments/service.ts";
import { normalize } from "../importing/rules.ts";
import { loadSource, type PdfTextExtractor } from "../importing/source.ts";
import { makeDate } from "../lib/dates.ts";
import { Dec } from "../lib/dec.ts";
import type { Id } from "../lib/ids.ts";
import { orDec, pyHead, pyStrip } from "../lib/py.ts";
import * as ids from "./ids.ts";
import {
  IncomeKind,
  IncomeNature,
  type IncomeReport,
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

const AMOUNT = /(-?\s*R?\$?\s*-?\d{1,3}(?:\.\d{3})*,\d{2})\s*$/;
const YEAR = /ANO[- ]CALENDARIO\s*(?:DE)?\s*:?\s*(\d{4})/;
const EXERCISE = /EXERCICIO\s*(?:DE)?\s*:?\s*(\d{4})/;
const BALANCE = /SALDO\s+(?:EM|DE|NO DIA|ATE)\s+31\/12\/(\d{4})/;

export interface ParsedReport {
  year: number | null;
  payerTaxId: string | null;
  payerName: string | null;
  lines: ReportLine[];
  /** Lines with an amount that matched no field. */
  skipped: string[];
}

function field(text: string, year: number | null): ReportField | null {
  const balance = BALANCE.exec(text);
  if (balance !== null) {
    const found = Number(balance[1]);
    if (year !== null && found === year - 1) return ReportField.BALANCE_PREVIOUS;
    return ReportField.BALANCE_END;
  }
  if (text.includes("SALDO") && text.includes("31/12")) {
    return text.includes("ANTERIOR") ? ReportField.BALANCE_PREVIOUS : ReportField.BALANCE_END;
  }
  if (text.includes("PREVIDENCIA") && (text.includes("OFICIAL") || text.includes("CONTRIBUICAO"))) {
    return ReportField.SOCIAL_SECURITY;
  }
  const thirteenth = text.includes("13O SALARIO") || text.includes("13 SALARIO") || text.includes("DECIMO TERCEIRO");
  if (thirteenth) return text.includes("IMPOSTO") || text.includes("IRRF") ? null : ReportField.THIRTEENTH;
  if ((text.includes("IMPOSTO") && text.includes("RETIDO")) || text.includes("IRRF")) return ReportField.WITHHELD;
  if (text.includes("TRIBUTACAO EXCLUSIVA") || text.includes("TRIBUTACAO DEFINITIVA")) return ReportField.EXCLUSIVE;
  if (text.includes("ISENTO") || text.includes("ISENTOS") || text.includes("NAO TRIBUTAVE")) return ReportField.EXEMPT;
  if (text.includes("RENDIMENTOS TRIBUTAVEIS") || text.includes("TOTAL DOS RENDIMENTOS")) return ReportField.TAXABLE;
  return null;
}

/** Reads the text lines of an informe. Never raises on bad input: what is unclear is skipped. */
export function parse(input: readonly unknown[]): ParsedReport {
  const lines = input.slice(0, MAX_LINES).filter((line): line is string => typeof line === "string");
  let year: number | null = null;
  let payerTaxId: string | null = null;
  let payerName: string | null = null;
  for (const raw of lines) {
    const text = normalize(raw);
    if (year === null) {
      const match = YEAR.exec(text);
      if (match !== null) {
        year = Number(match[1]);
      } else {
        const exercise = EXERCISE.exec(text);
        if (exercise !== null) year = Number(exercise[1]) - 1;
      }
    }
    if (payerTaxId === null && text.includes("CNPJ")) {
      payerTaxId = ids.findCnpj(raw);
      if (payerTaxId !== null) {
        const before = pyStrip(raw.split(/\s*[-–,]?\s*CNPJ/i)[0] ?? "", " :-–");
        payerName = pyHead(before, 150) || null;
      }
    }
  }
  const out: ParsedReport = {
    year: year !== null && year >= 1990 && year <= 2999 ? year : null,
    payerTaxId,
    payerName,
    lines: [],
    skipped: [],
  };
  const found = new Map<ReportField, [boolean, ReportLine][]>();
  let section: ReportField | null = null; // informes list items under a heading ("Rendimentos isentos")
  for (const raw of lines) {
    const text = normalize(raw);
    const match = AMOUNT.exec(pyStrip(raw));
    if (match === null) {
      if ([...text].length < 120) {
        const heading = field(text, out.year);
        if (heading !== null || /^\d+\s*[.)-]/.test(text)) section = heading; // a numbered heading ends the last one
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
    const kind = field(text, out.year) ?? section;
    if (kind === null) {
      out.skipped.push(pyHead(pyStrip(raw), 200));
      continue;
    }
    const isTotal = text.includes("TOTAL");
    const line = ReportLineSchema.parse({ field: kind, amount: amount.abs(), label: pyHead(pyStrip(raw), 200) });
    const list = found.get(kind);
    if (list === undefined) found.set(kind, [[isTotal, line]]);
    else list.push([isTotal, line]);
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
  /** null: the app has no figure for this field. */
  readonly recorded: Dec | null;
  readonly note: string;
}

export function difference(check: Check): Dec | null {
  return check.recorded === null ? null : check.informed.sub(check.recorded);
}

export function matches(check: Check): boolean {
  return check.recorded !== null && check.informed.sub(check.recorded).abs().lte(Dec.from("0.01"));
}

export function totals(report: IncomeReport): Map<ReportField, Dec> {
  const out = new Map<ReportField, Dec>();
  for (const line of report.lines) out.set(line.field, (out.get(line.field) ?? ZERO).add(line.amount));
  return out;
}

function under(ledger: Ledger, accountId: Id, parentId: Id): boolean {
  const account = ledger.accounts.get(accountId);
  return account !== undefined && account.parent_id === parentId && account.type === AccountType.INCOME;
}

/** Investment income credited to this account (proventos, redemption gains) and tax withheld. */
function accountIncome(ledger: Ledger, accountId: Id, year: number): Map<ReportField, Dec> {
  const held = new Set([...positions(ledger).values()].filter((p) => p.account_id === accountId).map((p) => p.id));
  let withheld = ZERO;
  let exempt = ZERO;
  let exclusive = ZERO;
  let seen = false;
  for (const event of events(ledger).values()) {
    if (
      Number(event.on.slice(0, 4)) !== year ||
      (event.cash_account_id !== accountId && !held.has(event.position_id))
    ) {
      continue;
    }
    seen = true;
    withheld = withheld.add(event.tax_withheld);
    const nature = records.natureOf(ledger, NatureSubject.POSITION, event.position_id);
    let value: Dec;
    if (event.kind === EventKind.DISTRIBUTION) {
      value = event.gross !== null ? event.gross : orDec(event.net, ZERO);
    } else if (event.kind === EventKind.WITHDRAWAL || event.kind === EventKind.SELL) {
      const gain = orDec(realizedGain(event), ZERO);
      value = ZERO.gt(gain) ? ZERO : gain; // max(gain, ZERO)
    } else {
      continue;
    }
    if (nature === IncomeNature.EXEMPT) exempt = exempt.add(value);
    else if (nature === IncomeNature.EXCLUSIVE) exclusive = exclusive.add(value);
  }
  if (!seen) return new Map();
  return new Map([
    [ReportField.WITHHELD, withheld],
    [ReportField.EXEMPT, exempt],
    [ReportField.EXCLUSIVE, exclusive],
  ]);
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
    const value = Dec.sum(
      op.postings
        .filter((p) => p.account_id === report.source_id || under(ledger, p.account_id, report.source_id))
        .map((p) => p.amount.negate()),
      ZERO,
    );
    if (value.isZero()) continue;
    const detail = records.detailOf(ledger, op.id);
    const gross = detail !== null && detail.gross !== null ? detail.gross : value;
    if (detail !== null && detail.kind === IncomeKind.THIRTEENTH) {
      thirteenth = thirteenth.add(gross);
      continue;
    }
    taxable = taxable.add(gross);
    if (detail !== null) {
      withheld = withheld.add(orDec(detail.withheld, ZERO));
      social = social.add(orDec(detail.social_security, ZERO));
    }
  }
  out.set(ReportField.TAXABLE, taxable);
  out.set(ReportField.THIRTEENTH, thirteenth);
  out.set(ReportField.WITHHELD, withheld);
  out.set(ReportField.SOCIAL_SECURITY, social);
  return out;
}

export function check(ledger: Ledger, report: IncomeReport): Check[] {
  const informed = totals(report);
  const have = recorded(ledger, report);
  return [...informed].map(([kind, value]) => ({
    field: kind,
    informed: value,
    recorded: have.get(kind) ?? null,
    note: "",
  }));
}

export function differences(ledger: Ledger, report: IncomeReport): Check[] {
  return check(ledger, report).filter((c) => c.recorded !== null && !matches(c));
}
