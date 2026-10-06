import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { openLivro } from "./livro_harness.tsx";

describe("Livro: smoke", () => {
  it("shows the demonstration operations", async () => {
    const { workspace } = await openLivro();
    const grid = screen.getByRole("grid", { name: "Lançamentos" });
    expect(grid.querySelectorAll("[data-row-id]").length).toBeGreaterThan(5);
    expect(workspace.ledger.operations.size).toBeGreaterThan(20);
  });
});
