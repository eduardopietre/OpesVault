/**
 * Screenshots of Contas e cartões in light and dark at each size (docs/18 §5.3), written to web/build/telas.
 *   pnpm --filter @opesvault/app screens
 */
import { test, type Page } from "@playwright/test";
import { openDemo, settle } from "../helpers.ts";
import { forEachScreen, screenshot } from "../shots.ts";

const TABS = [
  ["bancarias", "Contas bancárias"],
  ["contas", "Todas as contas"],
  ["cartoes", "Cartões"],
  ["faturas", "Faturas"],
  ["financiamentos", "Financiamentos"],
  ["categorias", "Categorias"],
  ["regras", "Regras"],
  ["integrantes", "Integrantes"],
] as const;

async function shot(page: Page, name: string, fullPage = true) {
  await settle(page, 500);
  await screenshot(page, `contas-${name}`, { fullPage });
}

forEachScreen(({ suffix }) => {
  test("contas e cartões", async ({ page }) => {
    await openDemo(page, "/contas");
    for (const [id, label] of TABS) {
      await page.getByRole("tab", { name: label }).click();
      if (id === "bancarias" || id === "contas" || id === "financiamentos") {
        await page
          .locator("canvas")
          .first()
          .waitFor({ timeout: 5000 })
          .catch(() => undefined);
      }
      await shot(page, `${id}-${suffix}`);
    }
    // dialogs
    await page.getByRole("tab", { name: "Contas bancárias" }).click();
    await page.getByRole("button", { name: "Nova conta bancária…" }).click();
    await shot(page, `dialogo-conta-bancaria-${suffix}`, false);
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Valores em uma data…" }).click();
    await shot(page, `dialogo-valores-${suffix}`, false);
    await page.keyboard.press("Escape");
    await page.getByRole("tab", { name: "Financiamentos" }).click();
    await page.getByRole("button", { name: "Novo financiamento…" }).click();
    await shot(page, `dialogo-financiamento-${suffix}`, false);
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Mais", exact: true }).click();
    await page.getByRole("menuitem", { name: /amortização antecipada/ }).click();
    await page.getByLabel("Valor da amortização").fill("10000");
    await shot(page, `dialogo-amortizacao-${suffix}`, false);
    await page.keyboard.press("Escape");
    await page.getByRole("tab", { name: "Faturas" }).click();
    await page.getByRole("button", { name: "Pagar…" }).click();
    await shot(page, `dialogo-pagar-fatura-${suffix}`, false);
  });
});
