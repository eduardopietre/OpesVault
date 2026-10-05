import { describe, expect, it } from "vitest";

import { allocate, formatBrl, formatDecimalBr, parseBrl } from "../src/domain/money.ts";
import { Dec } from "../src/lib/dec.ts";
import { golden, outcome } from "./golden.ts";

interface Data {
  parse: ({ text: string } & ({ ok: unknown } | { error: string }))[];
  format: { value: string; brl: string; brl_sign: string; plain: string; places2: string; places4: string }[];
  allocate: ({ total: string; weights: string[] } & ({ ok: unknown } | { error: string }))[];
}

const data = golden<Data>("money");

function errorName(o: { ok: unknown } | { error: string }): unknown {
  return "error" in o ? { error: o.error === "MoneyError" ? "MoneyError" : o.error } : o;
}

describe("money matches domain/money.py", () => {
  it("parses Brazilian amounts", () => {
    for (const { text, ...expected } of data.parse) {
      expect(errorName(outcome(() => parseBrl(text))), text).toEqual(expected);
    }
  });

  it("formats", () => {
    for (const c of data.format) {
      const d = Dec.parse(c.value);
      expect(
        {
          brl: formatBrl(d),
          brl_sign: formatBrl(d, { sign: true }),
          plain: formatDecimalBr(d),
          places2: formatDecimalBr(d, 2),
          places4: formatDecimalBr(d, 4),
        },
        c.value,
      ).toEqual({ brl: c.brl, brl_sign: c.brl_sign, plain: c.plain, places2: c.places2, places4: c.places4 });
    }
  });

  it("allocates exactly", () => {
    for (const { total, weights, ...expected } of data.allocate) {
      expect(
        outcome(() =>
          allocate(
            Dec.parse(total),
            weights.map((w) => Dec.parse(w)),
          ),
        ),
        total,
      ).toEqual(expected);
    }
  });
});
