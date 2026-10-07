import { printFlag, yearParam } from "../../components/print_search.ts";
/** Search of the return report's print view: the year, the declarant and whether to open the print dialog at once. */
export interface TaxReportSearch {
  ano?: string;
  declarante?: string;
  imprimir?: string;
}

/** Route search validation (`/imprimir/imposto?ano=2025[&declarante=id][&imprimir=1]`). */
export function taxReportSearch(search: Record<string, unknown>): TaxReportSearch {
  const out: TaxReportSearch = {};
  const year = yearParam(search["ano"]);
  if (year) out.ano = year;
  if (typeof search["declarante"] === "string" && search["declarante"]) out.declarante = search["declarante"];
  return { ...out, ...printFlag(search) };
}
