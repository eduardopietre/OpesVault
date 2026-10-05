/**
 * Parser catalog (docs/05 §1): support is declared per layout, never per bank name.
 * Port of `importing/parsers/__init__.py`.
 */
import { ItauBankPdf } from "./bank.ts";
import type { Parser } from "./base.ts";
import { SinacorNotePdf } from "./brokerage.ts";
import { BradescoCardPdf, ItauCardPdf, NubankCardPdf } from "./cards.ts";
import { NubankAccountCsv, NubankCardCsv, OfxParser } from "./structured.ts";

export const PARSERS: readonly Parser[] = [
  new NubankCardPdf(),
  new ItauCardPdf(),
  new BradescoCardPdf(),
  new ItauBankPdf(),
  new SinacorNotePdf(),
  new OfxParser(),
  new NubankCardCsv(),
  new NubankAccountCsv(),
];

export const DETECTION_THRESHOLD = 0.6;
export const AMBIGUITY_MARGIN = 0.15;

/** Python raises KeyError for an unknown layout id. */
export class UnknownParser extends Error {
  constructor(parserId: string) {
    super(parserId);
    this.name = "KeyError";
  }
}

export function parserById(parserId: string): Parser {
  const found = PARSERS.find((p) => p.id === parserId);
  if (found === undefined) throw new UnknownParser(parserId);
  return found;
}
