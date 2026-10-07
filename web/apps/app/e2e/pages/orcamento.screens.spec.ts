/**
 * Screenshots of Orçamento in light and dark at each size (docs/18 §5.3), written to web/build/telas.
 *   pnpm --filter @opesvault/app screens
 */
import { test } from "@playwright/test";
import { openDemo, settle } from "../helpers.ts";
import { forEachScreen, screenshot } from "../shots.ts";

forEachScreen(({ size, suffix }) => {
  test("orçamento", async ({ page }) => {
    await openDemo(page, "/orcamento");
    await page.locator("canvas").first().waitFor();
    await settle(page, 900);
    await screenshot(page, `orcamento-${suffix}`, { fullPage: true });
    const table = page.getByRole(size.width < 640 ? "listbox" : "grid", { name: "Orçamento por categoria" });
    await table.getByText("Transporte").first().click();
    await settle(page, 400);
    await screenshot(page, `orcamento-selecao-${suffix}`, { fullPage: true });
    await page.getByRole("button", { name: "Orçamento do mês…" }).click();
    await page.getByRole("dialog").waitFor();
    await settle(page);
    await screenshot(page, `orcamento-grade-${suffix}`);
    await page.keyboard.press("Escape");
    await page.getByRole("dialog").waitFor({ state: "hidden" });
    await page.getByRole("button", { name: "Mês anterior", exact: true }).click();
    await page.getByRole("button", { name: "Mês anterior", exact: true }).click();
    await page.getByRole("button", { name: "Mês anterior", exact: true }).click();
    await page.getByRole("heading", { name: /^Sem orçamento em / }).waitFor();
    await settle(page);
    await screenshot(page, `orcamento-vazio-${suffix}`, { fullPage: true });
  });
});
