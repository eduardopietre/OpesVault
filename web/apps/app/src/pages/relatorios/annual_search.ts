import { printFlag, yearParam } from "../../components/print_search.ts";
/** Search of the annual report's print view. */
export interface AnnualSearch {
  ano?: string;
  imprimir?: string;
}

/** Route search validation: the year and whether to open the print dialog at once. */
export function annualSearch(search: Record<string, unknown>): AnnualSearch {
  const year = yearParam(search["ano"]);
  return { ...(year ? { ano: year } : {}), ...printFlag(search) };
}
