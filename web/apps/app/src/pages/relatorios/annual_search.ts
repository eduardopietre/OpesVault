/** Search of the annual report's print view. */
export interface AnnualSearch {
  ano?: string;
  imprimir?: string;
}

/** Route search validation: the year and whether to open the print dialog at once. */
export function annualSearch(search: Record<string, unknown>): AnnualSearch {
  const out: AnnualSearch = {};
  const year = typeof search["ano"] === "number" ? String(search["ano"]) : search["ano"];
  if (typeof year === "string" && /^\d{4}$/.test(year)) out.ano = year;
  if (search["imprimir"] === "1" || search["imprimir"] === 1) out.imprimir = "1";
  return out;
}
