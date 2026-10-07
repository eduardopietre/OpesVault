/**
 * Screenshots of Relatórios in light and dark at each size (docs/18 §5.3), written to web/build/telas.
 *   pnpm --filter @opesvault/app screens
 */
import { test, type Page } from "@playwright/test";
import { openDemo, settle } from "../helpers.ts";
import { forEachScreen, screenshot } from "../shots.ts";

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

forEachScreen(({ suffix }) => {
  test("relatórios", async ({ page }) => {
    await openDemo(page, "/relatorios");
    await page.locator("canvas").first().waitFor();
    await settle(page, 900);
    await screenshot(page, `relatorios-${suffix}`, { fullPage: true });
    // a point chosen: described beside the chart
    await page
      .getByRole("table", { name: /^Valores de / })
      .getByRole("button")
      .last()
      .click();
    await settle(page, 400);
    await screenshot(page, `relatorios-ponto-${suffix}`, { fullPage: true });
    await pick(page, "Saldo projetado");
    await screenshot(page, `relatorios-saldo-${suffix}`, { fullPage: true });
    await pick(page, "Despesas por categoria");
    await screenshot(page, `relatorios-categorias-${suffix}`, { fullPage: true });
    await pick(page, "Despesas por estabelecimento");
    await screenshot(page, `relatorios-estabelecimentos-${suffix}`, { fullPage: true });
    await pick(page, "Composição da carteira");
    await screenshot(page, `relatorios-carteira-${suffix}`, { fullPage: true });
    await pick(page, "Projeção de compromissos");
    await screenshot(page, `relatorios-compromissos-${suffix}`, { fullPage: true });
    await pick(page, "Despesas dedutíveis");
    await screenshot(page, `relatorios-dedutiveis-${suffix}`, { fullPage: true });
    await page.getByRole("combobox", { name: "Ano", exact: true }).click();
    await page.getByRole("option", { name: /Ano de 2025/ }).click();
    await settle(page, 400);
    await screenshot(page, `relatorios-vazio-${suffix}`, { fullPage: true });
    await pick(page, "Fechamento do ano");
    await screenshot(page, `relatorios-fechamento-${suffix}`, { fullPage: true });
  });

  test("relatório anual", async ({ page }) => {
    await openDemo(page, "/imprimir/relatorio-anual");
    await page.getByRole("heading", { level: 1 }).waitFor();
    await settle(page, 400);
    await screenshot(page, `relatorio-anual-${suffix}`, { fullPage: true });
  });
});
