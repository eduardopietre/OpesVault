/**
 * Money and dates in tables and figures: what is unknown is a dash, never zero (CLAUDE.md), and a money column
 * sorts by its exact cents.
 */
import { formatBrl, formatDateBr, type Dec, type IsoDate } from "@opesvault/domain";

/** What a cell shows for an unknown value. */
export const DASH = "—";

/** Exact cents for sorting a money column (half up). */
export function cents(value: Dec): bigint;
export function cents(value: Dec | null): bigint | null;
export function cents(value: Dec | null): bigint | null {
  return value === null ? null : BigInt(value.quantize("0.01", "ROUND_HALF_UP").toFixed().replace(".", ""));
}

/** Money, or a dash when unknown. */
export const moneyOr = (value: Dec | null | undefined): string =>
  value === null || value === undefined ? DASH : formatBrl(value);

/** A date (dd/mm/aaaa), or a dash when unknown. */
export const dateOr = (date: IsoDate | null | undefined): string => (date ? formatDateBr(date) : DASH);
