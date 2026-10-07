/**
 * Screenshots of Orçamento in light and dark at each size (docs/18 §5.3), written to web/build/telas.
 *   pnpm --filter @opesvault/app screens
 */
import { fileURLToPath } from "node:url";
import { test } from "@playwright/test";
import { SCHEMES, SIZES, openDemo, settle } from "../helpers.ts";

const OUT = fileURLToPath(new URL("../../../../build/telas/", import.meta.url));

for (const size of SIZES) {
  for (const scheme of SCHEMES) {
    const suffix = `${size.width}x${size.height}-${scheme === "light" ? "claro" : "escuro"}`;
    test.describe(suffix, () => {
      test.use({ viewport: size, colorScheme: scheme, contextOptions: { reducedMotion: "reduce" } });

      test("orçamento", async ({ page }) => {
        await openDemo(page, "/orcamento");
        await page.locator("canvas").first().waitFor();
        await settle(page, 900);
        await page.screenshot({ path: `${OUT}orcamento-${suffix}.png`, fullPage: true });
        const table = page.getByRole(size.width < 640 ? "listbox" : "grid", { name: "Orçamento por categoria" });
        await table.getByText("Transporte").first().click();
        await settle(page, 400);
        await page.screenshot({ path: `${OUT}orcamento-selecao-${suffix}.png`, fullPage: true });
        await page.getByRole("button", { name: "Orçamento do mês…" }).click();
        await page.getByRole("dialog").waitFor();
        await settle(page);
        await page.screenshot({ path: `${OUT}orcamento-grade-${suffix}.png` });
        await page.keyboard.press("Escape");
        await page.getByRole("dialog").waitFor({ state: "hidden" });
        await page.getByRole("button", { name: "Mês anterior", exact: true }).click();
        await page.getByRole("button", { name: "Mês anterior", exact: true }).click();
        await page.getByRole("button", { name: "Mês anterior", exact: true }).click();
        await page.getByRole("heading", { name: /^Sem orçamento em / }).waitFor();
        await settle(page);
        await page.screenshot({ path: `${OUT}orcamento-vazio-${suffix}.png`, fullPage: true });
      });
    });
  }
}
