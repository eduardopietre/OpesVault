import fc from "fast-check";
import { describe, expect, test } from "vitest";

import { cmpKeys, cmpStr, sortedBy } from "../src/lib/text.ts";

/** Python's ordering spelled out: code point by code point. */
function byCodePoints(a: string, b: string): number {
  const x = [...a].map((c) => c.codePointAt(0)!);
  const y = [...b].map((c) => c.codePointAt(0)!);
  for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return x[i]! < y[i]! ? -1 : 1;
  return Math.sign(x.length - y.length);
}

// Units that matter: ASCII, BMP above the surrogates, both surrogate halves (paired or lone).
const unit = fc.constantFrom("a", "z", "￿", "", "\ud83d", "\ude00", "\udbff", "\udc00", "é");
const text = fc.array(unit, { maxLength: 8 }).map((units) => units.join(""));

describe("cmpStr", () => {
  test("orders by code point, surrogates included", () => {
    fc.assert(
      fc.property(text, text, (a, b) => {
        expect(cmpStr(a, b)).toBe(byCodePoints(a, b));
      }),
      { numRuns: 5000 },
    );
  });

  test("an astral character sorts after the private use area, unlike UTF-16 units", () => {
    expect(cmpStr("\u{1f600}", "￿")).toBe(1);
    expect(cmpStr("￿", "\u{1f600}")).toBe(-1);
    expect(cmpStr("a\ud83d", "a\u{1f600}")).toBe(-1);
  });
});

describe("sortedBy", () => {
  test("a scalar key sorts as a one-element tuple, stable and reversible", () => {
    fc.assert(
      fc.property(fc.array(fc.tuple(text, fc.integer({ min: 0, max: 3 }))), fc.boolean(), (items, reverse) => {
        const expected = items
          .map((item, index) => ({ item, index }))
          .sort((p, q) => {
            const c = cmpKeys([p.item[0]], [q.item[0]]);
            return c !== 0 ? (reverse ? -c : c) : p.index - q.index;
          })
          .map((d) => d.item);
        expect(sortedBy(items, (i) => i[0], reverse)).toEqual(expected);
      }),
      { numRuns: 500 },
    );
  });
});
