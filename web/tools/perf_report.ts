/**
 * Prints the result of the big-project measurements (apps/app/e2e/perf.spec.ts, `pnpm --filter @opesvault/app perf`)
 * as a table against the W12 targets (docs/18): open under 3 s, tab memory under 500 MiB, the Livro scrolling at
 * 60 fps and filtering under 100 ms.
 *
 *   node tools/perf_report.ts [results.json] [--before earlier-results.json]
 */
import { readFileSync } from "node:fs";

type Section = Record<string, number | string>;
type Results = Record<string, Section>;

const args = process.argv.slice(2);
const beforeAt = args.indexOf("--before");
const before: Results | null = beforeAt >= 0 ? read(args[beforeAt + 1]!) : null;
const file = args.find((a, i) => !a.startsWith("--") && i !== beforeAt + 1) ?? "apps/app/build/perf/results.json";
const results = read(file);

function read(path: string): Results {
  return JSON.parse(readFileSync(path, "utf8")) as Results;
}

const num = (section: string, key: string, from: Results = results): number | null => {
  const value = from[section]?.[key];
  return typeof value === "number" ? value : null;
};

interface Row {
  readonly what: string;
  readonly section: string;
  readonly key: string;
  readonly unit: string;
  /** Pass when `value <= limit` (or `>= limit` for fps). */
  readonly limit?: number;
  readonly atLeast?: boolean;
}

const rows: Row[] = [
  { what: "Open from this device: total", section: "open warm (device)", key: "total", unit: "ms", limit: 3000 },
  { what: "  Argon2id (unlock)", section: "open warm (device)", key: "opv:kdf", unit: "ms" },
  { what: "  read + decrypt the records", section: "open warm (device)", key: "opv:decrypt", unit: "ms" },
  { what: "  IndexedDB read", section: "open warm (device)", key: "opv:cache-read", unit: "ms" },
  { what: "  build the Ledger", section: "open warm (device)", key: "opv:ledger", unit: "ms" },
  { what: "  first paint of Visão geral", section: "open warm (device)", key: "firstPaint", unit: "ms" },
  {
    what: "Open from the server (new device): total",
    section: "open cold (server)",
    key: "total",
    unit: "ms",
    limit: 3000,
  },
  { what: "Open, project in memory (UI only)", section: "open (UI only)", key: "total", unit: "ms" },
  { what: "Heap after opening", section: "memory after warm open", key: "heapMiB", unit: "MiB" },
  { what: "Tab memory after opening (RSS)", section: "memory after warm open", key: "rssMiB", unit: "MiB", limit: 500 },
  {
    what: "Tab memory in the Livro (RSS)",
    section: "memory in the Livro (UI only)",
    key: "rssMiB",
    unit: "MiB",
    limit: 500,
  },
  { what: "Livro first paint", section: "livro", key: "firstPaintMs", unit: "ms" },
  {
    what: "Livro scroll, 120 px per frame",
    section: "livro scroll 120px/frame",
    key: "fps",
    unit: "fps",
    limit: 59,
    atLeast: true,
  },
  {
    what: "  main thread per frame",
    section: "livro scroll 120px/frame",
    key: "mainThreadMsPerFrame",
    unit: "ms",
    limit: 16,
  },
  {
    what: "Livro scroll, 900 px per frame (stress)",
    section: "livro scroll 900px/frame (stress)",
    key: "fps",
    unit: "fps",
  },
  { what: "Filter: account", section: "livro filters", key: "account (ms)", unit: "ms", limit: 100 },
  { what: "Filter: category", section: "livro filters", key: "category (ms)", unit: "ms", limit: 100 },
  { what: "Filter: month", section: "livro filters", key: "period 'Mês selecionado' (ms)", unit: "ms", limit: 100 },
  {
    what: "Filter: search after the 250 ms pause",
    section: "livro filters",
    key: "search 'Mercado' after debounce (ms)",
    unit: "ms",
    limit: 100,
  },
];

const pad = (text: string, width: number) => text.padEnd(width);
const show = (value: number | null, unit: string) => (value === null ? "-" : `${value} ${unit}`);
console.log(`${pad("Measure", 44)}${pad("Now", 14)}${before ? pad("Before", 14) : ""}${pad("Target", 12)}Result`);
for (const row of rows) {
  const now = num(row.section, row.key);
  const was = before ? num(row.section, row.key, before) : null;
  const target = row.limit === undefined ? "" : `${row.atLeast ? ">=" : "<="} ${row.limit}`;
  const ok =
    row.limit === undefined || now === null ? "" : (row.atLeast ? now >= row.limit : now <= row.limit) ? "ok" : "ABOVE";
  console.log(
    `${pad(row.what, 44)}${pad(show(now, row.unit), 14)}${before ? pad(show(was, row.unit), 14) : ""}${pad(target, 12)}${ok}`,
  );
}
const project = results["project"];
if (project) console.log(`\nProject: ${project["operations"]} operations, ${project["records"]} records.`);
