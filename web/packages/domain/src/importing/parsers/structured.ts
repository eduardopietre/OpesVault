/**
 * Structured exports: OFX (bank and card) and Nubank CSV (docs/05 §3, exportações estruturadas).
 * Port of `importing/parsers/structured.py`.
 */
import { DateError, type IsoDate, parseDate } from "../../lib/dates.ts";
import { Dec } from "../../lib/dec.ts";
import { casefold } from "../../lib/text.ts";
import { DocFormat, DocType, ItemKind, StatementHeaderSchema } from "../model.ts";
import { line, type Source } from "../source.ts";
import { classify, splitInstallment } from "./cards.ts";
import { dmy, type Parser, type ParseResult, parsedItem, pyHead, PyRe, pyStrip, safeDate } from "./base.ts";

const DOT_DECIMAL = new PyRe(String.raw`[-+]?\d+(\.\d+)?`);

/** OFX/CSV exports use '.' as decimal separator; reject anything else. */
function dotDecimal(text: string): Dec | null {
  const cleaned = pyStrip(text).replaceAll(" ", "");
  if (!DOT_DECIMAL.fullmatch(cleaned)) return null;
  return Dec.parse(cleaned);
}

const OFX_DATE = new PyRe(String.raw`(\d{4})(\d{2})(\d{2})`);

function ofxDate(text: string | null | undefined): IsoDate | null {
  if (!text) return null;
  const m = OFX_DATE.match(text);
  if (!m) return null;
  return safeDate(Number(m[1]), Number(m[2]), Number(m[3]));
}

const CARD_CHARGE = new PyRe(String.raw`\b(IOF|JUROS|MULTA|ANUIDADE)\b`);
const CARD_PAYMENT = new PyRe("PAGAMENTO|PAGTO");

export class OfxParser implements Parser {
  readonly id = "ofx-generico";
  readonly version = "1";
  readonly institution = "Qualquer (OFX)";
  readonly product = "Conta ou cartão";
  readonly doc_type = DocType.BANK_STATEMENT;
  readonly doc_format = DocFormat.OFX;
  readonly validated_with_real_documents = false;
  readonly limitations = "FITID usado como identificador, sem supor unicidade entre arquivos.";

  detect(source: Source): number {
    return source.ofx !== null ? 0.9 : 0.0;
  }

  parse(source: Source): ParseResult {
    const ofx = source.ofx;
    if (ofx === null) throw new Error("AssertionError");
    const card = ofx.kind === "card";
    const balance = ofx.ledger_balance ? dotDecimal(ofx.ledger_balance) : null;
    const result: ParseResult = {
      header: StatementHeaderSchema.parse({
        institution: ofx.bank_id ? `banco ${ofx.bank_id}` : null,
        account_hint: ofx.account_id,
        period_start: ofxDate(ofx.start),
        period_end: ofxDate(ofx.end),
        closing_balance: card && balance !== null ? balance.negate() : balance,
      }),
      items: [],
      warnings: [],
      unmapped: [],
    };
    if (ofx.currency && ofx.currency.toUpperCase() !== "BRL") {
      result.warnings.push(`Moeda ${ofx.currency} exige câmbio informado.`);
    }
    for (const trn of ofx.transactions) {
      const value = dotDecimal(trn.fields.get("TRNAMT") ?? "");
      const description = trn.fields.get("MEMO") || trn.fields.get("NAME") || "(sem descrição)";
      const text = pyHead([...trn.fields].map(([k, v]) => `${k}=${v}`).join(" | "), 2000);
      const item = parsedItem({
        kind: ItemKind.CREDIT,
        occurred_on: ofxDate(trn.fields.get("DTPOSTED")),
        description,
        amount: value !== null ? value.abs() : null,
        lines: [line(0, text, null, trn.line)],
        bank_id: trn.fields.get("FITID") ?? null,
      });
      if (value === null) item.warnings.push("Valor ausente ou inválido.");
      else if (card) {
        // On card statements, negative amounts are charges and positive ones credits/payments.
        const upper = description.toUpperCase();
        if (value.isNegative()) item.kind = CARD_CHARGE.search(upper) ? ItemKind.CARD_CHARGE : ItemKind.PURCHASE;
        else item.kind = CARD_PAYMENT.search(upper) ? ItemKind.CARD_PAYMENT : ItemKind.CARD_CREDIT;
      } else item.kind = value.isPositive() ? ItemKind.CREDIT : ItemKind.DEBIT;
      if (item.occurred_on === null) item.warnings.push("Data ausente ou inválida.");
      result.items.push(item);
    }
    return result;
  }
}

/** Python's `list.index`: a missing name is a ValueError, which the pipeline turns into ParseFailed. */
function indexOf(header: readonly string[], name: string): number {
  const i = header.indexOf(name);
  if (i < 0) throw new Error(`ValueError: ${name} is not in list`);
  return i;
}

/** Python's `cells[i]`: past the end is an IndexError, a negative index counts from the end. */
class CellMissing extends Error {}
function cell(cells: readonly string[], index: number): string {
  const value = index < 0 ? cells[cells.length + index] : cells[index];
  if (value === undefined) throw new CellMissing();
  return value;
}

abstract class NubankCsv implements Parser {
  abstract readonly id: string;
  abstract readonly version: string;
  abstract readonly product: string;
  abstract readonly doc_type: DocType;
  abstract readonly limitations: string;
  readonly institution = "Nubank";
  readonly doc_format = DocFormat.CSV;
  readonly validated_with_real_documents = false;
  protected abstract readonly headerNames: readonly string[];

  protected headerRow(source: Source): string[] | null {
    if (!source.rows.length) return null;
    return source.rows[0]![1].map((c) => casefold(c));
  }

  detect(source: Source): number {
    if (source.format !== DocFormat.CSV) return 0.0;
    const header = this.headerRow(source);
    if (header === null) return 0.0;
    return this.headerNames.every((h) => header.includes(h)) ? 0.9 : 0.0;
  }

  abstract parse(source: Source): ParseResult;
}

const ISO = new PyRe(String.raw`\d{4}-\d{2}-\d{2}`);

export class NubankCardCsv extends NubankCsv {
  readonly id = "nubank-cartao-csv";
  readonly version = "1";
  readonly product = "Cartão de crédito";
  readonly doc_type = DocType.CARD_STATEMENT;
  readonly limitations = "Colunas date,title,amount (category opcional); valores negativos são pagamentos/créditos.";
  protected readonly headerNames = ["date", "title", "amount"];

  parse(source: Source): ParseResult {
    const header = this.headerRow(source) ?? [];
    const index = { date: indexOf(header, "date"), title: indexOf(header, "title"), amount: indexOf(header, "amount") };
    const result: ParseResult = {
      header: StatementHeaderSchema.parse({ institution: this.institution }),
      items: [],
      warnings: [],
      unmapped: [],
    };
    for (const [number, cells] of source.rows.slice(1)) {
      const l = line(0, cells.join(","), null, number);
      let rawDate: string, title: string, rawAmount: string;
      try {
        [rawDate, title, rawAmount] = [cell(cells, index.date), cell(cells, index.title), cell(cells, index.amount)];
      } catch (error) {
        if (!(error instanceof CellMissing)) throw error;
        result.unmapped.push(l);
        continue;
      }
      const value = dotDecimal(rawAmount);
      // date.fromisoformat raises on an impossible date such as 2026-02-30: the parser fails
      // (ParseFailed in the pipeline), as on the desktop.
      let when: IsoDate | null = null;
      if (ISO.fullmatch(rawDate)) {
        try {
          when = parseDate(rawDate);
        } catch (error) {
          if (error instanceof DateError) throw new Error("ValueError: invalid isoformat date", { cause: error });
          throw error;
        }
      }
      if (value === null || value.isZero()) {
        result.unmapped.push(l);
        continue;
      }
      const [description, installment] = splitInstallment(title);
      const item = parsedItem({
        kind: classify(description, value.isNegative()),
        occurred_on: when,
        description,
        amount: value.abs(),
        lines: [l],
        installment,
      });
      if (when === null) item.warnings.push("Data inválida.");
      result.items.push(item);
    }
    return result;
  }
}

export class NubankAccountCsv extends NubankCsv {
  readonly id = "nubank-conta-csv";
  readonly version = "1";
  readonly product = "Conta";
  readonly doc_type = DocType.BANK_STATEMENT;
  readonly limitations = "Colunas Data,Valor,Identificador,Descrição; o identificador é usado contra duplicatas.";
  protected readonly headerNames = ["data", "valor", "identificador", "descrição"];

  parse(source: Source): ParseResult {
    const header = this.headerRow(source) ?? [];
    const index = new Map(this.headerNames.map((name) => [name, indexOf(header, name)] as const));
    const result: ParseResult = {
      header: StatementHeaderSchema.parse({ institution: this.institution }),
      items: [],
      warnings: [],
      unmapped: [],
    };
    for (const [number, cells] of source.rows.slice(1)) {
      const l = line(0, cells.join(","), null, number);
      let rawDate: string, value: Dec | null, identifier: string | null, description: string;
      try {
        rawDate = cell(cells, index.get("data")!);
        value = dotDecimal(cell(cells, index.get("valor")!));
        identifier = cell(cells, index.get("identificador")!) || null;
        description = cell(cells, index.get("descrição")!);
      } catch (error) {
        if (!(error instanceof CellMissing)) throw error;
        result.unmapped.push(l);
        continue;
      }
      if (value === null || value.isZero()) {
        result.unmapped.push(l);
        continue;
      }
      const when = dmy(rawDate);
      const item = parsedItem({
        kind: value.isPositive() ? ItemKind.CREDIT : ItemKind.DEBIT,
        occurred_on: when,
        description,
        amount: value.abs(),
        lines: [l],
        bank_id: identifier,
      });
      if (when === null) item.warnings.push("Data inválida.");
      result.items.push(item);
    }
    return result;
  }
}
