import { Ledger, OperationKind, makeDate } from "@opesvault/domain";
import { describe, expect, it } from "vitest";
import {
  EMPTY_FILTERS,
  competenceLabel,
  filtersActive,
  monthOnly,
  parseReveal,
  periodRange,
  snapshotFilter,
  stateOfSaved,
} from "../../src/pages/livro/rows.ts";

const d = (y: number, m: number, day: number) => makeDate(y, m, day);

describe("Livro: periods", () => {
  const today = d(2026, 10, 6);
  it("reads the named periods like the desktop", () => {
    expect(periodRange("all", today)).toEqual([null, null]);
    expect(periodRange("this_month", today)).toEqual([d(2026, 10, 1), today]);
    expect(periodRange("last_month", today)).toEqual([d(2026, 9, 1), d(2026, 9, 30)]);
    expect(periodRange("last_3", today)).toEqual([d(2026, 8, 1), today]);
    expect(periodRange("this_year", today)).toEqual([d(2026, 1, 1), today]);
    expect(periodRange("last_month", d(2026, 1, 15))).toEqual([d(2025, 12, 1), d(2025, 12, 31)]);
    expect(periodRange("last_3", d(2026, 2, 10))).toEqual([d(2025, 12, 1), d(2026, 2, 10)]);
  });

  it("says when something narrows the list", () => {
    expect(filtersActive(EMPTY_FILTERS)).toBe(false);
    expect(filtersActive({ ...EMPTY_FILTERS, period: "month" })).toBe(true);
    expect(monthOnly({ ...EMPTY_FILTERS, period: "month" })).toBe(true);
    expect(monthOnly({ ...EMPTY_FILTERS, period: "month", text: "x" })).toBe(false);
  });
});

describe("Livro: links from other pages", () => {
  it("reads every kind of ref", () => {
    expect(parseReveal("abc-123")).toEqual({ kind: "operation", id: "abc-123" });
    expect(parseReveal("categoria:c1:2026-03")).toEqual({
      kind: "category",
      id: "c1",
      month: { year: 2026, month: 3 },
    });
    expect(parseReveal("conta:a1")).toEqual({ kind: "account", id: "a1" });
    expect(parseReveal("marcador:Viagem 2026")).toEqual({ kind: "tag", id: "Viagem 2026" });
    expect(parseReveal("filter:a1:2026-03")).toEqual({
      kind: "filter",
      id: "a1",
      month: { year: 2026, month: 3 },
      range: null,
      member: null,
    });
    expect(parseReveal("filter:a1:2026-03:m1")).toMatchObject({ kind: "filter", member: "m1" });
    expect(parseReveal("filter:a1:2026-02-01..2026-02-28")).toEqual({
      kind: "filter",
      id: "a1",
      month: null,
      range: ["2026-02-01", "2026-02-28"],
      member: null,
    });
  });
});

describe("Livro: saved filters and labels", () => {
  it("round-trips a filter through the project's record, and drops what no longer exists", async () => {
    const ledger = Ledger.new("Teste");
    const state = { ...EMPTY_FILTERS, period: "last_3" as const, text: "mercado", status: "active" as const };
    const saved = snapshotFilter(state, "Mercado recente");
    expect(saved).toMatchObject({ name: "Mercado recente", period: "last_3", text: "mercado", status: "active" });
    expect(stateOfSaved(ledger, saved)).toEqual(state);
    const gone = snapshotFilter({ ...state, account: "00000000-0000-4000-8000-000000000000" }, "Conta apagada");
    expect(stateOfSaved(ledger, gone).account).toBeNull();
  });

  it("writes the competence month like the tables do", () => {
    const op = { accrual_month: { year: 2026, month: 3 }, kind: OperationKind.EXPENSE } as never;
    expect(competenceLabel(op)).toBe("mar/2026");
    expect(competenceLabel({ accrual_month: null } as never)).toBe("—");
  });
});
