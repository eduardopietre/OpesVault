/**
 * Screenshots of Documentos in light and dark at each size (docs/18 §5.3), written to web/build/telas.
 *   pnpm --filter @opesvault/app screens
 */
import { test } from "@playwright/test";
import { openDemo, settle, goTo, tableOf, ONE_PIXEL_PNG } from "../helpers.ts";
import { protectedPdf } from "../protected_pdf.ts";
import { attach } from "./sharing_helpers.ts";
import { forEachScreen, screenshot, pageShot } from "../shots.ts";

const PROTECTED = protectedPdf();

forEachScreen(({ size, suffix }) => {
  const phone = size.width < 640;

  test("documentos", async ({ page }) => {
    await openDemo(page, "/documentos");
    await page.getByLabel("Páginas do documento").locator("canvas").first().waitFor();
    await settle(page, 900);
    await pageShot(page, size, `documentos-${suffix}`);

    await goTo(page, "l", /\/livro$/);
    await page.locator("[data-row-id]").first().waitFor();
    await attach(page, "Posto Shell", { name: "recibo-posto.png", mimeType: "image/png", buffer: ONE_PIXEL_PNG });
    await attach(page, "Aluguel", { name: "protegido.pdf", mimeType: "application/pdf", buffer: PROTECTED });
    await goTo(page, "d", /\/documentos$/);
    const list = tableOf(page, "Documentos no projeto", phone);
    await list.getByText("recibo-posto.png").click();
    await page.getByRole("img", { name: "Documento recibo-posto.png" }).waitFor();
    await settle(page, 500);
    await pageShot(page, size, `documentos-comprovante-${suffix}`);

    await list.getByText("protegido.pdf").click();
    await page.getByText("Este PDF é protegido por senha.").waitFor();
    await settle(page, 400);
    await pageShot(page, size, `documentos-protegido-${suffix}`);
    await page.getByRole("button", { name: "Informar senha…" }).click();
    await page.getByRole("dialog", { name: "PDF protegido" }).waitFor();
    await settle(page);
    await screenshot(page, `documentos-senha-${suffix}`);
  });
});
