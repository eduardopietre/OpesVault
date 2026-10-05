/** Measures the core with a large project: build, serialize, load and query (docs/18 W12 targets). */
import { performance } from "node:perf_hooks";

import { Ledger } from "../packages/domain/src/domain/ledger.ts";
import { AccountSubtype, AccountType, LedgerAccountSchema } from "../packages/domain/src/domain/model.ts";
import * as queries from "../packages/domain/src/domain/queries.ts";
import { addDays, type IsoDate, ym } from "../packages/domain/src/lib/dates.ts";

const N = Number(process.argv[2] ?? 50000);
const t0 = performance.now();
const ledger = Ledger.new("Bench");
const bank = ledger.addAccount(
  LedgerAccountSchema.parse({ name: "Banco", type: AccountType.ASSET, subtype: AccountSubtype.CHECKING }),
).id;
const cats = ledger.categories(AccountType.EXPENSE).map((a) => a.id);
ledger.recordOpeningBalance(bank, "100000.00", "2020-01-01" as IsoDate);
for (let i = 0; i < N; i++) {
  const cents = 100 + ((i * 7919) % 50000);
  ledger.recordExpense(
    bank,
    cats[i % cats.length]!,
    `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`,
    addDays("2020-01-01" as IsoDate, i % 2000),
    `Compra ${i}`,
  );
}
const t1 = performance.now();
const json = JSON.stringify(ledger.toRecords());
const t2 = performance.now();
const loaded = Ledger.fromRecords(JSON.parse(json));
const t3 = performance.now();
queries.balance(loaded, bank);
const t4 = performance.now();
queries.cashFlow(loaded, ym(2020, 1), ym(2025, 12));
queries.incomeStatement(loaded, ym(2021, 6));
const t5 = performance.now();
const mem = process.memoryUsage();
console.log(
  JSON.stringify({
    N,
    buildMs: Math.round(t1 - t0),
    serializeMs: Math.round(t2 - t1),
    jsonMiB: +(json.length / 2 ** 20).toFixed(1),
    loadMs: Math.round(t3 - t2),
    indexMs: Math.round(t4 - t3),
    queriesMs: Math.round(t5 - t4),
    heapMiB: Math.round(mem.heapUsed / 2 ** 20),
  }),
);
