/**
 * Screenshots of Recorrências in light and dark at each size (docs/18 §5.3), written to web/build/telas.
 *   pnpm --filter @opesvault/app screens
 */
import { test, type Page } from "@playwright/test";
import { openDemo, settle, tableOf } from "../helpers.ts";
import { dialogOf } from "../ui.ts";
import { forEachScreen, screenshot } from "../shots.ts";

/** The content scrolls inside the shell: the rest of the page, after the first screen. */
async function scrollDown(page: Page) {
  await page.evaluate(() => document.getElementById("conteudo")?.scrollTo(0, 1e6));
  await settle(page, 500);
}

forEachScreen(({ suffix }) => {
  test("recorrências", async ({ page }) => {
    await openDemo(page, "/recorrencias");
    await tableOf(page, "Previsões").waitFor();
    await settle(page, 900);
    await screenshot(page, `recorrencias-${suffix}`);
    await scrollDown(page);
    await screenshot(page, `recorrencias-fim-${suffix}`);
    await page.evaluate(() => document.getElementById("conteudo")?.scrollTo(0, 0));
    await tableOf(page, "Regras de recorrência").getByText("Aluguel").first().click();
    await tableOf(page, "Previsões").getByText("Atrasada").first().click();
    await settle(page, 400);
    await screenshot(page, `recorrencias-selecao-${suffix}`);
    await page.getByRole("button", { name: "Editar…" }).click();
    await dialogOf(page, "Editar recorrência").waitFor();
    await settle(page);
    await screenshot(page, `recorrencias-editar-${suffix}`);
    await page.keyboard.press("Escape");
    await dialogOf(page, "Editar recorrência").waitFor({ state: "hidden" });
    await page.getByRole("button", { name: "Nova recorrência…" }).click();
    await page.getByRole("button", { name: "Criar recorrência" }).click();
    await settle(page);
    await screenshot(page, `recorrencias-nova-${suffix}`);
  });

  test("recorrências com vínculo e cobranças que se repetem", async ({ page }) => {
    // the web demonstration has the condominium fee to link and a charge that repeats (data/demo_extra.ts)
    await openDemo(page, "/recorrencias");
    await tableOf(page, "Previsões").waitFor();
    await tableOf(page, "Previsões").locator("[data-row-id]", { hasText: "Condomínio" }).first().click();
    await page.getByRole("button", { name: "Vincular realizado…" }).click();
    await dialogOf(page, "Vincular realizado").waitFor();
    await settle(page);
    await screenshot(page, `recorrencias-vincular-${suffix}`);
    await dialogOf(page, "Vincular realizado").getByRole("button", { name: "Vincular", exact: true }).click();
    await tableOf(page, "Cobranças que parecem recorrentes").waitFor();
    await settle(page, 700);
    await scrollDown(page);
    await screenshot(page, `recorrencias-candidatas-${suffix}`);
  });
});
