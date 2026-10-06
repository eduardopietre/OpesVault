import { screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { goTab, openContas } from "./contas_harness.tsx";

vi.mock("../../../../packages/ui/src/chart/echarts.ts", async () => await import("./fake_echarts.ts"));

describe("smoke", () => {
  it("renders every tab", async () => {
    const { user } = await openContas();
    for (const name of [
      "Contas bancárias",
      "Todas as contas",
      "Cartões",
      "Faturas",
      "Financiamentos",
      "Categorias",
      "Regras",
      "Integrantes",
    ]) {
      const panel = await goTab(user, name);
      expect(panel.textContent!.length).toBeGreaterThan(20);
      console.log(name, "→", panel.textContent!.slice(0, 300));
    }
    expect(screen.getByRole("tab", { name: "Integrantes" })).toBeTruthy();
  });
});
