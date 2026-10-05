/** Bank account statement (extrato) parsers. Port of `importing/parsers/bank.py`. */
import type { Dec } from "../../lib/dec.ts";
import { DocFormat, DocType, ItemKind, StatementHeaderSchema } from "../model.ts";
import { type Source, textOf } from "../source.ts";
import { AMOUNT_RE, dmy, group, type Parser, type ParseResult, parsedItem, PyRe, pyStrip, tryAmount } from "./base.ts";

const LINE = new PyRe(String.raw`^(\d{2}/\d{2}/\d{4})\s+(.+?)\s+(${AMOUNT_RE})(?:\s+(${AMOUNT_RE}))?$`);
const PERIOD = new PyRe(String.raw`per[íi]odo\D{0,10}(\d{2}/\d{2}/\d{4})\s+a\s+(\d{2}/\d{2}/\d{4})`, "i");
const ACCOUNT = new PyRe(String.raw`ag[êe]ncia\D{0,5}(\d{4})\D{0,20}conta\D{0,5}([\d.-]+)`, "i");
const ITAU = new PyRe("ita[uú]", "i");
const EXTRATO = new PyRe(String.raw`\bextrato\b`, "i");
const SALDO_ANTERIOR = new PyRe(String.raw`saldo\s+anterior`, "i");
const SALDO_LINE = new PyRe(String.raw`saldo\s+anterior\D{0,10}(${AMOUNT_RE})`, "i");

export class ItauBankPdf implements Parser {
  readonly id = "itau-extrato-pdf";
  readonly version = "1";
  readonly institution = "Itaú";
  readonly product = "Conta corrente";
  readonly doc_type = DocType.BANK_STATEMENT;
  readonly doc_format = DocFormat.PDF;
  readonly validated_with_real_documents = false;
  readonly limitations = "Layout sintético; linhas 'SALDO DO DIA' são informativas; saldo final usado na conciliação.";

  detect(source: Source): number {
    if (source.format !== DocFormat.PDF) return 0.0;
    const text = textOf(source);
    let score = 0.0;
    if (ITAU.search(text)) score += 0.3;
    if (EXTRATO.search(text)) score += 0.3;
    if (PERIOD.search(text)) score += 0.2;
    if (SALDO_ANTERIOR.search(text)) score += 0.2;
    return Math.min(score, 1.0);
  }

  parse(source: Source): ParseResult {
    const text = textOf(source);
    const period = PERIOD.search(text);
    const account = ACCOUNT.search(text);
    const result: ParseResult = {
      header: StatementHeaderSchema.parse({
        institution: this.institution,
        period_start: period ? dmy(period[1]!) : null,
        period_end: period ? dmy(period[2]!) : null,
        account_hint: account ? `ag ${account[1]} cc ${account[2]}` : null,
      }),
      items: [],
      warnings: [],
      unmapped: [],
    };
    let opening: Dec | null = null;
    let closing: Dec | null = null;
    for (const line of source.lines) {
      const match = LINE.match(line.text);
      if (!match) {
        const saldo = SALDO_LINE.search(line.text);
        if (saldo) opening = tryAmount(saldo[1]!);
        continue;
      }
      const description = pyStrip(match[2]!);
      const upper = description.toUpperCase();
      const value = tryAmount(match[3]!);
      if (value === null) {
        result.unmapped.push(line);
        continue;
      }
      if (upper.includes("SALDO ANTERIOR")) {
        opening = value;
        continue;
      }
      if (upper.startsWith("SALDO")) {
        closing = value; // SALDO DO DIA / SALDO FINAL: informative, last one wins
        continue;
      }
      const when = dmy(match[1]!);
      const item = parsedItem({
        kind: value.isPositive() ? ItemKind.CREDIT : ItemKind.DEBIT,
        occurred_on: when,
        description,
        amount: value.abs(),
        lines: [line],
      });
      if (when === null) item.warnings.push("Data impossível no documento.");
      const after = group(match, 4);
      if (after) closing = tryAmount(after);
      result.items.push(item);
    }
    result.header = { ...result.header, opening_balance: opening, closing_balance: closing };
    return result;
  }
}
