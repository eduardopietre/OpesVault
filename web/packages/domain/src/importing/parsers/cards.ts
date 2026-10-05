/**
 * Credit card statement (fatura) parsers. Port of `importing/parsers/cards.py`.
 *
 * Layouts follow the public descriptions gathered in docs/12 §3 and are marked as not yet
 * validated with real documents. Each one records what it ignores.
 */
import type { IsoDate } from "../../lib/dates.ts";
import type { Dec } from "../../lib/dec.ts";
import { casefold } from "../../lib/text.ts";
import { ZERO } from "../../domain/money.ts";
import { DocFormat, DocType, ItemKind, type StatementHeader, StatementHeaderSchema } from "../model.ts";
import { type Line, type Source, textOf } from "../source.ts";
import {
  AMOUNT_RE,
  containsAll,
  dmy,
  MONTHS_PT,
  type ParsedItem,
  parsedItem,
  type Parser,
  type ParseResult,
  PyRe,
  pyInt,
  pySplit,
  pyStrip,
  resolveYear,
  safeDate,
  tryAmount,
} from "./base.ts";

const INSTALLMENT = new PyRe(String.raw`\s*(?:-\s*)?(?:Parcela\s+)?(\d{1,2})/(\d{1,2})\s*$`, "i");
const PAYMENT_WORDS = ["PAGAMENTO", "PAGTO", "PGTO"];
const CHARGE_WORDS = ["IOF", "JUROS", "MULTA", "ENCARGO", "TARIFA", "ANUIDADE"].map(
  (w) => new PyRe(String.raw`\b${w}\b`),
);

export function splitInstallment(description: string): [string, readonly [number, number] | null] {
  const match = INSTALLMENT.search(description);
  if (!match) return [pyStrip(description), null];
  const number = pyInt(match[1]!);
  const total = pyInt(match[2]!);
  if (!(1 <= number && number <= total && total <= 99)) return [pyStrip(description), null];
  return [pyStrip(description.slice(0, match.index), " -"), [number, total]];
}

export function classify(description: string, negative: boolean): ItemKind {
  const upper = description.toUpperCase();
  if (negative) return PAYMENT_WORDS.some((w) => upper.includes(w)) ? ItemKind.CARD_PAYMENT : ItemKind.CARD_CREDIT;
  if (CHARGE_WORDS.some((re) => re.search(upper))) return ItemKind.CARD_CHARGE;
  return ItemKind.PURCHASE;
}

/** Bill total = previous balance + charges − credits − payments. */
export function cardReconciliationTotal(items: readonly ParsedItem[], previous: Dec | null): Dec {
  let total = previous ?? ZERO;
  for (const item of items) {
    if (item.amount === null) continue;
    if (item.kind === ItemKind.PURCHASE || item.kind === ItemKind.CARD_CHARGE) total = total.add(item.amount);
    else if (item.kind === ItemKind.CARD_CREDIT || item.kind === ItemKind.CARD_PAYMENT) total = total.sub(item.amount);
  }
  return total;
}

function header(fields: Partial<Record<keyof StatementHeader, unknown>>): StatementHeader {
  return StatementHeaderSchema.parse(fields);
}

const NU_HEADER = new PyRe(String.raw`FATURA\s+(\d{1,2})\s+([A-Z]{3})\s+(\d{4})`, "i");
const NU_PERIOD = new PyRe(
  String.raw`TRANSA[ÇC][ÕO]ES\s+DE\s+(\d{1,2})\s+([A-Z]{3})\s+A\s+(\d{1,2})\s+([A-Z]{3})`,
  "i",
);
const NU_LINE = new PyRe(String.raw`^(\d{1,2})\s+([A-Z]{3})\s+(.+?)\s+(${AMOUNT_RE})$`, "i");
const NU_FOREIGN = new PyRe(String.raw`^(\d{1,2})\s+([A-Z]{3})\s+(.+?)\s+(USD|EUR|GBP)\s+([\d.,]+)$`, "i");
const BRL_ONLY = new PyRe(String.raw`R\$\s*[\d.,]+`);
const QUOTE_PREFIXES = ["COTAÇÃO", "CONVERSÃO", "COTACAO", "CONVERSAO"];

export class NubankCardPdf implements Parser {
  readonly id = "nubank-cartao-pdf";
  readonly version = "1";
  readonly institution = "Nubank";
  readonly product = "Cartão de crédito";
  readonly doc_type = DocType.CARD_STATEMENT;
  readonly doc_format = DocFormat.PDF;
  readonly validated_with_real_documents = false;
  readonly limitations =
    "Layout sintético; compras internacionais com cotação em linha separada; ano vem do cabeçalho.";

  detect(source: Source): number {
    if (source.format !== DocFormat.PDF) return 0.0;
    const text = textOf(source);
    let score = 0.0;
    if (containsAll(text, "Nu Pagamentos")) score += 0.6;
    if (NU_HEADER.search(text)) score += 0.2;
    if (NU_PERIOD.search(text)) score += 0.2;
    return Math.min(score, 1.0);
  }

  parse(source: Source): ParseResult {
    const text = textOf(source);
    const headerMatch = NU_HEADER.search(text);
    let due: IsoDate | null = null;
    if (headerMatch && MONTHS_PT.has(headerMatch[2]!.toUpperCase())) {
      due = safeDate(pyInt(headerMatch[3]!), MONTHS_PT.get(headerMatch[2]!.toUpperCase())!, pyInt(headerMatch[1]!));
    }
    const period = NU_PERIOD.search(text);
    let closing: IsoDate | null = null;
    if (period && due && MONTHS_PT.has(period[4]!.toUpperCase())) {
      closing = resolveYear(pyInt(period[3]!), MONTHS_PT.get(period[4]!.toUpperCase())!, due);
    }
    const reference = closing ?? due;
    const result: ParseResult = {
      header: header({ institution: this.institution, due_on: due, closing_on: closing }),
      items: [],
      warnings: [],
      unmapped: [],
    };
    if (reference === null) {
      result.warnings.push("Data da fatura não encontrada; datas das transações ficaram desconhecidas.");
    }
    let total: Dec | null = null;
    let previous: Dec | null = null;
    let inTransactions = false;
    let pendingForeign: ParsedItem | null = null;
    for (const line of source.lines) {
      const t = line.text;
      const low = casefold(t);
      if (low.startsWith("total a pagar")) {
        total = tryAmount(!t.includes("R$") ? pySplit(t).at(-1)! : t.slice(t.indexOf("R$")));
        continue;
      }
      if (low.startsWith("saldo anterior")) {
        previous = tryAmount(t.includes("R$") ? t.slice(t.indexOf("R$")) : pySplit(t).at(-1)!);
        continue;
      }
      if (NU_PERIOD.search(t)) {
        inTransactions = true;
        continue;
      }
      if (!inTransactions) continue;
      if (pendingForeign !== null && BRL_ONLY.fullmatch(t)) {
        pendingForeign.amount = tryAmount(t);
        if (pendingForeign.amount === null) pendingForeign.warnings.push("Valor em reais ilegível.");
        pendingForeign.lines.push(line);
        result.items.push(pendingForeign);
        pendingForeign = null;
        continue;
      }
      if (pendingForeign && QUOTE_PREFIXES.some((p) => t.toUpperCase().startsWith(p))) {
        pendingForeign.lines.push(line);
        continue;
      }
      const foreign = NU_FOREIGN.match(t);
      if (foreign) {
        const when = this.date(foreign[1]!, foreign[2]!, reference);
        pendingForeign = parsedItem({
          kind: ItemKind.PURCHASE,
          occurred_on: when,
          description: pyStrip(foreign[3]!),
          amount: null,
          lines: [line],
          foreign_currency: foreign[4]!.toUpperCase(),
          foreign_amount: tryAmount(foreign[5]!),
        });
        continue;
      }
      const match = NU_LINE.match(t);
      if (!match) {
        if (pyStrip(t)) result.unmapped.push(line);
        continue;
      }
      const value = tryAmount(match[4]!);
      if (value === null) {
        result.unmapped.push(line);
        continue;
      }
      const negative = value.isNegative();
      const [description, installment] = splitInstallment(match[3]!);
      if (value.isZero()) {
        result.unmapped.push(line); // "Saldo restante" style informative lines
        continue;
      }
      result.items.push(
        parsedItem({
          kind: classify(description, negative),
          occurred_on: this.date(match[1]!, match[2]!, reference),
          description,
          amount: value.abs(),
          lines: [line],
          installment,
        }),
      );
    }
    if (pendingForeign !== null) {
      pendingForeign.warnings.push("Valor em reais da compra internacional não encontrado.");
      result.items.push(pendingForeign);
    }
    result.header = { ...result.header, total, previous_balance: previous };
    return result;
  }

  private date(day: string, month: string, reference: IsoDate | null): IsoDate | null {
    const number = MONTHS_PT.get(month.toUpperCase());
    if (number === undefined || reference === null) return null;
    return resolveYear(pyInt(day), number, reference);
  }
}

const DATE_LABELS: readonly ["vencimento" | "fechamento", "due" | "closing"][] = [
  ["vencimento", "due"],
  ["fechamento", "closing"],
];
const LABEL_RES = new Map(
  DATE_LABELS.map(([label]) => [label, new PyRe(String.raw`${label}\D{0,20}(\d{2}/\d{2}/\d{4})`, "i")]),
);
const TOTAL_RE = new PyRe(String.raw`total\s+(?:desta|da)\s+fatura\D{0,10}(${AMOUNT_RE})`, "i");
const PREVIOUS_RE = new PyRe(String.raw`(?:saldo|fatura)\s+anterior\D{0,10}(${AMOUNT_RE})`, "i");
const SLASH_LINE = new PyRe(String.raw`^(\d{2})/(\d{2})\s+(.+?)\s+(${AMOUNT_RE})$`);
const CARD_HEADER = new PyRe(String.raw`final\s+(\d{4})`, "i");

/** Shared logic for layouts with 'DD/MM DESCRIPTION VALUE' lines. */
abstract class SlashCardParser implements Parser {
  abstract readonly id: string;
  abstract readonly version: string;
  abstract readonly institution: string;
  abstract readonly product: string;
  abstract readonly limitations: string;
  readonly doc_type = DocType.CARD_STATEMENT;
  readonly doc_format = DocFormat.PDF;
  readonly validated_with_real_documents: boolean = false;
  protected readonly stopSections: readonly string[] = [];
  protected readonly skipPrefixes: readonly string[] = [];

  abstract detect(source: Source): number;

  private header(text: string): [IsoDate | null, IsoDate | null, Dec | null, Dec | null] {
    let due: IsoDate | null = null;
    let closing: IsoDate | null = null;
    let total: Dec | null = null;
    let previous: Dec | null = null;
    for (const [label, target] of DATE_LABELS) {
      const match = LABEL_RES.get(label)!.search(text);
      if (match) {
        if (target === "due") due = dmy(match[1]!);
        else closing = dmy(match[1]!);
      }
    }
    let match = TOTAL_RE.search(text);
    if (match) total = tryAmount(match[1]!);
    match = PREVIOUS_RE.search(text);
    if (match) previous = tryAmount(match[1]!);
    return [due, closing, total, previous];
  }

  parse(source: Source): ParseResult {
    const [due, closing, total, previous] = this.header(textOf(source));
    const reference = closing ?? due;
    const result: ParseResult = {
      header: header({
        institution: this.institution,
        due_on: due,
        closing_on: closing,
        total,
        previous_balance: previous,
      }),
      items: [],
      warnings: [],
      unmapped: [],
    };
    if (reference === null) {
      result.warnings.push("Data de fechamento/vencimento não encontrada; datas ficaram desconhecidas.");
    }
    let cardLast4: string | null = null;
    let stopped = false;
    for (const line of source.lines) {
      const t = line.text;
      const low = casefold(t);
      if (this.stopSections.some((s) => low.startsWith(s))) {
        stopped = true; // e.g. "próximas faturas" repeats future installments
        continue;
      }
      const card = CARD_HEADER.search(t);
      if (card && !SLASH_LINE.match(t)) {
        cardLast4 = card[1]!;
        stopped = false;
        continue;
      }
      if (stopped || this.skipPrefixes.some((p) => low.startsWith(p))) continue;
      const extra = this.extraItem(line, reference);
      if (extra !== null) {
        result.items.push(extra);
        continue;
      }
      const match = SLASH_LINE.match(t);
      if (!match) continue;
      const value = tryAmount(match[4]!);
      if (value === null) continue; // reported below as an unmapped line
      const [description, installment] = splitInstallment(match[3]!);
      const occurred = reference ? resolveYear(pyInt(match[1]!), pyInt(match[2]!), reference) : null;
      result.items.push(
        parsedItem({
          kind: classify(description, value.isNegative()),
          occurred_on: occurred,
          description,
          amount: value.abs(),
          lines: [line],
          installment,
          card_last4: cardLast4,
        }),
      );
    }
    const mapped = new Set<Line>(result.items.flatMap((item) => item.lines));
    result.unmapped = source.lines.filter((l) => !mapped.has(l) && SLASH_LINE.match(l.text));
    return result;
  }

  protected extraItem(_line: Line, _reference: IsoDate | null): ParsedItem | null {
    return null;
  }
}

const ITAU_UNIBANCO = new PyRe(String.raw`ita[uú]\s*unibanco`, "i");
const TOTAL_DESTA = new PyRe(String.raw`total\s+desta\s+fatura`, "i");
const VENCIMENTO = new PyRe("vencimento", "i");
const IOF_RE = new PyRe(String.raw`repasse\s+de\s+iof\D{0,10}(${AMOUNT_RE})`, "i");

export class ItauCardPdf extends SlashCardParser {
  readonly id = "itau-cartao-pdf";
  readonly version = "1";
  readonly institution = "Itaú";
  readonly product = "Cartão de crédito";
  readonly limitations = "Layout sintético; a seção de próximas faturas é ignorada; IOF lido do resumo.";
  protected override readonly stopSections = [
    "compras parceladas - próximas faturas",
    "próximas faturas",
    "proximas faturas",
  ];
  protected override readonly skipPrefixes = ["total", "limite"];

  detect(source: Source): number {
    if (source.format !== DocFormat.PDF) return 0.0;
    const text = textOf(source);
    let score = 0.0;
    if (ITAU_UNIBANCO.search(text)) score += 0.6;
    if (TOTAL_DESTA.search(text)) score += 0.3;
    if (VENCIMENTO.search(text)) score += 0.1;
    return Math.min(score, 1.0);
  }

  protected override extraItem(line: Line, reference: IsoDate | null): ParsedItem | null {
    const match = IOF_RE.search(line.text);
    const value = match ? tryAmount(match[1]!) : null;
    if (value === null) return null;
    return parsedItem({
      kind: ItemKind.CARD_CHARGE,
      occurred_on: reference,
      description: "Repasse de IOF",
      amount: value.abs(),
      lines: [line],
      warnings: ["IOF informado só no resumo; data assumida = fechamento da fatura."],
    });
  }
}

const BRADESCO = new PyRe(String.raw`bradesco\s+cart[õo]es|banco\s+bradesco`, "i");
const TOTAL_DA = new PyRe(String.raw`total\s+da\s+fatura`, "i");

export class BradescoCardPdf extends SlashCardParser {
  readonly id = "bradesco-cartao-pdf";
  readonly version = "1";
  readonly institution = "Bradesco";
  readonly product = "Cartão de crédito";
  readonly limitations = "Layout sintético; subtotais por portador ignorados; pagamentos com sufixo '-'.";
  protected override readonly skipPrefixes = ["total para", "subtotal", "total da fatura"];

  detect(source: Source): number {
    if (source.format !== DocFormat.PDF) return 0.0;
    const text = textOf(source);
    let score = 0.0;
    if (BRADESCO.search(text)) score += 0.7;
    if (TOTAL_DA.search(text)) score += 0.3;
    return Math.min(score, 1.0);
  }
}
