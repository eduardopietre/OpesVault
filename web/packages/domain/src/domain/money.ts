/**
 * Exact money handling (docs/02 §6, docs/06 §9). Port of `domain/money.py`.
 *
 * Floats are rejected everywhere: values enter as strings, integers or Dec. The default
 * management rounding is cents with ties away from zero (ROUND_HALF_UP).
 */
import { Dec, DecError, type Rounding } from "../lib/dec.ts";

export const CENT = Dec.from("0.01");
export const ZERO = Dec.from("0");
export const BRL = "BRL";

const BRL_PATTERN =
  /^\s*(?<lead>[-−+])?\s*(?:R\$)?\s*(?<lead2>[-−+])?\s*(?<int>\d{1,3}(?:\.\d{3})+|\d+)(?:,(?<frac>\d+))?\s*(?<trail>[-+DC])?\s*$/u;

export class MoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MoneyError";
  }
}

/** Converts to Dec without ever passing through float. */
export function toDecimal(value: unknown): Dec {
  if (value instanceof Dec) return value;
  if (typeof value === "boolean") throw new MoneyError("float or bool is not accepted for financial values");
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new MoneyError("float or bool is not accepted for financial values");
    return Dec.from(value);
  }
  if (typeof value === "bigint") return Dec.from(value);
  if (typeof value === "string") {
    try {
      return Dec.parse(value);
    } catch (error) {
      if (error instanceof DecError) throw new MoneyError("invalid decimal");
      throw error;
    }
  }
  throw new MoneyError(`unsupported type: ${typeof value}`);
}

export function roundMoney(value: Dec, quantum: Dec = CENT, rounding: Rounding = "ROUND_HALF_UP"): Dec {
  return value.quantize(quantum, rounding);
}

export function isCents(value: Dec): boolean {
  return value.eq(value.quantize(CENT));
}

/**
 * Parses Brazilian-formatted amounts: "1.234,56", "R$ -10,00", "40,00-", "-R$ 3,50" (also with
 * U+2212), "12,00 D". A trailing "D" means debit (negative) and "C" credit (positive).
 */
export function parseBrl(text: string): Dec {
  const match = BRL_PATTERN.exec(text.replaceAll(" ", " "));
  if (!match?.groups) throw new MoneyError("not a BRL amount");
  const { lead, lead2, int, frac, trail } = match.groups;
  const integer = (int ?? "").replaceAll(".", "");
  let value = Dec.parse(frac ? `${integer}.${frac}` : integer);
  const signs = [lead, lead2, trail].filter((s): s is string => Boolean(s));
  if (signs.length > 1) throw new MoneyError("conflicting signs");
  if (signs[0] === "-" || signs[0] === "−" || signs[0] === "D") value = value.negate();
  return value;
}

function groupThousands(integer: string): string {
  const groups: string[] = [];
  let rest = integer;
  while (rest.length > 3) {
    groups.unshift(rest.slice(-3));
    rest = rest.slice(0, -3);
  }
  groups.unshift(rest);
  return groups.join(".");
}

/** "R$ 1.234,56" with Brazilian separators; negatives as "-R$ 1.234,56". */
export function formatBrl(value: Dec, options: { sign?: boolean } = {}): string {
  const quantized = roundMoney(value);
  const negative = quantized.isNegative();
  const [integer = "0", frac = "00"] = quantized.abs().toFixed().split(".");
  const body = `R$ ${groupThousands(integer)},${frac}`;
  if (negative) return `-${body}`;
  return options.sign && quantized.isPositive() ? `+${body}` : body;
}

/** Plain Brazilian number formatting for quantities and rates. */
export function formatDecimalBr(value: Dec, places: number | null = null): string {
  let v = value;
  if (places !== null) v = v.rescale(-places, "ROUND_HALF_UP");
  const text = v.toFixed();
  const [rawInteger = "0", frac = ""] = text.split(".");
  const negative = rawInteger.startsWith("-");
  const integer = rawInteger.replace(/^-+/, "");
  const out = groupThousands(integer) + (frac ? "," + frac : "");
  return (negative ? "-" : "") + out;
}

/**
 * Splits `total` (in cents) proportionally to weights; residual cents are explicit.
 * Largest-remainder method, so the parts always sum exactly to the total (docs/04 §1).
 */
export function allocate(total: Dec, weights: readonly Dec[]): Dec[] {
  if (weights.length === 0 || weights.some((w) => w.isNegative()) || Dec.sum(weights).isZero()) {
    throw new MoneyError("invalid weights");
  }
  if (!isCents(total)) throw new MoneyError("total must be in cents");
  const cents = total.div(CENT).toInt();
  const weightSum = Dec.sum(weights);
  const raw = weights.map((w) => Dec.from(cents).mul(w).div(weightSum));
  const floors = raw.map((r) => r.toIntegral("ROUND_FLOOR").toInt());
  const remainder = cents - floors.reduce((a, b) => a + b, 0);
  const keyed = raw.map((r, i) => ({ i, frac: r.sub(Dec.from(floors[i]!)) }));
  // Python: sorted(key=(frac, -i), reverse=True) → larger fraction first, then smaller index first.
  keyed.sort((a, b) => {
    const c = b.frac.cmp(a.frac);
    return c !== 0 ? c : a.i - b.i;
  });
  for (const { i } of keyed.slice(0, Math.abs(remainder))) floors[i]! += remainder > 0 ? 1 : -1;
  return floors.map((f) => Dec.from(f).mul(CENT));
}
