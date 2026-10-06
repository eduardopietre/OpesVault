/** Search of the report's print view. */
export interface ReportSearch {
  m?: string;
  membro?: string;
  imprimir?: string;
}

/** Route search validation: the month, the member and whether to open the print dialog at once. */
export function reportSearch(search: Record<string, unknown>): ReportSearch {
  const out: ReportSearch = {};
  if (typeof search["m"] === "string" && /^\d{4}-\d{2}$/.test(search["m"])) out.m = search["m"];
  if (typeof search["membro"] === "string" && search["membro"]) out.membro = search["membro"];
  if (search["imprimir"] === "1" || search["imprimir"] === 1) out.imprimir = "1";
  return out;
}
