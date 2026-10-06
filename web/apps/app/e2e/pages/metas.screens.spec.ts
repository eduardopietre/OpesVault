/**
 * Screenshots of Metas in light and dark at each size (docs/18 §5.3), written to web/build/telas.
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

      test("metas", async ({ page }) => {
        await openDemo(page, "/metas");
        await page.locator("canvas").first().waitFor();
        await settle(page, 900);
        await page.screenshot({ path: `${OUT}metas-${suffix}.png` });
        await page.evaluate(() => document.getElementById("conteudo")?.scrollTo(0, 1e6));
        await settle(page, 500);
        await page.screenshot({ path: `${OUT}metas-fim-${suffix}.png` });
        await page.evaluate(() => document.getElementById("conteudo")?.scrollTo(0, 0));
        await page.getByRole("button", { name: "Nova meta…" }).click();
        await page.getByRole("dialog").waitFor();
        await page.getByLabel("Nome").fill("Viagem");
        await page.getByRole("button", { name: "Criar meta" }).click();
        await settle(page);
        await page.screenshot({ path: `${OUT}metas-nova-${suffix}.png` });
        await page.keyboard.press("Escape");
        await page.getByRole("dialog").waitFor({ state: "hidden" });
        await page.getByRole("button", { name: "Editar meta…" }).click();
        await page.getByRole("dialog").waitFor();
        await settle(page);
        await page.screenshot({ path: `${OUT}metas-editar-${suffix}.png` });
      });
    });
  }
}
