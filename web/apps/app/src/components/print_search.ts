/**
 * The address of a print view (`print_sheet.tsx`), read by the router before the sheet's code loads: the
 * shared parts of its search validation.
 */

/** `imprimir=1`: open the print dialog once the sheet is drawn. */
export function printFlag(search: Record<string, unknown>): { imprimir?: "1" } {
  return search["imprimir"] === "1" || search["imprimir"] === 1 ? { imprimir: "1" } : {};
}

/** The `ano` of the address: four digits, as text. */
export function yearParam(value: unknown): string | undefined {
  const year = typeof value === "number" ? String(value) : value;
  return typeof year === "string" && /^\d{4}$/.test(year) ? year : undefined;
}
