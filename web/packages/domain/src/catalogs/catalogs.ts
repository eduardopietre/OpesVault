/**
 * Fixed lists the app embeds so it works offline: banks (COMPE) and IRPF codes.
 * Port of `catalogs/__init__.py` (the package's own functions).
 *
 * Lists, not rules: they name things the way the Banco Central and the IRPF program name them.
 * No tax rate, limit or exemption value lives here (docs/00 §5).
 */
import { normalize } from "../importing/rules.ts";
import { BANKS } from "./banks.ts";

export interface Bank {
  readonly code: string; // COMPE, three digits
  readonly ispb: string;
  readonly cnpj: string; // digits, '' when unknown
  readonly short_name: string;
  readonly name: string;
}

/** Python's `Bank.label` property. */
export function bankLabel(b: Bank): string {
  return `${b.code} — ${b.name}`;
}

let cachedBanks: readonly Bank[] | null = null;
let cachedByCode: ReadonlyMap<string, Bank> | null = null;

export function banks(): readonly Bank[] {
  cachedBanks ??= BANKS.map(([code, ispb, cnpj, short_name, name]) => ({ code, ispb, cnpj, short_name, name }));
  return cachedBanks;
}

function byCode(): ReadonlyMap<string, Bank> {
  cachedByCode ??= new Map(banks().map((b) => [b.code, b]));
  return cachedByCode;
}

/** Python's `str.zfill(width)`: zeros on the left, after a leading sign. */
function zfill(text: string, width: number): string {
  if (text.length >= width) return text;
  const sign = text[0] === "+" || text[0] === "-" ? text[0] : "";
  return sign + text.slice(sign.length).padStart(width - sign.length, "0");
}

export function bank(code: string | null | undefined): Bank | null {
  if (!code) return null;
  return byCode().get(zfill(code.trim(), 3)) ?? null;
}

/** Banks whose code or name contains the text (accents and case ignored). */
export function search(text: string, limit = 20): Bank[] {
  const needle = normalize(text);
  if (!needle) return [];
  const found = banks().filter(
    (b) => b.code.includes(needle) || normalize(b.name).includes(needle) || normalize(b.short_name).includes(needle),
  );
  return found.slice(0, limit);
}
