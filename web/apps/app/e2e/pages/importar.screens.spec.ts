/**
 * Screenshots of Importar e revisar in light and dark at each size (docs/18 §5.3), written to web/build/telas.
 *   pnpm --filter @opesvault/app screens
 */
import { fileURLToPath } from "node:url";
import { test, type Page } from "@playwright/test";
import { SCHEMES, SIZES, openDemo, settle } from "../helpers.ts";
import { AMBIGUOUS, CSV, ITAU, OFX, PROTECTED, chooseFiles, readNotice } from "./importar_helpers.ts";
import { fakeOllama } from "./livro_helpers.ts";
import { tableOf } from "../helpers.ts";

const OUT = fileURLToPath(new URL("../../../../build/telas/", import.meta.url));

/** The whole page in one picture: the shell scrolls inside the window, so the window is made tall for the shot. */
async function pageShot(page: Page, size: { width: number; height: number }, path: string) {
  await page.setViewportSize({ width: size.width, height: Math.max(size.height, 1500) });
  await settle(page, 900);
  await page.screenshot({ path });
  await page.setViewportSize(size);
  await settle(page, 300);
}

for (const size of SIZES) {
  for (const scheme of SCHEMES) {
    const suffix = `${size.width}x${size.height}-${scheme === "light" ? "claro" : "escuro"}`;
    test.describe(suffix, () => {
      test.use({ viewport: size, colorScheme: scheme, contextOptions: { reducedMotion: "reduce" } });

      test("importar", async ({ page }) => {
        await fakeOllama(page);
        await openDemo(page, "/importar");
        await page.getByRole("region", { name: "Página do documento" }).locator("canvas").waitFor();
        await settle(page, 900);
        await pageShot(page, size, `${OUT}importar-${suffix}.png`);

        // an item selected: its evidence boxed on the page, and the rule offered after a hand-picked category
        const target = tableOf(page, "Itens extraídos").locator("[data-row-id]").filter({ hasText: "Loja Eletro" });
        await target.getByText("Loja Eletro", { exact: true }).click();
        await page.getByRole("combobox", { name: "Categoria ou conta de Loja Eletro" }).click();
        await page.getByRole("option", { name: "Lazer", exact: true }).click();
        await page.locator("[data-evidence-box]").waitFor();
        await pageShot(page, size, `${OUT}importar-evidencia-${suffix}.png`);

        // files read: a two-page PDF, an OFX with no account, a CSV, then one the person has to give a layout
        await chooseFiles(page, [ITAU, OFX, CSV, AMBIGUOUS]);
        await readNotice(page, "dois-layouts.csv").waitFor();
        await pageShot(page, size, `${OUT}importar-layout-${suffix}.png`);

        // the refusal of a repeated file stays in view, with the way to dismiss it
        await chooseFiles(page, [OFX]);
        await page
          .getByRole("region", { name: "Arquivos em leitura" })
          .or(page.getByLabel("Arquivos em leitura"))
          .waitFor();
        await pageShot(page, size, `${OUT}importar-recusado-${suffix}.png`);
        await page.getByRole("button", { name: /^Dispensar/ }).click();

        // a protected PDF asks for its password
        await chooseFiles(page, [PROTECTED]);
        await page.getByRole("dialog", { name: "PDF protegido" }).waitFor();
        await settle(page);
        await page.screenshot({ path: `${OUT}importar-senha-${suffix}.png` });
        await page.getByRole("dialog", { name: "PDF protegido" }).getByRole("button", { name: "Cancelar" }).click();

        // the supported layouts
        await page.getByRole("button", { name: "Layouts suportados" }).click();
        await page.getByRole("dialog", { name: "Layouts suportados" }).waitFor();
        await settle(page);
        await page.screenshot({ path: `${OUT}importar-layouts-${suffix}.png` });
      });
    });
  }
}
