/**
 * Brokerage notes (notas de negociação) in the B3/SINACOR layout and the NuInvest variant.
 * Port of `importing/parsers/brokerage.py`.
 *
 * Layout knowledge comes from anonymized public notes (docs/12 §3-4). The summary is printed in
 * two columns, so fee labels are searched anywhere in a line.
 */
import { Dec } from "../../lib/dec.ts";
import { casefold } from "../../lib/text.ts";
import { ZERO } from "../../domain/money.ts";
import { DocFormat, DocType, ItemKind, type StatementHeader, StatementHeaderSchema } from "../model.ts";
import { type Line, type Source, textOf } from "../source.ts";
import {
  amount,
  dmy,
  group,
  type ParsedItem,
  parsedItem,
  type Parser,
  type ParseResult,
  PyRe,
  pyStrip,
} from "./base.ts";

const NUM = String.raw`-?\d{1,3}(?:\.\d{3})*,\d+`;
const TRADE = new PyRe(
  String.raw`^(?:1-)?BOVESPA\s+(?P<side>[CV])\s+` +
    String.raw`(?P<market>VISTA|FRACIONARIO|TERMO|OPCAO DE COMPRA|OPCAO DE VENDA|EXERC OPC COMPRA|EXERC OPC VENDA|VIS)\s+` +
    String.raw`(?P<spec>.+?)\s+(?P<qty>\d{1,3}(?:\.\d{3})*)\s+(?P<price>${NUM})\s+(?P<value>${NUM})\s+(?P<dc>[DC])$`,
  "i",
);
// (label pattern, key). Values may carry a D/C marker or a leading minus (NuInvest).
const FEES: readonly (readonly [string, string])[] = [
  [String.raw`taxa\s+de\s+liquida[çc][ãa]o`, "Taxa de liquidação"],
  [String.raw`taxa\s+de\s+registro`, "Taxa de registro"],
  [String.raw`taxa\s+de\s+termo\s*/\s*op[çc][õo]es`, "Taxa de termo/opções"],
  [String.raw`taxa\s+a\.n\.a\.`, "Taxa A.N.A."],
  [String.raw`emolumentos`, "Emolumentos"],
  [String.raw`taxa\s+operacional|corretagem(?!/)`, "Corretagem"],
  [String.raw`execu[çc][ãa]o(?!\s+casa)`, "Execução"],
  [String.raw`taxa\s+de\s+cust[óo]dia`, "Custódia"],
  [String.raw`impostos|\biss\b(?:\s*\([^)]*\))?`, "Impostos (ISS)"],
  [String.raw`outr[ao]s`, "Outros"],
];
const FEE_RES = FEES.map(
  ([pattern, label]) => [new PyRe(String.raw`(?:${pattern})\s+(${NUM})(?:\s+([DC])\b)?`, "i"), label] as const,
);
const SPEC_TICKER = new PyRe(String.raw`\b([A-Z]{4}\d{1,2})\b`);
const SPEC_TAIL = new PyRe(String.raw`\s+#\S*$|\s+#$`);
const NOTE_KIND = new PyRe(String.raw`nota\s+de\s+(negocia[çc][ãa]o|corretagem)|nuinvest`, "i");
const SUMMARY = new PyRe(String.raw`resumo\s+financeiro`, "i");
const NET_LABEL = new PyRe(String.raw`l[íi]quido\s+para`, "i");
// "4535159 1 02/05/2022" (number, sheet, date) or "... 8242 24/01/2025" (NuInvest).
const NUMBER_RE = new PyRe(String.raw`(\d{3,})\s+(?:\d{1,3}\s+)?\d{2}/\d{2}/\d{4}\s*$`, "m");
const DATE_RE = new PyRe(String.raw`data\s+preg[ãa]o.*?(\d{2}/\d{2}/\d{4})`, "is");
const NET_RE = new PyRe(String.raw`l[íi]quido\s+para\s+(\d{2}/\d{2}/\d{4})\s+(${NUM})\s*([DC])?`, "i");
const IRRF_RE = new PyRe(String.raw`I\.?R\.?R\.?F\.?\s+s/\s*opera[çc][õo]es.*?(${NUM})\s*([DC])?\s*$`, "i");
const BROKERS = ["CLEAR", "RICO", "XP INVESTIMENTOS", "NUINVEST", "BTG", "MODAL"];

/** D = debit to the client (negative), C = credit; a leading minus also means debit. */
function signed(value: string, marker: string | null): Dec {
  const number = amount(value);
  if (marker === "D") return number.abs().negate();
  if (marker === "C") return number.abs();
  return number;
}

export class SinacorNotePdf implements Parser {
  readonly id = "sinacor-nota-pdf";
  readonly version = "1";
  readonly institution = "Corretoras padrão SINACOR (Clear, Rico, XP) e NuInvest";
  readonly product = "Nota de negociação (B3)";
  readonly doc_type = DocType.BROKERAGE_NOTE;
  readonly doc_format = DocFormat.PDF;
  readonly validated_with_real_documents = true; // anonymized public notes, see docs/12 §4
  readonly limitations = "Mercado à vista, fracionário e opções; futuros (BM&F) não suportados.";

  detect(source: Source): number {
    if (source.format !== DocFormat.PDF) return 0.0;
    const text = textOf(source);
    let score = 0.0;
    if (NOTE_KIND.search(text)) score += 0.4;
    if (SUMMARY.search(text)) score += 0.2;
    if (NET_LABEL.search(text)) score += 0.2;
    if (source.lines.some((l) => TRADE.match(l.text))) score += 0.2;
    return Math.min(score, 1.0);
  }

  parse(source: Source): ParseResult {
    const text = textOf(source);
    const headerValues: Partial<{ -readonly [K in keyof StatementHeader]: StatementHeader[K] }> = {};
    const numberMatch = NUMBER_RE.search(text);
    const dateMatch = DATE_RE.search(text);
    const netMatch = NET_RE.search(text);
    const folded = casefold(text);
    const broker = BROKERS.find((n) => folded.includes(casefold(n))) ?? null;
    const tradeDate = dateMatch ? dmy(dateMatch[1]!) : null;
    if (numberMatch) headerValues.note_number = numberMatch[1]!;
    const result: ParseResult = {
      header: StatementHeaderSchema.parse({ institution: broker, trade_date: tradeDate }),
      items: [],
      warnings: [],
      unmapped: [],
    };
    if (netMatch) {
      headerValues.settlement_date = dmy(netMatch[1]!);
      headerValues.net_amount = signed(netMatch[2]!, group(netMatch, 3));
    }
    let tradesNet = ZERO;
    let irrf: Dec | null = null;
    const fees = new Map<string, readonly [Dec, Line]>();
    for (const line of source.lines) {
      const trade = TRADE.match(line.text);
      if (trade) {
        const g = trade.groups!;
        const value = signed(g["value"]!, g["dc"]!);
        tradesNet = tradesNet.add(value);
        const spec = SPEC_TAIL.sub("", pyStrip(g["spec"]!));
        const ticker = SPEC_TICKER.search(spec);
        result.items.push(
          parsedItem({
            kind: ItemKind.TRADE,
            occurred_on: tradeDate,
            description: `${g["side"]!.toUpperCase() === "C" ? "Compra" : "Venda"} ${spec}`,
            amount: value.abs(),
            lines: [line],
            quantity: Dec.parse(g["qty"]!.replaceAll(".", "")),
            unit_price: amount(g["price"]!),
            ticker: ticker ? ticker[1]! : null,
          }),
        );
        continue;
      }
      const irrfMatch = IRRF_RE.search(line.text);
      if (irrfMatch) {
        irrf = amount(irrfMatch[1]!).abs();
        continue;
      }
      for (const [re, label] of FEE_RES) {
        if (fees.has(label)) continue;
        const fee = re.search(line.text);
        if (fee) {
          const raw = amount(fee[1]!);
          const marker = group(fee, 2);
          // Without a D/C marker a positive fee is a cost to the client.
          const value = marker || raw.isNegative() ? signed(fee[1]!, marker) : raw.negate();
          fees.set(label, [value, line]);
        }
      }
    }
    let feeTotal = ZERO;
    for (const [label, [value, line]] of fees) {
      if (value.isZero()) continue;
      feeTotal = feeTotal.add(value);
      result.items.push(
        parsedItem({
          kind: ItemKind.FEE,
          occurred_on: tradeDate,
          description: label,
          amount: value.abs(),
          lines: [line],
          credit: value.isPositive(),
        }),
      );
    }
    headerValues.previous_balance = null;
    result.header = { ...result.header, ...headerValues };
    const computed = tradesNet.add(feeTotal);
    const expected = headerValues.net_amount;
    if (expected instanceof Dec && !computed.eq(expected) && irrf !== null && computed.sub(irrf).eq(expected)) {
      result.warnings.push("O líquido da nota desconta o IRRF retido.");
      result.items.push(
        parsedItem({ kind: ItemKind.FEE, occurred_on: tradeDate, description: "IRRF retido", amount: irrf, lines: [] }),
      );
    } else if (irrf !== null && !irrf.isZero()) {
      result.warnings.push("IRRF informado na nota, mas não descontado do líquido (informativo).");
    }
    if (!result.items.length) result.warnings.push("Nenhum negócio reconhecido nesta nota.");
    return result;
  }
}

/** Client-side net of a parsed note: sells − buys − costs (+ credits). */
export function noteComputedNet(items: readonly ParsedItem[]): Dec {
  let total = ZERO;
  for (const item of items) {
    if (item.amount === null) continue;
    if (item.kind === ItemKind.TRADE)
      total = item.description.startsWith("Venda") ? total.add(item.amount) : total.sub(item.amount);
    else if (item.kind === ItemKind.FEE) total = item.credit ? total.add(item.amount) : total.sub(item.amount);
  }
  return total;
}
