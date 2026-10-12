/**
 * Parity with scripts/golden/cases_benchmarks.py: local index series imported from CSV (every
 * delimiter, decimal and error case) and the variation of the index over each pair of its dates.
 */
import { describe, expect, it } from "vitest";

import { DomainError, Ledger } from "../src/domain/ledger.ts";
import { dump } from "../src/domain/model.ts";
import type { IsoDate } from "../src/lib/dates.ts";
import { benchmarkReturn, benchmarks, importBenchmarkCsv, MAX_BENCHMARK_CHARS } from "../src/investments/benchmarks.ts";
import { golden, j } from "./golden.ts";
import { bytesOf } from "./importing_helpers.ts";

interface Case {
  why: string;
  name: string;
  source: string;
  csv: string;
  outcome: { ok?: Record<string, unknown>; error?: string; message?: string };
  returns?: { start: IsoDate; end: IsoDate; result: unknown }[];
  stored?: number;
}

/** Pydantic's ValidationError is zod's ZodError here. */
const PY_NAMES: Record<string, string> = { ZodError: "ValidationError" };

describe("benchmarks replayed from the desktop", () => {
  for (const c of golden<{ cases: Case[] }>("benchmarks").cases) {
    it(c.why, () => {
      const ledger = Ledger.new("Projeto");
      let made;
      try {
        made = importBenchmarkCsv(ledger, c.name, bytesOf(c.csv), c.source);
      } catch (error) {
        const name = (error as Error).name;
        expect(PY_NAMES[name] ?? name).toBe(c.outcome.error);
        if (error instanceof DomainError) expect((error as Error).message).toBe(c.outcome.message);
        expect(c.outcome.ok).toBeUndefined();
        expect(benchmarks(ledger).size).toBe(0);
        return;
      }
      const { id: _id, ...rest } = dump(made) as Record<string, unknown>;
      expect(c.outcome.error).toBeUndefined();
      expect(rest).toEqual(c.outcome.ok);
      expect(benchmarks(ledger).size).toBe(c.stored);
      const actual = c.returns!.map((r) => ({
        start: r.start,
        end: r.end,
        result: j(benchmarkReturn(made, r.start, r.end)),
      }));
      expect(actual).toEqual(c.returns);
    });
  }
});

describe("benchmark size", () => {
  /** `days` daily points from 01/01/1900, each level with `digits` digits after the comma. */
  const series = (days: number, digits: number): Uint8Array => {
    const lines = ["data;valor"];
    const day = new Date(Date.UTC(1900, 0, 1));
    for (let i = 0; i < days; i++) {
      const d = new Date(day.getTime() + i * 86_400_000);
      const dmy = `${String(d.getUTCDate()).padStart(2, "0")}/${String(d.getUTCMonth() + 1).padStart(2, "0")}/${d.getUTCFullYear()}`;
      lines.push(`${dmy};1234,${"5".repeat(digits)}`);
    }
    return new TextEncoder().encode(lines.join("\n"));
  };

  it("keeps a long daily series (40 years) and refuses one past what a record can hold", () => {
    const ledger = Ledger.new("Projeto");
    expect(importBenchmarkCsv(ledger, "CDI", series(40 * 365, 8), "teste").points).toHaveLength(40 * 365);
    expect(() => importBenchmarkCsv(ledger, "Grande", series(30_000, 8), "teste")).toThrow(DomainError);
    expect(benchmarks(ledger).size).toBe(1);
  });

  it("stays within the server's record limit", () => {
    // The largest accepted series, sealed, must fit LIMITS.maxRecordCiphertext (1 MiB of base64url).
    const json = MAX_BENCHMARK_CHARS + 1000;
    expect(Math.ceil(((1 + 12 + Math.ceil((json + 1) / 64) * 64 + 16) * 4) / 3)).toBeLessThan(1_048_576);
  });
});
