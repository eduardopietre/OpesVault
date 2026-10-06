/** Helpers of the Documentos end-to-end tests and screenshots (the shared ones live in `../helpers.ts`). */
import { expect, type Page } from "@playwright/test";
import { pickRow } from "./livro_helpers.ts";

/** Attaches a receipt to the first operation that matches `description`, the way the Livro does it. */
export async function attach(
  page: Page,
  description: string,
  file: { name: string; mimeType: string; buffer: Buffer },
) {
  await pickRow(page, description);
  await page.getByLabel("Escolher o comprovante").setInputFiles(file);
  await expect(page.getByText(/anexado/i).first()).toBeVisible();
  // on a phone the details are a sheet that covers the search box
  const sheet = page.getByRole("dialog", { name: "Detalhes do lançamento" });
  if (await sheet.isVisible()) {
    await sheet.getByRole("button", { name: "Fechar" }).first().click();
    await expect(sheet).toHaveCount(0);
  }
}
