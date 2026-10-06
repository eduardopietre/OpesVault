/**
 * Screenshots of Imposto de renda in light and dark at each size (docs/18 §5.3), written to web/build/telas.
 *   pnpm --filter @opesvault/app screens
 */
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import { SCHEMES, SIZES, settle } from "../helpers.ts";

const OUT = fileURLToPath(new URL("../../../../build/telas/", import.meta.url));

/** The whole page in one picture: the shell scrolls inside the window, so the window is made tall for the shot. */
async function pageShot(page: Page, size: { width: number; height: number }, path: string) {
  await page.setViewportSize({ width: size.width, height: Math.max(size.height, 2600) });
  await settle(page, 900);
  await page.screenshot({ path });
  await page.setViewportSize(size);
  await settle(page, 300);
}

/** The demonstration project on the year its tax data is in. */
async function open(page: Page, year = 2026) {
  await page.goto(`/imposto-de-renda?demo&ref=year:${year}`);
  await expect(page.getByRole("heading", { level: 1, name: "Imposto de renda" })).toBeVisible();
  await expect(page.getByText(`(ano-calendário ${year})`, { exact: false })).toContainText(String(year));
}

for (const size of SIZES) {
  for (const scheme of SCHEMES) {
    const suffix = `${size.width}x${size.height}-${scheme === "light" ? "claro" : "escuro"}`;
    test.describe(suffix, () => {
      test.use({ viewport: size, colorScheme: scheme, contextOptions: { reducedMotion: "reduce" } });

      test("imposto de renda", async ({ page }) => {
        await open(page);
        await settle(page, 700);
        await pageShot(page, size, `${OUT}imposto-${suffix}.png`);

        await page
          .getByRole("button", { name: /^Informar CPF\/CNPJ… \(CPF\/CNPJ de quem recebeu: Consulta Pediatra\)/ })
          .click();
        const taxId = page.getByRole("dialog", { name: "CPF ou CNPJ" });
        await taxId.waitFor();
        await taxId.getByLabel("CPF ou CNPJ").fill("11222333000180");
        await settle(page);
        await page.screenshot({ path: `${OUT}imposto-cpf-cnpj-${suffix}.png` });
        await page.keyboard.press("Escape");
        await taxId.waitFor({ state: "hidden" });

        await page.getByRole("button", { name: "Cadastros" }).click();
        await page.getByRole("menuitem", { name: "Tabela e limites do ano…" }).click();
        const params = page.getByRole("dialog", { name: "Tabela e limites de 2026" });
        await params.waitFor();
        await settle(page);
        await page.screenshot({ path: `${OUT}imposto-tabela-${suffix}.png` });
        await page.keyboard.press("Escape");
        await params.waitFor({ state: "hidden" });

        await page.getByRole("button", { name: "Mais", exact: true }).click();
        await page.getByRole("menuitem", { name: "Novo informe sem arquivo…" }).click();
        const report = page.getByRole("dialog", { name: "Informe de rendimentos" });
        await report.waitFor();
        await report.getByRole("button", { name: "Adicionar linha" }).click();
        await settle(page);
        await page.screenshot({ path: `${OUT}imposto-informe-${suffix}.png` });
        await page.keyboard.press("Escape");
        await report.waitFor({ state: "hidden" });

        await page.getByRole("button", { name: "Cadastros" }).click();
        await page.getByRole("menuitem", { name: "Natureza dos rendimentos…" }).click();
        const nature = page.getByRole("dialog", { name: "Natureza dos rendimentos" });
        await nature.waitFor();
        await settle(page);
        await page.screenshot({ path: `${OUT}imposto-natureza-${suffix}.png` });
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
        await pageShot(page, size, `${OUT}imposto-relatorio-${suffix}.png`);
      });
    });
  }
}
