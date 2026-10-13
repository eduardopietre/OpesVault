import { printFlag } from "../../components/print_search.ts";

/** Search of the investments' full table (print view). */
export interface FullTableSearch {
  imprimir?: string;
}

/** Route search validation: only whether to open the print dialog at once. */
export function fullTableSearch(search: Record<string, unknown>): FullTableSearch {
  return printFlag(search);
}
