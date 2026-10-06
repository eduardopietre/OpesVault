import { describe, expect, it } from "vitest";

import { CENT, allocate, formatBrl, formatDecimalBr, isCents, parseBrl, roundMoney } from "../src/domain/money.ts";
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

/** TA-32 (docs/08): cents, fractional prices and splits add up exactly, and the rounding policy is the stated one. */
describe("exact cents and the rounding policy (TA-32)", () => {
  it("rounds half away from zero, not half to even (the Decimal default)", () => {
    const cases: [string, string][] = [
      ["0.125", "0.13"],
      ["0.135", "0.14"],
      ["2.675", "2.68"],
      ["-0.125", "-0.13"],
      ["-2.675", "-2.68"],
      ["0.004", "0.00"],
      ["0.005", "0.01"],
    ];
    for (const [input, rounded] of cases) expect(roundMoney(Dec.parse(input)).toFixed(), input).toBe(rounded);
    // Half to even would give 0.12 for 0.125: the policy is explicit, never the library's default.
    expect(Dec.parse("0.125").quantize(CENT, "ROUND_HALF_EVEN").toFixed()).toBe("0.12");
  });

  it("splits any amount into parts that add up to it to the cent", () => {
    for (const total of ["100.01", "0.01", "99.99", "1000.00", "7.00", "0.02"]) {
      for (const weights of [
        ["1", "1"],
        ["1", "1", "1"],
        ["2", "3", "5"],
        ["1", "1", "1", "1", "1", "1", "1"],
      ]) {
        const parts = allocate(
          Dec.parse(total),
          weights.map((w) => Dec.parse(w)),
        );
        const sum = parts.reduce((acc, part) => acc.add(part), Dec.parse("0"));
        expect(sum.toFixed(), `${total} by ${weights.join(":")}`).toBe(Dec.parse(total).toFixed());
        for (const part of parts) expect(isCents(part), `${part.toFixed()} is whole cents`).toBe(true);
      }
    }
  });

  it("keeps fractional prices exact until a cent is needed (no binary floats)", () => {
    // 0.1 + 0.2 is 0.30000000000000004 in binary floating point; here it is exactly 0.3.
    expect(Dec.parse("0.1").add(Dec.parse("0.2")).toFixed()).toBe("0.3");
    // 3 shares at 33.3333: 99.9999 exactly, 100.00 only when rounded for the ledger.
    const total = Dec.parse("33.3333").mul(Dec.parse("3"));
    expect(total.toFixed()).toBe("99.9999");
    expect(roundMoney(total).toFixed()).toBe("100.00");
  });
});
