/**
 * Screenshots of Relatórios in light and dark at each size (docs/18 §5.3), written to web/build/telas.
 *   pnpm --filter @opesvault/app screens
 */
import { fileURLToPath } from "node:url";
import { test, type Page } from "@playwright/test";
import { SCHEMES, SIZES, openDemo, settle } from "../helpers.ts";

const OUT = fileURLToPath(new URL("../../../../build/telas/", import.meta.url));

async function pick(page: Page, label: string) {
  const list = page.getByRole("navigation", { name: "Relatórios" });
  if (await list.isVisible()) {
    await list.getByRole("button", { name: label, exact: true }).click();
  } else {
    await page.getByRole("combobox", { name: "Relatório", exact: true }).click();
    await page.getByRole("option", { name: label, exact: true }).click();
  }
  await page.locator("canvas").first().waitFor();
  await settle(page, 900);
}

for (const size of SIZES) {
  for (const scheme of SCHEMES) {
    const suffix = `${size.width}x${size.height}-${scheme === "light" ? "claro" : "escuro"}`;
    test.describe(suffix, () => {
      test.use({ viewport: size, colorScheme: scheme, contextOptions: { reducedMotion: "reduce" } });

      test("relatórios", async ({ page }) => {
        await openDemo(page, "/relatorios");
        await page.locator("canvas").first().waitFor();
        await settle(page, 900);
        await page.screenshot({ path: `${OUT}relatorios-${suffix}.png`, fullPage: true });
        // a point chosen: described beside the chart
        await page
          .getByRole("table", { name: /^Valores de / })
          .getByRole("button")
          .last()
          .click();
        await settle(page, 400);
        await page.screenshot({ path: `${OUT}relatorios-ponto-${suffix}.png`, fullPage: true });
        await pick(page, "Saldo projetado");
        await page.screenshot({ path: `${OUT}relatorios-saldo-${suffix}.png`, fullPage: true });
        await pick(page, "Despesas por categoria");
        await page.screenshot({ path: `${OUT}relatorios-categorias-${suffix}.png`, fullPage: true });
        await pick(page, "Despesas dedutíveis");
        await page.screenshot({ path: `${OUT}relatorios-dedutiveis-${suffix}.png`, fullPage: true });
        await page.getByRole("combobox", { name: "Ano", exact: true }).click();
        await page.getByRole("option", { name: /Ano de 2025/ }).click();
        await settle(page, 400);
        await page.screenshot({ path: `${OUT}relatorios-vazio-${suffix}.png`, fullPage: true });
        await pick(page, "Fechamento do ano").catch(() => undefined);
      });

      test("relatório anual", async ({ page }) => {
        await openDemo(page, "/imprimir/relatorio-anual");
        await page.getByRole("heading", { level: 1 }).waitFor();
        await settle(page, 400);
        await page.screenshot({ path: `${OUT}relatorio-anual-${suffix}.png`, fullPage: true });
      });
    });
  }
}
