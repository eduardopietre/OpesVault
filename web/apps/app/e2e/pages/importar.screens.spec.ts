/**
 * Screenshots of Importar e revisar in light and dark at each size (docs/18 §5.3), written to web/build/telas.
 *   pnpm --filter @opesvault/app screens
 */
import { test } from "@playwright/test";
import { openDemo, settle, tableOf } from "../helpers.ts";
import { AMBIGUOUS, CSV, ITAU, OFX, PROTECTED, chooseFiles, readNotice } from "./importar_helpers.ts";
import { fakeOllama } from "./livro_helpers.ts";
import { forEachScreen, screenshot, pageShot } from "../shots.ts";

forEachScreen(({ size, suffix }) => {
  test("importar", async ({ page }) => {
    await fakeOllama(page);
    await openDemo(page, "/importar");
    await page.getByRole("region", { name: "Página do documento" }).locator("canvas").waitFor();
    await settle(page, 900);
    await pageShot(page, size, `importar-${suffix}`);

    // an item selected: its evidence boxed on the page, and the rule offered after a hand-picked category
    const target = tableOf(page, "Itens extraídos").locator("[data-row-id]").filter({ hasText: "Loja Eletro" });
    await target.getByText("Loja Eletro", { exact: true }).click();
    await page.getByRole("combobox", { name: "Categoria ou conta de Loja Eletro" }).click();
    await page.getByRole("option", { name: "Lazer", exact: true }).click();
    await page.locator("[data-evidence-box]").waitFor();
    await pageShot(page, size, `importar-evidencia-${suffix}`);

    // files read: a two-page PDF, an OFX with no account, a CSV, then one the person has to give a layout
    await chooseFiles(page, [ITAU, OFX, CSV, AMBIGUOUS]);
    await readNotice(page, "dois-layouts.csv").waitFor();
    await pageShot(page, size, `importar-layout-${suffix}`);

    // the refusal of a repeated file stays in view, with the way to dismiss it
    await chooseFiles(page, [OFX]);
    await page
      .getByRole("region", { name: "Arquivos em leitura" })
      .or(page.getByLabel("Arquivos em leitura"))
      .waitFor();
    await pageShot(page, size, `importar-recusado-${suffix}`);
    await page.getByRole("button", { name: /^Dispensar/ }).click();

    // a protected PDF asks for its password
    await chooseFiles(page, [PROTECTED]);
    await page.getByRole("dialog", { name: "PDF protegido" }).waitFor();
    await settle(page);
    await screenshot(page, `importar-senha-${suffix}`);
    await page.getByRole("dialog", { name: "PDF protegido" }).getByRole("button", { name: "Cancelar" }).click();

    // the supported layouts
    await page.getByRole("button", { name: "Layouts suportados" }).click();
    await page.getByRole("dialog", { name: "Layouts suportados" }).waitFor();
    await settle(page);
    await screenshot(page, `importar-layouts-${suffix}`);
  });
});
