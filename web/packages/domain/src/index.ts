import "./registry.ts";

export * from "./lib/dates.ts";
export * from "./lib/dec.ts";
export * from "./lib/ids.ts";
export * from "./lib/py.ts";
export * from "./lib/schema.ts";
export * from "./lib/text.ts";
export * from "./domain/money.ts";
export * from "./domain/model.ts";
export * from "./domain/ledger.ts";
export * from "./domain/tracking.ts";
export * from "./domain/migrations.ts";
export * as queries from "./domain/queries.ts";
export * as search from "./domain/search.ts";
export * as edits from "./domain/edits.ts";
export * from "./undo.ts";
export * as exporting from "./exports.ts";
// Areas: each area's index exports its modules as namespaces.
export * as dom from "./domain/index.ts";
export * as importing from "./importing/index.ts";
export * as investments from "./investments/index.ts";
export * as tax from "./tax/index.ts";
export * as catalogs from "./catalogs/index.ts";
export * as ai from "./ai/index.ts";
export * as assistant from "./assistant/index.ts";
export * as charts from "./charts/index.ts";
export * as session from "./session.ts";
