/**
 * Screenshots of Reembolsos e acertos in light and dark at each size (docs/18 §5.3), written to web/build/telas.
 *   pnpm --filter @opesvault/app screens
 */
import { test } from "@playwright/test";
import { openDemo, settle, tableOf } from "../helpers.ts";
import { forEachScreen, screenshot, pageShot } from "../shots.ts";

forEachScreen(({ size, suffix }) => {
  test("reembolsos", async ({ page }) => {
    // the web demonstration has a reimbursement and a debt between members (data/demo_extra.ts)
    await openDemo(page, "/reembolsos");
    await tableOf(page, "Saldos entre integrantes").waitFor();
    await settle(page, 700);
    await pageShot(page, size, `reembolsos-${suffix}`);

    await tableOf(page, "Reembolsos").getByText("Consulta pediatra").click();
    await settle(page, 300);
    await page.getByRole("button", { name: "Registrar recebimento…" }).click();
    await page.getByRole("dialog", { name: "Reembolso recebido" }).waitFor();
    await settle(page);
    await screenshot(page, `reembolsos-recebimento-${suffix}`);
    await page.getByRole("button", { name: "Cancelar" }).click();
    await page.getByRole("dialog").waitFor({ state: "hidden" });

    await page.getByRole("button", { name: "Registrar acerto…" }).click();
    const dialog = page.getByRole("dialog", { name: "Registrar acerto" });
    await dialog.waitFor();
    await settle(page);
    await screenshot(page, `reembolsos-acerto-${suffix}`);
    await dialog.getByLabel("Valor", { exact: true }).fill("30,00");
    await dialog.getByLabel("Observação").fill("Pix de sábado");
    await dialog.getByRole("button", { name: "Registrar", exact: true }).click();
    await dialog.waitFor({ state: "hidden" });
    await tableOf(page, "Acertos registrados").waitFor();
    await settle(page, 700);
    await pageShot(page, size, `reembolsos-acertos-registrados-${suffix}`);
  });
});
