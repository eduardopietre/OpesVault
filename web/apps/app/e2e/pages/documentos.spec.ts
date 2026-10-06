/**
 * Documentos end to end (docs/18 §5, SCREENS.md): the demonstration's imported statement plus receipts attached
 * in the Livro (an image, a PDF and a password-protected PDF), drawn by the real pdf.js; every button, every
 * dialog, no console errors, no sideways scroll at the five sizes, axe clean, light and dark.
 */
import { expect, test } from "@playwright/test";
import {
  SCHEMES,
  SIZES,
  expectNoHorizontalOverflow,
  openDemo,
  recordAddresses,
  settle,
  watchErrors,
} from "../helpers.ts";
import { protectedPdf } from "../protected_pdf.ts";
import { attach } from "./sharing_helpers.ts";
import { audit, goTo, tableOf } from "../helpers.ts";

const PROTECTED = protectedPdf();

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

/** A valid one-page PDF with a line of text and a correct cross-reference table. */
function onePagePdf(line: string): Buffer {
  const stream = `BT /F1 18 Tf 60 760 Td (${line}) Tj ET`;
  const bodies = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [4 0 R] /Count 1 >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 5 0 R /Resources << /Font << /F1 3 0 R >> >> >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
  ];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  bodies.forEach((body, index) => {
    offsets.push(out.length);
    out += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${bodies.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) out += `${String(offset).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${bodies.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

for (const size of SIZES) {
  for (const scheme of SCHEMES) {
    test.describe(`documentos ${size.width}x${size.height} ${scheme}`, () => {
      test.use({ viewport: size, colorScheme: scheme, contextOptions: { reducedMotion: "reduce" } });
      const phone = size.width < 640;

      test("every button and dialog works, cleanly", async ({ page }) => {
        const errors = watchErrors(page);
        const addresses = await recordAddresses(page);
        await openDemo(page, "/documentos");

        // the imported statement is the first document and is drawn by pdf.js
        const list = tableOf(page, "Documentos no projeto", phone);
        await expect(list.getByText("fatura-nubank-03.pdf")).toBeVisible();
        const pages = page.getByLabel("Páginas do documento");
        await expect(pages.locator("canvas").first()).toBeVisible();
        await expect(page.getByText("1 página", { exact: true })).toBeVisible();
        await expect(page.getByText(/Importação \(/)).toBeVisible();
        await settle(page);
        await expectNoHorizontalOverflow(page);
        await audit(page, "documentos");

        // Ver importação leads to the batch in Importar, and back
        await page.getByRole("button", { name: "Ver importação" }).click();
        await expect.poll(async () => (await addresses()).some((u) => /\/importar\?.*ref=/.test(u))).toBe(true);
        await page.goBack();
        await expect(page.getByRole("heading", { level: 1, name: "Documentos" })).toBeVisible();

        // a used document cannot be removed, and says why
        await expect(page.getByRole("button", { name: "Remover…" })).toBeDisabled();
        await expect(page.getByText(/Em uso por uma importação/)).toBeVisible();

        // receipts attached in the Livro: an image, a PDF and a protected PDF
        await goTo(page, "l", /\/livro$/);
        await expect(page.locator("[data-row-id]").first()).toBeVisible();
        await attach(page, "Posto Shell", { name: "recibo-posto.png", mimeType: "image/png", buffer: PNG });
        await attach(page, "Aluguel", {
          name: "nota-aluguel.pdf",
          mimeType: "application/pdf",
          buffer: onePagePdf("Recibo de aluguel"),
        });
        await attach(page, "Mercado Pão de Açúcar", {
          name: "protegido.pdf",
          mimeType: "application/pdf",
          buffer: PROTECTED,
        });
        await goTo(page, "d", /\/documentos$/);
        await expect(list.getByText("recibo-posto.png")).toBeVisible();
        await expect(list.getByText("nota-aluguel.pdf")).toBeVisible();
        await expect(list.getByText("protegido.pdf")).toBeVisible();
        await audit(page, "documentos com comprovantes");

        // an image is shown as it is
        await list.getByText("recibo-posto.png").click();
        await expect(page.getByRole("img", { name: "Documento recibo-posto.png" })).toBeVisible();
        await expect(page.getByText(/Comprovante de “Posto Shell”/)).toBeVisible();
        await expectNoHorizontalOverflow(page);

        // a PDF receipt is drawn, and its operation opens in the Livro
        await list.getByText("nota-aluguel.pdf").click();
        await expect(pages.locator("canvas").first()).toBeVisible();
        await page.getByRole("button", { name: "Ver lançamento: Aluguel" }).click();
        await expect.poll(async () => (await addresses()).some((u) => /\/livro\?.*ref=/.test(u))).toBe(true);
        await page.goBack();
        await expect(page.getByRole("heading", { level: 1, name: "Documentos" })).toBeVisible();

        // a protected PDF: refused with a wrong password inside the dialog, opened with the right one
        await list.getByText("protegido.pdf").click();
        await expect(page.getByText("Este PDF é protegido por senha.")).toBeVisible();
        await audit(page, "pdf protegido");
        await page.getByRole("button", { name: "Informar senha…" }).click();
        const dialog = page.getByRole("dialog", { name: "PDF protegido" });
        await expect(dialog.getByLabel("Senha do PDF")).toHaveAttribute("type", "password");
        await expectNoHorizontalOverflow(page);
        await audit(page, "informar senha");
        await dialog.getByLabel("Senha do PDF").fill("errada");
        await dialog.getByRole("button", { name: "Abrir", exact: true }).click();
        await expect(dialog.getByText("Senha incorreta. Tente de novo.")).toBeVisible();
        await expect(dialog.getByLabel("Senha do PDF")).toHaveValue("");
        await dialog.getByLabel("Senha do PDF").fill("segredo");
        await dialog.getByRole("button", { name: "Abrir", exact: true }).click();
        await expect(dialog).toBeHidden();
        await expect(pages.locator("canvas").first()).toBeVisible();
        await expect(page.getByRole("button", { name: "Informar senha…" })).toHaveCount(0);
        // the password is nowhere in the page
        expect(await page.evaluate(() => document.body.innerHTML.includes("segredo"))).toBe(false);

        // Salvar o original…: warned first; Cancelar saves nothing, confirming offers the file
        await page.getByRole("button", { name: "Salvar o original…" }).click();
        const warning = page.getByRole("alertdialog", { name: "Salvar o original sem criptografia?" });
        await expect(warning).toBeVisible();
        await audit(page, "salvar o original");
        await warning.getByRole("button", { name: "Cancelar" }).click();
        await expect(warning).toBeHidden();
        await page.getByRole("button", { name: "Salvar o original…" }).click();
        const download = page.waitForEvent("download");
        await warning.getByRole("button", { name: "Salvar o original", exact: true }).click();
        expect((await download).suggestedFilename()).toBe("protegido.pdf");

        // Desvincular…: the last use takes the file with it; Desfazer brings it back
        await list.getByText("recibo-posto.png").click();
        await page.getByRole("button", { name: "Desvincular de Posto Shell" }).click();
        const confirmation = page.getByRole("alertdialog", { name: "Desvincular o comprovante?" });
        await expect(confirmation).toBeVisible();
        await audit(page, "desvincular");
        await confirmation.getByRole("button", { name: "Desvincular", exact: true }).click();
        await expect(list.getByText("recibo-posto.png")).toHaveCount(0);
        await page.getByRole("button", { name: "Desfazer", exact: true }).click();
        await expect(list.getByText("recibo-posto.png")).toBeVisible();

        await settle(page);
        await expectNoHorizontalOverflow(page);
        await audit(page, "depois de usar");
        expect(errors).toEqual([]);
      });

      test("opens the document named by a link", async ({ page }) => {
        const errors = watchErrors(page);
        await openDemo(page, "/livro");
        await expect(page.locator("[data-row-id]").first()).toBeVisible();
        await attach(page, "Posto Shell", { name: "recibo-posto.png", mimeType: "image/png", buffer: PNG });
        await goTo(page, "d", /\/documentos$/);
        // the document id is not in the page: ask for a missing one and see the notice, and the page stays usable
        await page.evaluate(() => {
          window.history.pushState({}, "", "/documentos?ref=sumiu");
          window.dispatchEvent(new PopStateEvent("popstate"));
        });
        await expect(page.getByText("Esse documento não existe mais.").first()).toBeVisible();
        await expect(page).not.toHaveURL(/ref=/);
        expect(errors).toEqual([]);
      });
    });
  }
}
