/**
 * Screenshots of Imposto de renda in light and dark at each size (docs/18 §5.3), written to web/build/telas.
 *   pnpm --filter @opesvault/app screens
 */
import { expect, test, type Page } from "@playwright/test";
import { settle } from "../helpers.ts";
import { forEachScreen, screenshot, pageShot } from "../shots.ts";

/** The demonstration project on the year its tax data is in. */
async function open(page: Page, year = 2026) {
  await page.goto(`/imposto-de-renda?demo&ref=year:${year}`);
  await expect(page.getByRole("heading", { level: 1, name: "Imposto de renda" })).toBeVisible();
  await expect(page.getByText(`(ano-calendário ${year})`, { exact: false })).toContainText(String(year));
}

forEachScreen(({ size, suffix }) => {
  test("imposto de renda", async ({ page }) => {
    await open(page);
    await settle(page, 700);
    await pageShot(page, size, `imposto-${suffix}`, 2600);

    await page
      .getByRole("button", { name: /^Informar CPF\/CNPJ… \(CPF\/CNPJ de quem recebeu: Consulta Pediatra\)/ })
      .click();
    const taxId = page.getByRole("dialog", { name: "CPF ou CNPJ" });
    await taxId.waitFor();
    await taxId.getByLabel("CPF ou CNPJ").fill("11222333000180");
    await settle(page);
    await screenshot(page, `imposto-cpf-cnpj-${suffix}`);
    await page.keyboard.press("Escape");
    await taxId.waitFor({ state: "hidden" });

    await page.getByRole("button", { name: "Cadastros" }).click();
    await page.getByRole("menuitem", { name: "Tabela e limites do ano…" }).click();
    const params = page.getByRole("dialog", { name: "Tabela e limites de 2026" });
    await params.waitFor();
    await settle(page);
    await screenshot(page, `imposto-tabela-${suffix}`);
    await page.keyboard.press("Escape");
    await params.waitFor({ state: "hidden" });

    await page.getByRole("button", { name: "Mais", exact: true }).click();
    await page.getByRole("menuitem", { name: "Novo informe sem arquivo…" }).click();
    const report = page.getByRole("dialog", { name: "Informe de rendimentos" });
    await report.waitFor();
    await report.getByRole("button", { name: "Adicionar linha" }).click();
    await settle(page);
    await screenshot(page, `imposto-informe-${suffix}`);
    await page.keyboard.press("Escape");
    await report.waitFor({ state: "hidden" });

    await page.getByRole("button", { name: "Cadastros" }).click();
    await page.getByRole("menuitem", { name: "Natureza dos rendimentos…" }).click();
    const nature = page.getByRole("dialog", { name: "Natureza dos rendimentos" });
    await nature.waitFor();
    await settle(page);
    await screenshot(page, `imposto-natureza-${suffix}`);
    await page.keyboard.press("Escape");
    await nature.waitFor({ state: "hidden" });
  });

  test("relatório para a declaração", async ({ page }) => {
    await page.goto("/imposto-de-renda?demo&ref=year:2026");
    await expect(page.getByRole("heading", { level: 1, name: "Imposto de renda" })).toBeVisible();
    await page
      .getByRole("button", { name: "Declarante" })
      .or(page.getByRole("combobox", { name: "Declarante" }))
      .first()
      .click();
    await page.getByRole("option", { name: "Ana", exact: true }).click();
    await page.getByRole("button", { name: "Mais", exact: true }).click();
    await page.evaluate(() => {
      window.print = () => undefined;
    });
    await page.getByRole("menuitem", { name: "Relatório para a declaração (PDF)…" }).click();
    await expect(page).toHaveURL(/\/imprimir\/imposto/);
    await expect(page.getByRole("heading", { level: 1 })).toContainText("imposto de renda");
    await settle(page, 700);
    await pageShot(page, size, `imposto-relatorio-${suffix}`, 2600);
  });
});
