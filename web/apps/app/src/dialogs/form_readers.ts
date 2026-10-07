/**
 * What a form's text fields hold, read as the domain's values and written back (Brazilian format, never a
 * float): money, dates, quantities and percentages. A reader throws a `DomainError` with the message the form
 * shows; empty is unknown (`null`) wherever a field may stay blank.
 */
import { Dec, DomainError, MoneyError, formatBrl, parseBrl, type IsoDate } from "@opesvault/domain";
import { formatBrDate, normalizeMoneyInput, parseBrDate } from "@opesvault/ui";

// ── money ───────────────────────────────────────

/**
 * A typed amount ("1.234,56"). Empty is unknown (`null`) only with `allowEmpty`; `where` places a bad value
 * ("na linha 2").
 */
export function readMoney(text: string, options: { allowEmpty: true; where?: string }): Dec | null;
export function readMoney(text: string, options?: { allowEmpty?: false; where?: string }): Dec;
export function readMoney(text: string, options: { allowEmpty?: boolean; where?: string } = {}): Dec | null {
  const typed = text.trim();
  if (!typed) {
    if (options.allowEmpty) return null;
    throw new DomainError("Informe o valor.");
  }
  try {
    return parseBrl(typed);
  } catch (error) {
    if (error instanceof MoneyError) {
      throw new DomainError(`Valor inválido${options.where ? ` ${options.where}` : ""}. Use o formato 1.234,56.`);
    }
    throw error;
  }
}

/**
 * The lenient reading of an amount field (the budget's): "2.350", "2350,5" or "2350.50" alike; null when empty
 * or not an amount, for the form to explain.
 */
export function readAmount(text: string): Dec | null {
  const canonical = normalizeMoneyInput(text);
  return canonical === null ? null : Dec.from(canonical);
}

/** Money as typed in a field: "1.234,56" (no currency symbol). */
export function editableMoney(value: Dec): string {
  return formatBrl(value).replace("R$", "").trim();
}

/** Plain digits, no rounding: what is shown is exactly what is stored (the postings grid). */
export function plainMoney(value: Dec): string {
  return value.abs().toFixed().replace(".", ",");
}

// ── dates ───────────────────────────────────────

/** A typed date (dd/mm/aaaa). */
export function readDate(text: string, name = "A data"): IsoDate {
  const iso = parseBrDate(text);
  if (iso === null) throw new DomainError(`${name} é inválida. Use dd/mm/aaaa.`);
  return iso as IsoDate;
}

/** The text of a field from a domain date ("" when unknown). */
export function dateText(date: IsoDate | null | undefined): string {
  return date ? formatBrDate(date) : "";
}

// ── quantities and percentages ──────────────────

/** A quantity typed the Brazilian way ("1.234,5"); never a float. */
export function readQuantity(text: string, name = "Quantidade"): Dec {
  const typed = text.trim().replace(/\./g, "").replace(",", ".");
  if (!/^\d+(\.\d+)?$/.test(typed)) throw new DomainError(`${name} inválida.`);
  return Dec.from(typed);
}

/** A number typed as a percentage ("110", "6,5", "15%"), as typed (not a fraction); empty is unknown. */
export function typedPercent(text: string, invalid: string): Dec | null {
  const raw = text.trim().replace("%", "").trim();
  if (!raw) return null;
  try {
    return parseBrl(raw);
  } catch (error) {
    if (error instanceof MoneyError) throw new DomainError(invalid);
    throw error;
  }
}

/** A rate between 0 and 100% typed as "15" or "27,5", as a fraction (0.15, 0.275); empty stays unknown. */
export function readPercent(text: string, label: string): Dec | null {
  const value = typedPercent(text, `${label}: use um percentual como 15 ou 27,5.`);
  if (value === null) return null;
  if (value.isNegative() || value.gt(100)) throw new DomainError(`${label}: informe entre 0 e 100.`);
  return value.div(100);
}
