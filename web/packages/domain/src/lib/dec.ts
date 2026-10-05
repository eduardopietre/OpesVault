/**
 * Exact decimal numbers with the semantics of Python's `decimal` module (docs/02 §6).
 *
 * The desktop domain computed with `Decimal`; the web domain must give the same answers
 * digit for digit, including the scale ("1.50" stays "1.50"), the context precision
 * (28 significant digits, `localcontext` for more) and the rounding of every operation.
 * Arithmetic is done on BigInt coefficients; only the transcendental functions (ln, exp and
 * non-integer powers) are delegated to decimal.js, which returns correctly rounded results,
 * as CPython does.
 *
 * Floats are never accepted: values enter as strings, bigints or integer numbers.
 */
import DecimalJs from "decimal.js";

export type Rounding =
  "ROUND_HALF_UP" | "ROUND_HALF_EVEN" | "ROUND_HALF_DOWN" | "ROUND_UP" | "ROUND_DOWN" | "ROUND_CEILING" | "ROUND_FLOOR";

export interface DecContext {
  readonly prec: number;
  readonly rounding: Rounding;
}

export class DecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DecError";
  }
}

const DEFAULT_CONTEXT: DecContext = { prec: 28, rounding: "ROUND_HALF_EVEN" };
let current: DecContext = DEFAULT_CONTEXT;

/** Runs `fn` with another precision or rounding, like Python's `localcontext()`. */
export function withContext<T>(changes: Partial<DecContext>, fn: () => T): T {
  const saved = current;
  current = { ...current, ...changes };
  try {
    return fn();
  } finally {
    current = saved;
  }
}

export function getContext(): DecContext {
  return current;
}

const TEN = 10n;
const pow10Cache: bigint[] = [];
function pow10(n: number): bigint {
  if (n < 0) throw new DecError("negative power of ten");
  if (n < 64) {
    let cached = pow10Cache[n];
    if (cached === undefined) {
      cached = TEN ** BigInt(n);
      pow10Cache[n] = cached;
    }
    return cached;
  }
  return TEN ** BigInt(n);
}

function digits(n: bigint): number {
  return n === 0n ? 1 : n.toString().length;
}

/**
 * Whether dropping a remainder rounds the kept magnitude away from zero.
 * `rem` and `div` describe the dropped fraction rem/div (0 <= rem < div).
 */
function roundsAway(kept: bigint, rem: bigint, div: bigint, neg: boolean, rounding: Rounding): boolean {
  if (rem === 0n) return false;
  const twice = rem * 2n;
  switch (rounding) {
    case "ROUND_DOWN":
      return false;
    case "ROUND_UP":
      return true;
    case "ROUND_CEILING":
      return !neg;
    case "ROUND_FLOOR":
      return neg;
    case "ROUND_HALF_UP":
      return twice >= div;
    case "ROUND_HALF_DOWN":
      return twice > div;
    case "ROUND_HALF_EVEN":
      return twice > div || (twice === div && kept % 2n === 1n);
  }
}

const NUMBER_PATTERN = /^([+-])?(?:(\d+)(?:\.(\d*))?|\.(\d+))(?:[eE]([+-]?\d+))?$/;

export class Dec {
  /** Magnitude of the coefficient (never negative). */
  readonly coef: bigint;
  /** Power of ten of the last digit: 1.50 is coef 150, exp -2. */
  readonly exp: number;
  /** Sign, kept for zero too (Python has -0). */
  readonly neg: boolean;

  private constructor(neg: boolean, coef: bigint, exp: number) {
    this.neg = neg;
    this.coef = coef;
    this.exp = exp;
  }

  static fromParts(neg: boolean, coef: bigint, exp: number): Dec {
    if (coef < 0n) throw new DecError("coefficient must be non-negative");
    return new Dec(neg, coef, exp);
  }

  /** Like `Decimal(value)`: exact, no context rounding. Rejects floats and non-finite values. */
  static from(value: Dec | string | bigint | number): Dec {
    if (value instanceof Dec) return value;
    if (typeof value === "bigint") return new Dec(value < 0n, value < 0n ? -value : value, 0);
    if (typeof value === "number") {
      if (!Number.isSafeInteger(value)) throw new DecError("float is not accepted for financial values");
      return new Dec(value < 0 || Object.is(value, -0), BigInt(Math.abs(value)), 0);
    }
    return Dec.parse(value);
  }

  /** Parses Python `Decimal` syntax: "1.50", "-3", ".5", "1e-3", with surrounding spaces and "_" separators. */
  static parse(text: string): Dec {
    const cleaned = text.trim().replaceAll("_", "");
    const match = NUMBER_PATTERN.exec(cleaned);
    if (!match) throw new DecError("invalid decimal");
    const [, sign, intPart, fracPart, onlyFrac, expPart] = match;
    const whole = intPart ?? "";
    const frac = onlyFrac ?? fracPart ?? "";
    const exponent = (expPart === undefined ? 0 : Number.parseInt(expPart, 10)) - frac.length;
    if (!Number.isSafeInteger(exponent)) throw new DecError("exponent out of range");
    const coef = BigInt((whole + frac).replace(/^0+(?=\d)/, "") || "0");
    return new Dec(sign === "-", coef, exponent);
  }

  static isDec(value: unknown): value is Dec {
    return value instanceof Dec;
  }

  // ── context rounding ────────────────────────────────

  /** Rounds to the context precision (Python's `_fix`, without exponent limits). */
  private static fix(neg: boolean, coef: bigint, exp: number, ctx: DecContext = current): Dec {
    const len = digits(coef);
    if (len <= ctx.prec) return new Dec(neg, coef, exp);
    const drop = len - ctx.prec;
    const div = pow10(drop);
    let kept = coef / div;
    const rem = coef % div;
    let newExp = exp + drop;
    if (roundsAway(kept, rem, div, neg, ctx.rounding)) kept += 1n;
    if (digits(kept) > ctx.prec) {
      kept /= TEN;
      newExp += 1;
    }
    return new Dec(neg, kept, newExp);
  }

  /** `+x` in Python: applies the context. */
  plus(): Dec {
    // Python's __pos__: zero loses its sign unless the rounding is FLOOR.
    const neg = this.coef === 0n ? this.neg && current.rounding === "ROUND_FLOOR" : this.neg;
    return Dec.fix(neg, this.coef, this.exp);
  }

  // ── arithmetic ──────────────────────────────────────

  add(other: Dec | string | number | bigint): Dec {
    const b = Dec.from(other);
    const exp = Math.min(this.exp, b.exp);
    const x = this.signed() * pow10(this.exp - exp);
    const y = b.signed() * pow10(b.exp - exp);
    const sum = x + y;
    if (sum === 0n) {
      // Python: the sign of an exact zero sum is negative only if both are negative (or rounding is FLOOR).
      const neg = (this.neg && b.neg) || (this.neg !== b.neg && current.rounding === "ROUND_FLOOR");
      return Dec.fix(neg, 0n, exp);
    }
    return Dec.fix(sum < 0n, sum < 0n ? -sum : sum, exp);
  }

  sub(other: Dec | string | number | bigint): Dec {
    return this.add(Dec.from(other).negateRaw());
  }

  mul(other: Dec | string | number | bigint): Dec {
    const b = Dec.from(other);
    return Dec.fix(this.neg !== b.neg, this.coef * b.coef, this.exp + b.exp);
  }

  /** True division with the context precision (Python's `__truediv__`). */
  div(other: Dec | string | number | bigint): Dec {
    const b = Dec.from(other);
    if (b.coef === 0n) throw new DecError(this.coef === 0n ? "undefined division" : "division by zero");
    const neg = this.neg !== b.neg;
    const idealExp = this.exp - b.exp;
    if (this.coef === 0n) return Dec.fix(neg, 0n, idealExp);
    const prec = current.prec;
    const shift = digits(b.coef) - digits(this.coef) + prec + 1;
    let exp = this.exp - b.exp - shift;
    let coef: bigint;
    let rem: bigint;
    if (shift >= 0) {
      const n = this.coef * pow10(shift);
      coef = n / b.coef;
      rem = n % b.coef;
    } else {
      const d = b.coef * pow10(-shift);
      coef = this.coef / d;
      rem = this.coef % d;
    }
    if (rem !== 0n) {
      if (coef % 5n === 0n) coef += 1n; // sticky digit: the remainder is never lost in rounding
    } else {
      while (exp < idealExp && coef % TEN === 0n) {
        coef /= TEN;
        exp += 1;
      }
    }
    return Dec.fix(neg, coef, exp);
  }

  /** Integer division truncated toward zero (Python's `//`). */
  divInt(other: Dec | string | number | bigint): Dec {
    const b = Dec.from(other);
    if (b.coef === 0n) throw new DecError("division by zero");
    const exp = Math.min(this.exp, b.exp);
    const x = this.coef * pow10(this.exp - exp);
    const y = b.coef * pow10(b.exp - exp);
    const quotient = x / y;
    if (digits(quotient) > current.prec) throw new DecError("division impossible");
    return Dec.fix(this.neg !== b.neg, quotient, 0);
  }

  /** Remainder with the sign of the dividend (Python's `%` on Decimal). */
  mod(other: Dec | string | number | bigint): Dec {
    const b = Dec.from(other);
    if (b.coef === 0n) throw new DecError("division by zero");
    const exp = Math.min(this.exp, b.exp);
    const x = this.coef * pow10(this.exp - exp);
    const y = b.coef * pow10(b.exp - exp);
    if (digits(x / y) > current.prec) throw new DecError("division impossible");
    return Dec.fix(this.neg, x % y, exp);
  }

  neg_(): Dec {
    // Python's unary minus applies the context; the negation of zero is +0 (except under FLOOR).
    if (this.coef === 0n) return Dec.fix(current.rounding === "ROUND_FLOOR" ? !this.neg : false, 0n, this.exp);
    return Dec.fix(!this.neg, this.coef, this.exp);
  }

  /** Alias of `neg_()`, Python's `-x`. */
  negate(): Dec {
    return this.neg_();
  }

  abs(): Dec {
    return Dec.fix(false, this.coef, this.exp);
  }

  /** `x ** n`. Integer exponents are exact before one final rounding; others use correctly rounded ln/exp. */
  pow(exponent: Dec | string | number | bigint): Dec {
    const e = Dec.from(exponent);
    if (e.isInteger()) {
      const n = e.toBigInt();
      if (n === 0n) {
        if (this.coef === 0n) throw new DecError("0 ** 0");
        return new Dec(false, 1n, 0);
      }
      if (n > 0n) {
        if (n > 100000n) throw new DecError("exponent too large");
        const count = Number(n);
        return Dec.fix(this.neg && count % 2 === 1, this.coef ** n, this.exp * count);
      }
      return Dec.from(1).divExactThenFix(this, -n);
    }
    if (this.neg) throw new DecError("negative base with fractional exponent");
    return Dec.viaDecimalJs((D) => new D(this.toString()).pow(new D(e.toString())));
  }

  /** 1 / x**n computed exactly before one rounding (integer negative powers). */
  private divExactThenFix(base: Dec, n: bigint): Dec {
    const power = new Dec(base.neg && n % 2n === 1n, base.coef ** n, base.exp * Number(n));
    return withContext({ prec: current.prec + 10 }, () => this.div(power)).plusWith(current);
  }

  private plusWith(ctx: DecContext): Dec {
    return Dec.fix(this.neg, this.coef, this.exp, ctx);
  }

  ln(): Dec {
    if (this.neg || this.coef === 0n) throw new DecError("ln of a non-positive number");
    return Dec.viaDecimalJs((D) => new D(this.toString()).ln());
  }

  exp_(): Dec {
    return Dec.viaDecimalJs((D) => new D(this.toString()).exp());
  }

  sqrt(): Dec {
    if (this.neg && this.coef !== 0n) throw new DecError("sqrt of a negative number");
    return Dec.viaDecimalJs((D) => new D(this.toString()).sqrt());
  }

  /**
   * Correctly rounded ln/exp/pow through decimal.js. Python gives an inexact result all
   * `prec` digits (trailing zeros included) while decimal.js trims them, so a result with
   * fewer digits is padded unless a more precise computation shows it is exact.
   */
  private static viaDecimalJs(compute: (D: typeof DecimalJs) => DecimalJs): Dec {
    const prec = current.prec;
    const make = (p: number) =>
      DecimalJs.clone({ precision: p, rounding: DecimalJs.ROUND_HALF_EVEN, toExpNeg: -9e15, toExpPos: 9e15 });
    const result = compute(make(prec));
    if (!result.isFinite()) throw new DecError("non-finite result");
    let value = Dec.parse(result.toFixed()).plus();
    if (value.coef !== 0n && digits(value.coef) < prec) {
      const precise = compute(make(prec + 20));
      if (!precise.eq(result)) {
        const pad = prec - digits(value.coef);
        value = new Dec(value.neg, value.coef * pow10(pad), value.exp - pad);
      }
    }
    return value;
  }

  // ── rounding and scale ──────────────────────────────

  /** `x.quantize(Decimal(10) ** exponent, rounding)`; the rounding defaults to the context's. */
  quantize(quantum: Dec | string, rounding: Rounding = current.rounding): Dec {
    return this.rescale(Dec.from(quantum).exp, rounding);
  }

  /** Changes the exponent to `targetExp`, rounding as asked. */
  rescale(targetExp: number, rounding: Rounding = current.rounding): Dec {
    const result = this.rescaleUnchecked(targetExp, rounding);
    if (digits(result.coef) > current.prec) throw new DecError("quantize result has too many digits");
    return result;
  }

  private rescaleUnchecked(targetExp: number, rounding: Rounding): Dec {
    let result: Dec;
    if (targetExp <= this.exp) {
      result = new Dec(this.neg, this.coef * pow10(this.exp - targetExp), targetExp);
    } else {
      const div = pow10(targetExp - this.exp);
      let kept = this.coef / div;
      const rem = this.coef % div;
      if (roundsAway(kept, rem, div, this.neg, rounding)) kept += 1n;
      result = new Dec(this.neg, kept, targetExp);
    }
    return result;
  }

  /** `x.to_integral_value(rounding)`: integer value, exponent 0 unless already positive. */
  toIntegral(rounding: Rounding = current.rounding): Dec {
    if (this.exp >= 0) return this;
    return this.rescaleUnchecked(0, rounding);
  }

  /** Removes trailing zeros (Python's `normalize()` within the context). */
  normalize(): Dec {
    const fixed = Dec.fix(this.neg, this.coef, this.exp);
    if (fixed.coef === 0n) return new Dec(fixed.neg, 0n, 0);
    let coef = fixed.coef;
    let exp = fixed.exp;
    while (coef % TEN === 0n) {
      coef /= TEN;
      exp += 1;
    }
    return new Dec(fixed.neg, coef, exp);
  }

  /** `x.scaleb(n)`: multiplies by 10**n by moving the exponent. */
  scaleb(n: number): Dec {
    return Dec.fix(this.neg, this.coef, this.exp + n);
  }

  /** Python's `adjusted()`: exponent of the most significant digit. */
  adjusted(): number {
    return this.exp + digits(this.coef) - 1;
  }

  // ── comparison ──────────────────────────────────────

  private signed(): bigint {
    return this.neg ? -this.coef : this.coef;
  }

  private negateRaw(): Dec {
    return new Dec(!this.neg, this.coef, this.exp);
  }

  cmp(other: Dec | string | number | bigint): -1 | 0 | 1 {
    const b = Dec.from(other);
    const exp = Math.min(this.exp, b.exp);
    const x = this.signed() * pow10(this.exp - exp);
    const y = b.signed() * pow10(b.exp - exp);
    return x < y ? -1 : x > y ? 1 : 0;
  }

  eq(other: Dec | string | number | bigint): boolean {
    return this.cmp(other) === 0;
  }
  lt(other: Dec | string | number | bigint): boolean {
    return this.cmp(other) < 0;
  }
  lte(other: Dec | string | number | bigint): boolean {
    return this.cmp(other) <= 0;
  }
  gt(other: Dec | string | number | bigint): boolean {
    return this.cmp(other) > 0;
  }
  gte(other: Dec | string | number | bigint): boolean {
    return this.cmp(other) >= 0;
  }

  isZero(): boolean {
    return this.coef === 0n;
  }
  /** Strictly below zero (Python `x < 0`; -0 is not negative). */
  isNegative(): boolean {
    return this.neg && this.coef !== 0n;
  }
  isPositive(): boolean {
    return !this.neg && this.coef !== 0n;
  }
  /** -1, 0 or 1. */
  sign(): -1 | 0 | 1 {
    return this.coef === 0n ? 0 : this.neg ? -1 : 1;
  }
  isInteger(): boolean {
    if (this.exp >= 0) return true;
    return this.coef % pow10(-this.exp) === 0n;
  }

  static max(a: Dec, b: Dec): Dec {
    return a.lt(b) ? b : a;
  }
  static min(a: Dec, b: Dec): Dec {
    return b.lt(a) ? b : a;
  }

  /** Python's `sum(values, start)`. */
  static sum(values: Iterable<Dec>, start: Dec = DEC_ZERO): Dec {
    let total = start;
    for (const v of values) total = total.add(v);
    return total;
  }

  // ── conversion ──────────────────────────────────────

  /** Exact integer value, truncated toward zero (Python's `int(x)`). */
  toBigInt(): bigint {
    const value = this.exp >= 0 ? this.coef * pow10(this.exp) : this.coef / pow10(-this.exp);
    return this.neg ? -value : value;
  }

  /** `int(x)` as a number; throws when it does not fit exactly. */
  toInt(): number {
    const n = this.toBigInt();
    if (n > BigInt(Number.MAX_SAFE_INTEGER) || n < BigInt(Number.MIN_SAFE_INTEGER))
      throw new DecError("integer too large");
    return Number(n);
  }

  /** An approximation for drawing charts only; never feed it back into a calculation. */
  toNumberForDisplay(): number {
    return Number(this.toFixed());
  }

  /** `format(x, "f")`: fixed notation keeping the scale. This is the persisted form. */
  toFixed(): string {
    const sign = this.neg ? "-" : "";
    const body = this.coef.toString();
    if (this.exp >= 0) return sign + body + (this.coef === 0n && this.exp > 0 ? "" : "0".repeat(this.exp));
    const places = -this.exp;
    const padded = body.padStart(places + 1, "0");
    return `${sign}${padded.slice(0, padded.length - places)}.${padded.slice(padded.length - places)}`;
  }

  /** `str(x)`: Python's scientific form when the exponent is positive or the number is very small. */
  toString(): string {
    const sign = this.neg ? "-" : "";
    const body = this.coef.toString();
    const leftdigits = this.exp + body.length;
    let dotplace: number;
    if (this.exp <= 0 && leftdigits > -6) dotplace = leftdigits;
    else dotplace = 1;
    let intpart: string;
    let fracpart: string;
    if (dotplace <= 0) {
      intpart = "0";
      fracpart = "." + "0".repeat(-dotplace) + body;
    } else if (dotplace >= body.length) {
      intpart = body + "0".repeat(dotplace - body.length);
      fracpart = "";
    } else {
      intpart = body.slice(0, dotplace);
      fracpart = "." + body.slice(dotplace);
    }
    let expStr = "";
    if (leftdigits !== dotplace) {
      const e = leftdigits - dotplace;
      expStr = "E" + (e >= 0 ? "+" : "-") + Math.abs(e).toString();
    }
    return sign + intpart + fracpart + expStr;
  }

  /** Persisted as the fixed form, like the desktop's `format(d, "f")`. */
  toJSON(): string {
    return this.toFixed();
  }
}

export const DEC_ZERO = Dec.from(0);
export const ONE = Dec.from(1);

/** Shorthand for `Dec.from`. */
export function dec(value: Dec | string | number | bigint): Dec {
  return Dec.from(value);
}
