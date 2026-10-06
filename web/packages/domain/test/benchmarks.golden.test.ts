/**
 * Parity with scripts/golden/cases_benchmarks.py: local index series imported from CSV (every
 * delimiter, decimal and error case) and the variation of the index over each pair of its dates.
 */
import { describe, expect, it } from "vitest";

import { DomainError, Ledger } from "../src/domain/ledger.ts";
import { dump } from "../src/domain/model.ts";
import type { IsoDate } from "../src/lib/dates.ts";
import { benchmarkReturn, benchmarks, importBenchmarkCsv } from "../src/investments/benchmarks.ts";
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
