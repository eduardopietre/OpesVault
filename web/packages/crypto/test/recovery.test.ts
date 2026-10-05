import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  CryptoError,
  formatRecoveryKey,
  generateRecoveryKey,
  parseRecoveryKey,
  RECOVERY_KEY_BYTES,
  toHex,
} from "../src/index.ts";
import { counterRandom } from "./helpers.ts";

describe("recovery key", () => {
  it("is 160 bits in nine groups of four Crockford characters", () => {
    const { text } = generateRecoveryKey();
    expect(text).toMatch(/^([0-9A-HJKMNP-TV-Z]{4}-){8}[0-9A-HJKMNP-TV-Z]{4}$/);
    expect(RECOVERY_KEY_BYTES * 8).toBeGreaterThanOrEqual(160);
  });

  it("has a known rendering for known bytes", () => {
    const { text } = generateRecoveryKey(counterRandom(0));
    expect(text).toMatchInlineSnapshot(`"000G-40R4-0M30-E209-185G-R38E-1W81-24GK-J339"`);
  });

  it("round-trips any key", () => {
    fc.assert(
      fc.property(fc.uint8Array({ minLength: 20, maxLength: 20 }), (bytes) => {
        expect(toHex(parseRecoveryKey(formatRecoveryKey(bytes)))).toBe(toHex(bytes));
      }),
    );
  });

  it("reads lower case, spaces, missing dashes and O/0, I/L/1 confusions", () => {
    const { bytes, text } = generateRecoveryKey();
    const variants = [
      text.toLowerCase(),
      text.replace(/-/g, ""),
      text.replace(/-/g, " "),
      `  ${text}  `,
      text.replace(/0/g, "O"),
      text.replace(/1/g, "I"),
      text.replace(/1/g, "l"),
    ];
    for (const variant of variants) expect(toHex(parseRecoveryKey(variant))).toBe(toHex(bytes));
  });

  it("rejects typos through the check group", () => {
    const { text } = generateRecoveryKey(counterRandom(7));
    const first = text[0] === "2" ? "3" : "2";
    const typo = first + text.slice(1);
    expect(() => parseRecoveryKey(typo)).toThrow(new CryptoError("invalid_recovery_key"));
    expect(() => parseRecoveryKey(text.slice(0, -1))).toThrow(new CryptoError("invalid_recovery_key"));
    expect(() => parseRecoveryKey(text.replace(/^./, "U"))).toThrow(new CryptoError("invalid_recovery_key"));
    expect(() => parseRecoveryKey("")).toThrow(new CryptoError("invalid_recovery_key"));
  });
});
