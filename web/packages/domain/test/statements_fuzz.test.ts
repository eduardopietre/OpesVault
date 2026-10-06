/**
 * `tests/test_fuzz.py::test_informe_reader_survives_mutated_text` and
 * `tests/test_tax.py::test_parser_never_raises_on_garbage`: hostile informe text never raises,
 * amounts are never negative and the year is plausible. The mutated texts are the desktop's
 * (golden/statements.json, seeded mutations of the synthetic informe and of an employer's).
 */
import { describe, expect, it } from "vitest";

import * as statements from "../src/tax/statements.ts";
import { golden } from "./golden.ts";

describe("the informe reader survives hostile text", () => {
  it("on the desktop's mutated texts", () => {
    const cases = golden<{ parse: { lines: string[] }[] }>("statements").parse;
    expect(cases.length).toBeGreaterThan(100);
    for (const c of cases) {
      const parsed = statements.parse(c.lines);
      expect(parsed.lines.every((l) => !l.amount.isNegative())).toBe(true);
      expect(parsed.year === null || (parsed.year >= 1990 && parsed.year <= 2999)).toBe(true);
    }
  });

  it("on garbage", () => {
    const garbage = statements.parse([
      "",
      "R$ ,00",
      "Saldo em 31/12/abcd 1,00",
      "x".repeat(5000),
      "CNPJ 00.000.000/0000-00",
    ]);
    expect(garbage.payerTaxId).toBeNull();
    expect(garbage.lines.every((l) => !l.amount.isNegative())).toBe(true);
  });
});
