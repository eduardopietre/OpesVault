import { describe, expect, it } from "vitest";

import { Dec, type Rounding, withContext } from "../src/lib/dec.ts";
import { golden } from "./golden.ts";

type R = [string, string] | { error: string };
interface Arith {
  prec: number;
  a: string;
  b: string;
  parse: [string, string];
  add: R;
  sub: R;
  mul: R;
  div: R;
  divint: R;
  mod: R;
  neg: R;
  abs: R;
  cmp: number;
  rounding: Rounding;
  q: string;
  quantize: R;
  floor: R;
  normalize: R;
}
interface Trans {
  prec: number;
  x: string;
  y: string;
  n: number;
  ln: R;
  exp: R;
  pow_frac: R;
  pow_int: R;
}

const data = golden<{ arith: Arith[]; transcendental: Trans[] }>("dec");

function run(fn: () => Dec): R {
  try {
    const d = fn();
    return [d.toString(), d.toFixed()];
  } catch {
    return { error: "error" };
  }
}

function norm(r: R): R {
  return Array.isArray(r) ? r : { error: "error" };
}

describe("Dec matches Python decimal", () => {
  it("arithmetic, rounding and formatting", () => {
    const failures: string[] = [];
    for (const c of data.arith) {
      withContext({ prec: c.prec }, () => {
        const a = Dec.parse(c.a);
        const b = Dec.parse(c.b);
        const got: Record<string, R | number> = {
          parse: [a.toString(), a.toFixed()],
          add: run(() => a.add(b)),
          sub: run(() => a.sub(b)),
          mul: run(() => a.mul(b)),
          div: run(() => a.div(b)),
          divint: run(() => a.divInt(b)),
          mod: run(() => a.mod(b)),
          neg: run(() => a.negate()),
          abs: run(() => a.abs()),
          cmp: a.cmp(b),
          quantize: run(() => a.quantize(Dec.parse(c.q), c.rounding)),
          floor: run(() => a.toIntegral("ROUND_FLOOR")),
          normalize: run(() => a.normalize()),
        };
        for (const [key, value] of Object.entries(got)) {
          const expected = c[key as keyof Arith] as R | number;
          const want = typeof expected === "number" ? expected : norm(expected);
          if (JSON.stringify(value) !== JSON.stringify(want)) {
            failures.push(
              `prec=${c.prec} ${key}(${c.a}, ${c.b}${key === "quantize" ? `, ${c.q}, ${c.rounding}` : ""}): got ${JSON.stringify(value)}, want ${JSON.stringify(want)}`,
            );
          }
        }
      });
    }
    expect(failures.slice(0, 20)).toEqual([]);
  });

  it("ln, exp and powers", () => {
    const failures: string[] = [];
    for (const c of data.transcendental) {
      withContext({ prec: c.prec }, () => {
        const x = Dec.parse(c.x);
        const y = Dec.parse(c.y);
        const got: Record<string, R> = {
          ln: run(() => x.ln()),
          exp: run(() => y.exp_()),
          pow_frac: run(() => Dec.from(1).add(x.div(1000)).pow(Dec.from(1).div(12))),
          pow_int: run(() =>
            Dec.from(1)
              .add(x.div(10 ** 6))
              .pow(c.n),
          ),
        };
        for (const [key, value] of Object.entries(got)) {
          const want = norm(c[key as keyof Trans] as R);
          if (JSON.stringify(value) !== JSON.stringify(want)) {
            failures.push(
              `prec=${c.prec} ${key} x=${c.x} y=${c.y} n=${c.n}: got ${JSON.stringify(value)}, want ${JSON.stringify(want)}`,
            );
          }
        }
      });
    }
    expect(failures.slice(0, 20)).toEqual([]);
  });

  it("rejects floats and non-finite text", () => {
    expect(() => Dec.from(0.1)).toThrow();
    expect(() => Dec.parse("NaN")).toThrow();
    expect(() => Dec.parse("Infinity")).toThrow();
    expect(Dec.parse(" 1_000.50 ").toFixed()).toBe("1000.50");
  });
});
