/**
 * Screenshots of Documentos in light and dark at each size (docs/18 §5.3), written to web/build/telas.
 *   pnpm --filter @opesvault/app screens
 */
import { fileURLToPath } from "node:url";
import { test, type Page } from "@playwright/test";
import { SCHEMES, SIZES, openDemo, settle } from "../helpers.ts";
import { protectedPdf } from "./protected_pdf.ts";
import { attach, goTo, tableOf } from "./sharing_helpers.ts";

const PROTECTED = protectedPdf();

const OUT = fileURLToPath(new URL("../../../../build/telas/", import.meta.url));

/** The whole page in one picture: the shell scrolls inside the window, so the window is made tall for the shot. */
async function pageShot(page: Page, size: { width: number; height: number }, path: string) {
  await page.setViewportSize({ width: size.width, height: Math.max(size.height, 1500) });
  await settle(page, 900);
  await page.screenshot({ path });
  await page.setViewportSize(size);
  await settle(page, 300);
}
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

for (const size of SIZES) {
  for (const scheme of SCHEMES) {
    const suffix = `${size.width}x${size.height}-${scheme === "light" ? "claro" : "escuro"}`;
    test.describe(suffix, () => {
      test.use({ viewport: size, colorScheme: scheme, contextOptions: { reducedMotion: "reduce" } });
      const phone = size.width < 640;

      test("documentos", async ({ page }) => {
        await openDemo(page, "/documentos");
        await page.getByLabel("Páginas do documento").locator("canvas").first().waitFor();
        await settle(page, 900);
        await pageShot(page, size, `${OUT}documentos-${suffix}.png`);

        await goTo(page, "l", /\/livro$/);
        await page.locator("[data-row-id]").first().waitFor();
        await attach(page, "Posto Shell", { name: "recibo-posto.png", mimeType: "image/png", buffer: PNG });
        await attach(page, "Aluguel", { name: "protegido.pdf", mimeType: "application/pdf", buffer: PROTECTED });
        await goTo(page, "d", /\/documentos$/);
        const list = tableOf(page, "Documentos no projeto", phone);
        await list.getByText("recibo-posto.png").click();
        await page.getByRole("img", { name: "Documento recibo-posto.png" }).waitFor();
        await settle(page, 500);
        await pageShot(page, size, `${OUT}documentos-comprovante-${suffix}.png`);

        await list.getByText("protegido.pdf").click();
        await page.getByText("Este PDF é protegido por senha.").waitFor();
        await settle(page, 400);
        await pageShot(page, size, `${OUT}documentos-protegido-${suffix}.png`);
        await page.getByRole("button", { name: "Informar senha…" }).click();
        await page.getByRole("dialog", { name: "PDF protegido" }).waitFor();
        await settle(page);
        await page.screenshot({ path: `${OUT}documentos-senha-${suffix}.png` });
      });
    });
  }
}
