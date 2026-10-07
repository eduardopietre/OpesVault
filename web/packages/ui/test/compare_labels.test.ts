import { describe, expect, it } from "vitest";
import { compareLabels } from "../src/format.ts";

describe("compareLabels", () => {
  it("orders names as people read them: accents and case do not push a name to the end", () => {
    expect(["Viagem", "água", "Água e luz", "Educação", "alimentação"].sort(compareLabels)).toEqual([
      "água",
      "Água e luz",
      "alimentação",
      "Educação",
      "Viagem",
    ]);
  });
});
