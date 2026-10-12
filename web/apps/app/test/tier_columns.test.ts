import { describe, expect, it } from "vitest";
import { longestTexts, widenColumns, type TierColumn } from "../src/components/tier_columns.ts";

interface Row {
  name: string;
  savings: string;
}

const COLUMNS: TierColumn<Row>[] = [
  { id: "name", header: "Conta", cell: (r) => r.name, width: 130, tier: 1 },
  { id: "savings", header: "Poupança", cell: (r) => r.savings, align: "end", width: 110, tier: 4 },
];

describe("number columns grow to their longest text", () => {
  it("finds the longest text of each column aligned to the end, and only those", () => {
    const rows = [
      { name: "Conta conjunta com nome longo", savings: "R$ 1.064,11" },
      { name: "Outra", savings: "R$ 11.268,45" },
    ];
    expect(longestTexts(COLUMNS, rows)).toEqual(new Map([["savings", "R$ 11.268,45"]]));
  });

  it("leaves out cells that render an element", () => {
    const columns: TierColumn<Row>[] = [{ ...COLUMNS[1]!, cell: () => ({}) as never }];
    expect(longestTexts(columns, [{ name: "a", savings: "b" }]).size).toBe(0);
  });

  it("raises a minimum width only when the text needs more", () => {
    const wider = widenColumns(COLUMNS, new Map([["savings", 140]]));
    expect(wider.map((c) => c.width)).toEqual([130, 140]);
    const narrower = widenColumns(COLUMNS, new Map([["savings", 90]]));
    expect(narrower[1]).toBe(COLUMNS[1]);
  });
});
