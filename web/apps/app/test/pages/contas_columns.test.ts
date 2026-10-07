/** Which columns a table shows for the room it has: never more than fit, the essential ones first. */
import { describe, expect, it } from "vitest";
import { CARDS_BELOW } from "@opesvault/ui";
import { CARD_TIERS, fitColumns, type TierColumn } from "../../src/components/tier_columns.ts";

interface Row {
  id: string;
}

const col = (id: string, tier: number, width: number): TierColumn<Row> => ({
  id,
  header: id,
  cell: () => id,
  width,
  tier,
});

// 100 + 100 | 100 | 150 | 200 | 200
const COLUMNS = [
  col("a", 1, 100),
  col("b", 1, 100),
  col("c", 2, 100),
  col("d", 3, 150),
  col("e", 4, 200),
  col("f", 5, 200),
];
const shown = (width: number) => fitColumns(COLUMNS, width).map((c) => c.id);

describe("fitColumns", () => {
  it("shows every column while the room is not measured yet", () => {
    expect(shown(0)).toEqual(["a", "b", "c", "d", "e", "f"]);
  });

  it("adds a tier only when the minimum widths up to it fit", () => {
    expect(shown(700)).toEqual(["a", "b", "c", "d", "e"]); // 650 fits, 850 does not
    expect(shown(650)).toEqual(["a", "b", "c", "d", "e"]);
    expect(shown(649)).toEqual(["a", "b", "c", "d"]);
    expect(shown(849)).toEqual(["a", "b", "c", "d", "e"]);
    expect(shown(850)).toEqual(["a", "b", "c", "d", "e", "f"]);
    expect(shown(2000)).toEqual(["a", "b", "c", "d", "e", "f"]);
  });

  it("keeps the order of the columns, whatever their tiers", () => {
    const mixed = [col("x", 3, 100), col("y", 1, 100), col("z", 2, 100)];
    expect(fitColumns(mixed, 1000).map((c) => c.id)).toEqual(["x", "y", "z"]);
    expect(fitColumns(mixed, 700).map((c) => c.id)).toEqual(["x", "y", "z"]);
    expect(fitColumns(mixed, 650).map((c) => c.id)).toEqual(["x", "y", "z"]);
  });

  it("always keeps the first tier, even when it does not fit", () => {
    expect(fitColumns([col("a", 1, 900)], 700).map((c) => c.id)).toEqual(["a"]);
  });

  it("gives a card more fields than a narrow table: the cards grow downward", () => {
    const narrow = fitColumns(COLUMNS, CARDS_BELOW - 1).map((c) => c.id);
    expect(narrow).toEqual(["a", "b", "c", "d"]);
    expect(COLUMNS.filter((c) => (c.tier ?? 1) <= CARD_TIERS).map((c) => c.id)).toEqual(narrow);
  });

  it("hands the table plain columns, without the tier", () => {
    for (const column of fitColumns(COLUMNS, 1000)) expect("tier" in column).toBe(false);
  });

  it("treats a column without a tier as essential and one without a width as 120 px", () => {
    const loose: TierColumn<Row>[] = [{ id: "a", header: "a", cell: () => "a" }, col("b", 2, 100)];
    expect(fitColumns(loose, 700).map((c) => c.id)).toEqual(["a", "b"]);
    const wide: TierColumn<Row>[] = [{ id: "a", header: "a", cell: () => "a" }, col("b", 2, 600)];
    expect(fitColumns(wide, 700).map((c) => c.id)).toEqual(["a"]);
  });
});
