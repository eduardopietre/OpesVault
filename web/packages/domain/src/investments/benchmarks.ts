/**
 * Local benchmark series (docs/06 §5): imported from a file, never fetched online.
 * Port of `investments/benchmarks.py`.
 */
import { z } from "zod";

import { DomainError, Ledger } from "../domain/ledger.ts";
import { zEntityId } from "../domain/model.ts";
import { MoneyError, parseBrl, toDecimal } from "../domain/money.ts";
import type { IsoDate } from "../lib/dates.ts";
import { Dec } from "../lib/dec.ts";
import { zDate, zDec } from "../lib/schema.ts";
import { dmy } from "../importing/parsers/base.ts";
import { csvRows } from "../importing/source.ts";
import { Quality, type Result, result, unavailable } from "./performance.ts";

export const BenchmarkSchema = z.strictObject({
  id: zEntityId,
  name: z.string().min(1).max(120),
  currency: z.string().default("BRL"),
  points: z.array(z.tuple([zDate, zDec])).readonly(), // index level by date
  source: z.string().max(200).default("arquivo importado"),
});
export type Benchmark = Readonly<z.output<typeof BenchmarkSchema>>;

Ledger.registerKind("benchmark", BenchmarkSchema);

export function benchmarks(ledger: Ledger) {
  return ledger.entities<Benchmark>("benchmark");
}

/** Python's `UnicodeDecodeError` for bytes that are not UTF-8. */
export class UnicodeDecodeError extends Error {
  override name = "UnicodeDecodeError";
}

function count(text: string, ch: string): number {
  let n = 0;
  for (const c of text) if (c === ch) n++;
  return n;
}

/** CSV with 'data;valor' (dd/mm/aaaa; index level in Brazilian format). */
export function importBenchmarkCsv(ledger: Ledger, name: string, data: Uint8Array, source: string): Benchmark {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(data);
  } catch {
    throw new UnicodeDecodeError("invalid utf-8");
  }
  if (text.startsWith("﻿")) text = text.slice(1); // utf-8-sig
  const delimiter = count(text, ";") >= count(text, ",") ? ";" : ",";
  const points = new Map<IsoDate, Dec>();
  for (const row of csvRows(text, delimiter)) {
    if (row.length < 2) continue;
    const when = dmy(row[0]!);
    if (when === null) continue; // header or invalid line
    let level: Dec;
    try {
      level = row[1]!.includes(",") ? parseBrl(row[1]!) : toDecimal(row[1]);
    } catch (error) {
      if (error instanceof MoneyError) throw new DomainError(`Valor inválido na linha de ${row[0]!}.`);
      throw error;
    }
    points.set(when, level);
  }
  if (points.size < 2) throw new DomainError("O arquivo precisa de ao menos duas datas com valores.");
  const sorted = [...points].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return ledger.put("benchmark", BenchmarkSchema.parse({ name, points: sorted, source }));
}

export function benchmarkReturn(benchmark: Benchmark, start: IsoDate, end: IsoDate): Result {
  const method = `variação do índice ${benchmark.name} (${benchmark.source})`;
  const levels = new Map<string, Dec>(benchmark.points.map(([d, v]) => [d, v]));
  const first = levels.get(start);
  const last = levels.get(end);
  if (first === undefined || last === undefined) {
    return unavailable(method, "A série local não tem valores exatamente nas datas do período.", start, end, "ratio");
  }
  if (!first.isPositive()) return unavailable(method, "Nível inicial não positivo.", start, end, "ratio");
  return result(last.div(first).sub(Dec.from(1)), "ratio", method, start, end, Quality.OBSERVED, [
    "mesma moeda e período",
  ]);
}
