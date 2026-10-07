/**
 * Screenshots of Metas in light and dark at each size (docs/18 §5.3), written to web/build/telas.
 *   pnpm --filter @opesvault/app screens
 */
import { test } from "@playwright/test";
import { openDemo, settle } from "../helpers.ts";
import { forEachScreen, screenshot } from "../shots.ts";

forEachScreen(({ suffix }) => {
  test("metas", async ({ page }) => {
    await openDemo(page, "/metas");
    await page.locator("canvas").first().waitFor();
    await settle(page, 900);
    await screenshot(page, `metas-${suffix}`);
    await page.evaluate(() => document.getElementById("conteudo")?.scrollTo(0, 1e6));
    await settle(page, 500);
    await screenshot(page, `metas-fim-${suffix}`);
    await page.evaluate(() => document.getElementById("conteudo")?.scrollTo(0, 0));
    await page.getByRole("button", { name: "Nova meta…" }).click();
    await page.getByRole("dialog").waitFor();
    await page.getByLabel("Nome").fill("Viagem");
    await page.getByRole("button", { name: "Criar meta" }).click();
    await settle(page);
    await screenshot(page, `metas-nova-${suffix}`);
    await page.keyboard.press("Escape");
    await page.getByRole("dialog").waitFor({ state: "hidden" });
    await page.getByRole("button", { name: "Editar meta…" }).click();
    await page.getByRole("dialog").waitFor();
    await settle(page);
    await screenshot(page, `metas-editar-${suffix}`);
  });
});
