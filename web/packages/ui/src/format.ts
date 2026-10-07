/**
 * Text helpers for Brazilian input and display. Money never passes through a float: amounts are decimal
 * strings ("-1234.56") handled as scaled BigInt. Pages parse the canonical string with the domain's Dec;
 * these helpers only read what the user typed and show values.
 */

const DECIMAL = /^-?\d+(\.\d+)?$/;

/** A canonical decimal string, or false. */
export function isDecimalText(text: string): boolean {
  return DECIMAL.test(text);
}

/** "1234.5" → [123450n, 2] at the given scale (truncates nothing: the scale must be large enough). */
export function toScaled(text: string, scale: number): bigint {
  if (!DECIMAL.test(text)) throw new RangeError("Not a decimal string");
  const negative = text.startsWith("-");
  const [whole = "0", fraction = ""] = (negative ? text.slice(1) : text).split(".");
  if (fraction.length > scale) throw new RangeError("Scale too small for this value");
  const digits = BigInt(whole + fraction.padEnd(scale, "0"));
  return negative ? -digits : digits;
}

/** 123450n at scale 2 → "1234.50". */
export function fromScaled(value: bigint, scale: number): string {
  const negative = value < 0n;
  const digits = (negative ? -value : value).toString().padStart(scale + 1, "0");
  const whole = scale > 0 ? digits.slice(0, -scale) : digits;
  const fraction = scale > 0 ? digits.slice(-scale) : "";
  return (negative ? "-" : "") + whole + (fraction ? `.${fraction}` : "");
}

/** The number of decimal places of a decimal string. */
export function scaleOf(text: string): number {
  const dot = text.indexOf(".");
  return dot < 0 ? 0 : text.length - dot - 1;
}

/** Exact sum of decimal strings, at the largest scale among them. */
export function sumDecimals(values: readonly string[]): string {
  const scale = Math.max(0, ...values.map(scaleOf));
  return fromScaled(
    values.reduce((total, value) => total + toScaled(value, scale), 0n),
    scale,
  );
}

/** Exact mean, rounded half away from zero (ROUND_HALF_UP) to `scale` places. */
export function meanDecimals(values: readonly string[], scale = 2): string | null {
  if (values.length === 0) return null;
  const inner = Math.max(scale, ...values.map(scaleOf));
  const total = values.reduce((sum, value) => sum + toScaled(value, inner), 0n);
  // Bring the total to `scale` + 1 extra digit of precision per division, then round half up.
  const shift = 10n ** BigInt(inner - scale);
  const divisor = BigInt(values.length) * shift;
  const negative = total < 0n;
  const magnitude = negative ? -total : total;
  let quotient = magnitude / divisor;
  const remainder = magnitude % divisor;
  if (remainder * 2n >= divisor) quotient += 1n;
  return fromScaled(negative ? -quotient : quotient, scale);
}

/** "-1234.5" → "-1.234,50" (with `places`), or "R$ -1.234,50" with `currency`. Non-decimal text is returned as is. */
export function formatDecimalBR(text: string, options: { places?: number; currency?: boolean } = {}): string {
  if (!DECIMAL.test(text)) return text;
  let value = text;
  if (options.places !== undefined) {
    const scale = Math.max(scaleOf(text), options.places);
    const scaled = toScaled(text, scale);
    const drop = scale - options.places;
    if (drop > 0) {
      const factor = 10n ** BigInt(drop);
      const negative = scaled < 0n;
      const magnitude = negative ? -scaled : scaled;
      let quotient = magnitude / factor;
      if ((magnitude % factor) * 2n >= factor) quotient += 1n;
      value = fromScaled(negative ? -quotient : quotient, options.places);
    } else {
      value = fromScaled(scaled, options.places);
    }
  }
  const negative = value.startsWith("-");
  const [whole = "0", fraction] = (negative ? value.slice(1) : value).split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  const body = (negative ? "-" : "") + grouped + (fraction !== undefined ? `,${fraction}` : "");
  return options.currency ? `R$ ${body}` : body;
}

/**
 * What the user typed in a money field ("1.234,56", "1234,5", "-12", "R$ 1.234", "1234.56") as a canonical
 * decimal string ("1234.56"), or null when it is not a valid amount. The dot is a thousands separator in
 * Brazilian use; it is read as the decimal point only when it is the single separator and is followed by
 * one or two digits ("12.5", "1234.56").
 */
export function normalizeMoneyInput(raw: string, maxDecimals = 2): string | null {
  let text = raw.replace(/R\$/gi, "").replace(/[\s\u00a0]/g, "");
  if (text === "") return null;
  let negative = false;
  if (text.startsWith("-")) {
    negative = true;
    text = text.slice(1);
  } else if (text.startsWith("(") && text.endsWith(")")) {
    negative = true;
    text = text.slice(1, -1);
  }
  if (!/^[\d.,]+$/.test(text)) return null;
  let whole: string;
  let fraction = "";
  const comma = text.lastIndexOf(",");
  if (comma >= 0) {
    whole = text.slice(0, comma);
    fraction = text.slice(comma + 1);
    if (fraction.includes(".") || fraction.includes(",")) return null;
  } else if (/^\d+\.\d{1,2}$/.test(text) && !/^\d{1,3}\.\d{3}$/.test(text)) {
    [whole = "", fraction = ""] = text.split(".");
  } else {
    whole = text;
  }
  if (whole.includes(".")) {
    if (!/^\d{1,3}(\.\d{3})+$/.test(whole)) return null;
    whole = whole.replaceAll(".", "");
  }
  if (whole.includes(",")) return null;
  if (whole === "" && fraction === "") return null;
  if (!/^\d*$/.test(whole) || !/^\d*$/.test(fraction)) return null;
  if (fraction.length > maxDecimals) return null;
  const digits = (whole.replace(/^0+(?=\d)/, "") || "0") + (fraction ? `.${fraction}` : "");
  const isZero = /^0(\.0*)?$/.test(digits);
  return (negative && !isZero ? "-" : "") + digits;
}

const MONTHS = [
  "janeiro",
  "fevereiro",
  "março",
  "abril",
  "maio",
  "junho",
  "julho",
  "agosto",
  "setembro",
  "outubro",
  "novembro",
  "dezembro",
] as const;

/** A competence month, shaped like the domain's YearMonth. */
export interface Month {
  readonly year: number;
  readonly month: number; // 1..12
}

export function monthName(month: number): string {
  return MONTHS[month - 1] ?? "";
}

/** "outubro de 2026". */
export function formatMonth(value: Month): string {
  return `${monthName(value.month)} de ${value.year}`;
}

/** "out/26", for chart axes (docs/16 §4 rule 7). */
export function formatMonthShort(value: Month): string {
  return `${monthName(value.month).slice(0, 3)}/${String(value.year % 100).padStart(2, "0")}`;
}

export function addMonths(value: Month, delta: number): Month {
  const index = value.year * 12 + (value.month - 1) + delta;
  return { year: Math.floor(index / 12), month: (index % 12) + 1 };
}

/** "05/10/2026" or "5102026"/"05102026" → "2026-10-05"; null when it is not a real calendar date. */
export function parseBrDate(raw: string): string | null {
  const text = raw.trim();
  let match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(text);
  if (!match) {
    const digits = /^(\d{2})(\d{2})(\d{4})$/.exec(text);
    if (!digits) return null;
    match = digits;
  }
  const day = Number(match[1]);
  const month = Number(match[2]);
  const year = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || year < 1900 || year > 2200) return null;
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (day > last) return null;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** "2026-10-05" → "05/10/2026". */
export function formatBrDate(iso: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  return match ? `${match[3]}/${match[2]}/${match[1]}` : iso;
}

/** Lowercase without accents, for searching names ("Orçamento" matches "orcamento"). */
export function searchKey(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();
}

/** A size in bytes, in binary units as the browser and the backup report it: "512 B", "1,5 KiB", "5 MiB". */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toLocaleString("pt-BR", { maximumFractionDigits: 1 })} ${units[unit]}`;
}

const LABELS = new Intl.Collator("pt-BR", { sensitivity: "base" });

/** Order of names shown to people: Portuguese, ignoring case and accents ("Água" before "Viagem"). */
export function compareLabels(a: string, b: string): number {
  return LABELS.compare(a, b);
}
