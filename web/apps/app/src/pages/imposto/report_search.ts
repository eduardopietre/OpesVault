/** Search of the return report's print view: the year, the declarant and whether to open the print dialog at once. */
export interface TaxReportSearch {
  ano?: string;
  declarante?: string;
  imprimir?: string;
}

/** Route search validation (`/imprimir/imposto?ano=2025[&declarante=id][&imprimir=1]`). */
export function taxReportSearch(search: Record<string, unknown>): TaxReportSearch {
  const out: TaxReportSearch = {};
  const year = typeof search["ano"] === "number" ? String(search["ano"]) : search["ano"];
  if (typeof year === "string" && /^\d{4}$/.test(year)) out.ano = year;
  if (typeof search["declarante"] === "string" && search["declarante"]) out.declarante = search["declarante"];
  if (search["imprimir"] === "1" || search["imprimir"] === 1) out.imprimir = "1";
  return out;
}
