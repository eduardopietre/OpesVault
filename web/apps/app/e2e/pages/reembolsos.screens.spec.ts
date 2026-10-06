/**
 * Screenshots of Reembolsos e acertos in light and dark at each size (docs/18 §5.3), written to web/build/telas.
 *   pnpm --filter @opesvault/app screens
 */
import { fileURLToPath } from "node:url";
import { test, type Page } from "@playwright/test";
import { SCHEMES, SIZES, openDemo, settle } from "../helpers.ts";
import { goTo, shareAnExpense, tableOf } from "./sharing_helpers.ts";

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
      const phone = size.width < 640;

      test("reembolsos", async ({ page }) => {
        await openDemo(page, "/reembolsos");
        await settle(page, 700);
        await pageShot(page, size, `${OUT}reembolsos-so-reembolso-${suffix}.png`);

        await openDemo(page, "/livro");
        await page.locator("[data-row-id]").first().waitFor();
        await shareAnExpense(page);
        await goTo(page, "b", /\/reembolsos$/);
        await tableOf(page, "Saldos entre integrantes", phone).waitFor();
        await settle(page, 700);
        await pageShot(page, size, `${OUT}reembolsos-${suffix}.png`);

        await tableOf(page, "Reembolsos", phone).getByText("Consulta pediatra").click();
        await settle(page, 300);
        await page.getByRole("button", { name: "Registrar recebimento…" }).click();
        await page.getByRole("dialog", { name: "Reembolso recebido" }).waitFor();
        await settle(page);
        await page.screenshot({ path: `${OUT}reembolsos-recebimento-${suffix}.png` });
        await page.getByRole("button", { name: "Cancelar" }).click();
        await page.getByRole("dialog").waitFor({ state: "hidden" });

        await page.getByRole("button", { name: "Registrar acerto…" }).click();
        const dialog = page.getByRole("dialog", { name: "Registrar acerto" });
        await dialog.waitFor();
        await settle(page);
        await page.screenshot({ path: `${OUT}reembolsos-acerto-${suffix}.png` });
        await dialog.getByLabel("Valor", { exact: true }).fill("30,00");
        await dialog.getByLabel("Observação").fill("Pix de sábado");
        await dialog.getByRole("button", { name: "Registrar", exact: true }).click();
        await dialog.waitFor({ state: "hidden" });
        await tableOf(page, "Acertos registrados", phone).waitFor();
        await settle(page, 700);
        await pageShot(page, size, `${OUT}reembolsos-acertos-registrados-${suffix}.png`);
      });
    });
  }
}
