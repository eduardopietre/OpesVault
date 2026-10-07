/**
 * Screenshots of the Livro in light and dark at 1920, 1280, 900 and 390 (docs/18 §5.3), written to
 * web/build/telas with the other screens, for review.
 *   pnpm --filter @opesvault/app screens
 */
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import { SCHEMES, openDemo, settle } from "../helpers.ts";
import { fakeOllama, pickRow } from "./livro_helpers.ts";

const OUT = fileURLToPath(new URL("../../../../build/telas/", import.meta.url));
const SIZES = [
  { width: 1920, height: 1080 },
  { width: 1280, height: 800 },
  { width: 900, height: 640 },
  { width: 390, height: 844 },
] as const;

async function closeOverlay(page: Page, name: string | RegExp): Promise<void> {
  await page.getByRole("dialog", { name }).getByRole("button", { name: "Fechar" }).click();
  await expect(page.getByRole("dialog", { name })).toHaveCount(0);
}

for (const size of SIZES) {
  for (const scheme of SCHEMES) {
    const suffix = `${size.width}x${size.height}-${scheme === "light" ? "claro" : "escuro"}`;
    test.describe(`livro ${suffix}`, () => {
      test.use({ viewport: size, colorScheme: scheme, contextOptions: { reducedMotion: "reduce" } });

      test("tela, detalhes e diálogos", async ({ page }) => {
        await fakeOllama(page);
        await openDemo(page, "/livro");
        await expect(page.locator("[data-row-id]").first()).toBeVisible();
        await settle(page);
        await page.screenshot({ path: `${OUT}livro-${suffix}.png` });

        // The details of a row: beside the table when wide, a sheet otherwise.
        await pickRow(page, "Mercado do mês");
        if (size.width >= 640 && size.width < 1440) await page.getByRole("button", { name: "Detalhes" }).click();
        await settle(page);
        await page.screenshot({ path: `${OUT}livro-detalhes-${suffix}.png` });
        if (size.width < 1440) await closeOverlay(page, "Detalhes do lançamento");

        await page.getByRole("button", { name: "Novo lançamento" }).click();
        await page.getByRole("menuitem", { name: "Despesa" }).click();
        const dialog = page.getByRole("dialog", { name: "Despesa" });
        await dialog.waitFor();
        await dialog.getByLabel("Descrição").fill("Padaria da esquina");
        await settle(page, 300);
        await page.screenshot({ path: `${OUT}livro-nova-despesa-${suffix}.png` });
        await dialog.getByRole("button", { name: "Cancelar" }).click();
      });

      test("edição completa e sugestões da IA local", async ({ page }) => {
        await fakeOllama(page);
        await openDemo(page, "/livro");
        await pickRow(page, "Aluguel");
        // On a phone the details sheet holds the commands; elsewhere the page's own bar does.
        const actions = size.width < 640 ? "Mais ações" : "Ações";
        await page.getByRole("button", { name: actions, exact: true }).click();
        await page.getByRole("menuitem", { name: "Corrigir partidas…" }).click();
        const dialog = page.getByRole("dialog", { name: "Editar lançamento" });
        await dialog.waitFor();
        await settle(page, 300);
        await page.screenshot({ path: `${OUT}livro-corrigir-partidas-${suffix}.png` });
        await dialog.getByRole("button", { name: "Cancelar" }).click();
        if (size.width < 640) await closeOverlay(page, "Detalhes do lançamento");

        await page.getByRole("searchbox", { name: "Buscar lançamentos" }).fill("");
        // On a phone the local AI is a group of the one "Mais comandos" menu of the toolbar.
        await page.getByRole("button", { name: size.width < 640 ? "Mais comandos" : "IA local", exact: true }).click();
        await page.getByRole("menuitem", { name: "Sugerir categorias…" }).click();
        const review = page.getByRole("dialog", { name: "Sugestões de categoria" });
        await review.waitFor({ timeout: 15_000 });
        await settle(page, 300);
        await page.screenshot({ path: `${OUT}livro-ia-${suffix}.png` });
      });
    });
  }
}
