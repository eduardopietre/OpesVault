/**
 * Screenshots of Investimentos in light and dark at each size (docs/18 §5.3), written to web/build/telas.
 *   pnpm --filter @opesvault/app screens
 */
import { expect, test, type Page } from "@playwright/test";
import { openDemo, settle } from "../helpers.ts";
import { field } from "./investimentos_helpers.ts";
import { menu, submit } from "../ui.ts";
import { forEachScreen, screenshot } from "../shots.ts";

async function shot(page: Page, name: string, fullPage = true) {
  await settle(page, 600);
  await screenshot(page, `investimentos-${name}`, { fullPage });
}

/** The page scrolls inside the shell: one picture per screenful, to the end. */
async function shots(page: Page, name: string) {
  await shot(page, `${name}-1`);
  const [height, view] = await page.evaluate(() => {
    const body = document.getElementById("conteudo")!;
    return [body.scrollHeight, body.clientHeight] as const;
  });
  for (let part = 2, at = view - 80; at < height - 40 && part <= 5; part++, at += view - 80) {
    await page.evaluate((top) => document.getElementById("conteudo")?.scrollTo(0, top), at);
    await shot(page, `${name}-${part}`);
  }
  await page.evaluate(() => document.getElementById("conteudo")?.scrollTo(0, 0));
}

forEachScreen(({ suffix }) => {
  test("investimentos", async ({ page }) => {
    await openDemo(page, "/investimentos");
    await expect(page.getByRole("heading", { level: 2, name: "CDB Banco X 2028" })).toBeVisible();
    await page
      .locator("canvas")
      .first()
      .waitFor({ timeout: 5000 })
      .catch(() => undefined);
    await expect(page.getByText("calculando…")).toHaveCount(0, { timeout: 20_000 });
    await shots(page, `carteira-${suffix}`);

    // a tax rule and an aporte, so the chart carries a marker and the simulator has a rule
    await menu(page, "Registrar", "Aporte…");
    let dialog = page.getByRole("dialog");
    await field(dialog, "Data").fill("15/02/2026");
    await field(dialog, "Valor").fill("500,00");
    await shot(page, `dialogo-aporte-${suffix}`, false);
    await submit(dialog, "Registrar");
    await expect(dialog).toBeHidden();
    await menu(page, "Mais", "Regra de imposto…");
    dialog = page.getByRole("dialog");
    await field(dialog, "Nome").fill("Regra fictícia 15%");
    await field(dialog, "Alíquota (%)").fill("15");
    await submit(dialog, "Salvar");
    await expect(dialog).toBeHidden();
    await expect(page.getByText("calculando…")).toHaveCount(0, { timeout: 20_000 });
    await shots(page, `com-aporte-${suffix}`);

    await menu(page, "Registrar", /Simular resgate/);
    dialog = page.getByRole("dialog");
    await field(dialog, "Valor bruto a resgatar").fill("1.000,00");
    await field(dialog, "Taxas").fill("10,00");
    await submit(dialog, "Simular");
    await expect(dialog.getByRole("region", { name: "Resultado da simulação" })).toBeVisible();
    await shot(page, `dialogo-simulador-${suffix}`, false);
    await page.keyboard.press("Escape");

    await menu(page, "Registrar", "Avaliação…");
    await shot(page, `dialogo-avaliacao-${suffix}`, false);
    await page.keyboard.press("Escape");
    await menu(page, "Mais", /^Características/);
    await shot(page, `dialogo-caracteristicas-${suffix}`, false);
  });
});
