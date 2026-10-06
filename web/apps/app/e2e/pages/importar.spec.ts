/**
 * Importar e revisar end to end (docs/18 §5, SCREENS.md) on the production build and its CSP: real files through the
 * browser's file chooser and by a drop on the app, read by the real parser worker (pdf.js inside it), the original
 * drawn by the real pdf.js with the evidence of the selected item highlighted, every button, menu and dialog, no
 * console errors, no sideways scroll at the five sizes, axe clean, light and dark.
 */
import { expect, test, type Locator, type Page } from "@playwright/test";
import {
  SCHEMES,
  SIZES,
  expectNoHorizontalOverflow,
  openDemo,
  recordAddresses,
  settle,
  watchErrors,
} from "../helpers.ts";
import {
  AMBIGUOUS,
  CSV,
  ITAU,
  OFX,
  PROTECTED,
  chooseFiles,
  dropOnApp,
  readNotice,
  watchWorkers,
} from "./importar_helpers.ts";
import { PROTECTED_PDF_PASSWORD } from "./protected_pdf.ts";
import { fakeOllama } from "./livro_helpers.ts";
import { audit, tableOf } from "./sharing_helpers.ts";

const items = (page: Page) => tableOf(page, "Itens extraídos");
const queue = (page: Page) => tableOf(page, "Documentos importados");
const row = (table: Locator, text: string) => table.locator("[data-row-id]").filter({ hasText: text }).first();

/** Selects an item of the review by its description. */
async function pick(page: Page, description: string) {
  const target = row(items(page), description);
  await target.getByText(description, { exact: true }).click();
  await expect(target).toHaveAttribute("aria-selected", "true");
}

async function reasonDialog(page: Page, title: string, reason: string, confirm: string) {
  const dialog = page.getByRole("dialog", { name: title });
  await dialog.getByLabel(/Motivo/).fill(reason);
  await dialog.getByRole("button", { name: confirm, exact: true }).click();
  await expect(dialog).toHaveCount(0);
}

async function more(page: Page, item: string | RegExp) {
  await page.getByRole("button", { name: "Mais", exact: true }).click();
  await page.getByRole("menuitem", { name: item }).click();
}

for (const size of SIZES) {
  for (const scheme of SCHEMES) {
    test.describe(`importar ${size.width}x${size.height} ${scheme}`, () => {
      test.use({ viewport: size, colorScheme: scheme, contextOptions: { reducedMotion: "reduce" } });

      test("the original beside the review, with the evidence of the selected item", async ({ page }) => {
        const errors = watchErrors(page);
        await openDemo(page, "/importar");

        // the demonstration's statement: queue, review and the real pdf.js drawing of the original
        await expect(queue(page).getByText("fatura-nubank-03.pdf")).toBeVisible();
        await expect(page.getByRole("heading", { level: 2, name: "fatura-nubank-03.pdf" })).toBeVisible();
        await expect(items(page).locator("[data-row-id]").first()).toBeVisible();
        const viewer = page.getByRole("region", { name: "Página do documento" });
        const canvas = viewer.locator("canvas");
        await expect(canvas).toBeVisible();
        await expect(page.getByText("Página 1 de 1")).toBeVisible();
        expect(await canvas.evaluate((c: HTMLCanvasElement) => c.width > 100 && c.height > 100)).toBe(true);

        // the selected item's text is boxed on the page, inside it
        await pick(page, "Padaria");
        const box = page.locator("[data-evidence-box]");
        await expect(box).toBeVisible();
        const [boxRect, pageRect] = await Promise.all([box.boundingBox(), canvas.boundingBox()]);
        expect(boxRect && pageRect).toBeTruthy();
        expect(boxRect!.width).toBeGreaterThan(8);
        expect(boxRect!.height).toBeGreaterThan(4);
        expect(boxRect!.x).toBeGreaterThanOrEqual(pageRect!.x - 1);
        expect(boxRect!.y).toBeGreaterThanOrEqual(pageRect!.y - 1);
        expect(boxRect!.x + boxRect!.width).toBeLessThanOrEqual(pageRect!.x + pageRect!.width + 1);
        expect(boxRect!.y + boxRect!.height).toBeLessThanOrEqual(pageRect!.y + pageRect!.height + 1);
        // and another item moves it
        const first = await box.boundingBox();
        await pick(page, "Amazon.com");
        await expect.poll(async () => (await box.boundingBox())?.y).not.toBe(first!.y);
        const figure = page.getByRole("figure", { name: "Evidência do item selecionado" });
        await expect(figure).toContainText("Evidência: página 1");

        // wide windows: the review and the original side by side
        if (size.width >= 1440) {
          const review = await items(page).boundingBox();
          const original = await viewer.boundingBox();
          expect(original!.x).toBeGreaterThan(review!.x + review!.width - 4);
        }
        await settle(page);
        await expectNoHorizontalOverflow(page);
        await audit(page, "importar");
        expect(errors).toEqual([]);
      });

      test("files chosen in the file chooser and dropped on the app are read by the worker", async ({ page }) => {
        const errors = watchErrors(page);
        const workers = watchWorkers(page);
        await fakeOllama(page);
        await openDemo(page, "/importar");
        await expect(items(page).locator("[data-row-id]").first()).toBeVisible();

        // the chooser: an OFX, a CSV and a two-page PDF, read one at a time
        await chooseFiles(page, [OFX, CSV, ITAU]);
        await expect(readNotice(page, "extrato.ofx")).toBeVisible();
        await expect(readNotice(page, "fatura.csv")).toBeVisible();
        await expect(readNotice(page, "itau.pdf")).toBeVisible();
        // the parser worker started from this app's own address, under the production CSP
        expect(workers.some((url) => /\/assets\/parser\.worker-[\w-]+\.js$/.test(url))).toBe(true);
        // the local AI looked at the items without a category, in the background, and nothing was approved
        await expect(
          page.getByText(/IA local: \d+ categoria\(s\) sugerida\(s\)\. Revise antes de aprovar\./),
        ).toBeVisible();
        // the last file read is the one open: its original has two pages
        await expect(page.getByRole("heading", { level: 2, name: "itau.pdf" })).toBeVisible();
        await expect(page.getByText("Página 1 de 2")).toBeVisible();
        await expect(queue(page).getByText("extrato.ofx")).toBeVisible();
        await expect(queue(page).getByText("fatura.csv")).toBeVisible();
        await expect(queue(page).getByText("itau.pdf")).toBeVisible();

        // a CSV has no page: its line of the file is the evidence
        await queue(page).getByText("fatura.csv").click();
        await pick(page, "Uber *Trip");
        await expect(page.getByText("Linha 2 do arquivo")).toBeVisible();
        await expect(page.getByText(/a linha de origem de cada item aparece aqui/)).toBeVisible();

        // a drop anywhere in the app (here on another page) brings the files to the page and reads them
        await page.goto("/livro?demo");
        await expect(page.locator("h1").first()).toBeVisible();
        await dropOnApp(page, [{ ...CSV, name: "solto.csv", buffer: Buffer.from(CSV.buffer.toString() + "\n") }]);
        await expect(page).toHaveURL(/\/importar/);
        await expect(readNotice(page, "solto.csv")).toBeVisible();
        await expect(page.getByRole("heading", { level: 2, name: "solto.csv" })).toBeVisible();
        await settle(page);
        await expectNoHorizontalOverflow(page);
        await audit(page, "importar-arquivos");
        expect(errors).toEqual([]);
      });

      test("every button, menu and dialog works, and the last import can be undone", async ({ page }) => {
        const errors = watchErrors(page);
        const addresses = await recordAddresses(page);
        await fakeOllama(page);
        await openDemo(page, "/importar");
        await expect(items(page).locator("[data-row-id]").first()).toBeVisible();

        // Layouts suportados
        await page.getByRole("button", { name: "Layouts suportados" }).click();
        const layouts = page.getByRole("dialog", { name: "Layouts suportados" });
        await expect(layouts.getByText("nubank-cartao-csv")).toBeVisible();
        await expect(layouts.getByText("não (sintético)").first()).toBeVisible();
        await layouts.getByRole("button", { name: "Fechar" }).last().click();
        await expect(layouts).toHaveCount(0);

        // a category by hand, the rule offered right then, and the rule dialog
        // (on a narrow screen the cards hold no controls: the category of the selected item is chosen above the list)
        await pick(page, "Loja Eletro");
        await page.getByRole("combobox", { name: "Categoria ou conta de Loja Eletro" }).click();
        await page.getByRole("option", { name: "Lazer", exact: true }).click();
        await expect(page.getByText(/Usar sempre “Lazer” para descrições com “/)).toBeVisible();
        await page.getByRole("button", { name: "Criar regra…" }).click();
        const rule = page.getByRole("dialog", { name: "Regra de categoria" });
        await expect(rule.getByLabel(/A descrição contém/)).toHaveValue(/loja/i);
        await rule.getByRole("button", { name: "Criar regra", exact: true }).click();
        await expect(page.getByText(/Regra criada\. \d+ item\(ns\) pendente\(s\) recategorizado\(s\)\./)).toBeVisible();

        // correct an item: refused without a reason, then done
        await pick(page, "Padaria");
        await page.getByRole("button", { name: "Corrigir…" }).click();
        const fix = page.getByRole("dialog", { name: "Corrigir item" });
        await fix.getByLabel("Descrição").fill("Padaria Pão Quente");
        await fix.getByRole("button", { name: "Corrigir", exact: true }).click();
        await expect(fix.getByText("Informe o motivo da correção.")).toBeVisible();
        await fix.getByLabel(/Motivo/).fill("Nome na nota");
        await fix.getByRole("button", { name: "Corrigir", exact: true }).click();
        await expect(fix).toHaveCount(0);
        await expect(row(items(page), "Padaria Pão Quente")).toBeVisible();

        // approve one item (a partial approval asks for its reason) and see it in the Livro
        await pick(page, "Mercado Bom Preço");
        await page.getByRole("button", { name: "Aprovar selecionado" }).click();
        await reasonDialog(page, "Aprovação parcial", "Conferi só o mercado", "Aprovar");
        await expect(page.getByText("1 operação(ões) criada(s), 0 evidência(s) vinculada(s).")).toBeVisible();
        await page.locator("[data-row-id]").filter({ hasText: "Aprovado" }).first().click();
        await page.getByRole("button", { name: "Ver no Livro" }).click();
        await expect.poll(async () => (await addresses()).some((url) => /\/livro\?.*ref=/.test(url))).toBe(true);
        await expect(page.getByRole("heading", { level: 1, name: "Livro financeiro" })).toBeVisible();
        await page.goBack();
        await expect(page.getByRole("heading", { level: 1, name: "Importar e revisar" })).toBeVisible();

        // approve what is left; the document is approved and the page says so
        await page.getByRole("button", { name: "Aprovar prontos" }).click();
        await expect(
          page.getByText(/operação\(ões\) criada\(s\), 0 evidência\(s\) vinculada\(s\)\./).last(),
        ).toBeVisible();
        await expect(queue(page).getByText("Aprovado").first()).toBeVisible();
        await expect(page.getByRole("button", { name: "Aprovar prontos" })).toBeDisabled();

        // an OFX with no account: refused until the account is chosen, then approved
        await chooseFiles(page, [OFX]);
        await expect(readNotice(page, "extrato.ofx")).toBeVisible();
        await page.getByRole("button", { name: "Aprovar prontos" }).click();
        await expect(page.getByText("Escolha a conta ou o cartão deste documento antes de aprovar.")).toBeVisible();
        await page.getByRole("combobox", { name: /^Conta ou cartão/ }).click();
        await page.getByRole("option", { name: "Banco A", exact: true }).click();
        await page.getByRole("button", { name: "Aprovar prontos" }).click();
        await expect(page.getByText("2 operação(ões) criada(s), 0 evidência(s) vinculada(s).")).toBeVisible();

        // the same transactions in another file are "já registrados": approving only links the evidence
        await chooseFiles(page, [{ ...OFX, name: "extrato-2.ofx", buffer: Buffer.from(OFX.buffer.toString() + "\n") }]);
        await expect(readNotice(page, "extrato-2.ofx")).toBeVisible();
        await page.getByRole("combobox", { name: /^Conta ou cartão/ }).click();
        await page.getByRole("option", { name: "Banco A", exact: true }).click();
        await expect(row(items(page), "PIX ALUGUEL")).toContainText("Já registrado");
        await pick(page, "PIX ALUGUEL");
        await more(page, /^Manter separado…/);
        await reasonDialog(page, "Manter como lançamento separado", "Dois aluguéis", "Manter separado");
        await expect(row(items(page), "PIX ALUGUEL")).toContainText("Pronto");

        // a card statement of a CSV: one item is rejected with a reason
        await chooseFiles(page, [CSV]);
        await expect(readNotice(page, "fatura.csv")).toBeVisible();
        await pick(page, "Loja Z");
        await more(page, /^Rejeitar item…/);
        await reasonDialog(page, "Rejeitar item", "Compra que não é nossa", "Rejeitar");
        await expect(row(items(page), "Loja Z")).toContainText("Rejeitado");

        // a document two layouts recognize: the person chooses, and it is read again
        await chooseFiles(page, [AMBIGUOUS]);
        await expect(readNotice(page, "dois-layouts.csv")).toBeVisible();
        await expect(page.getByRole("heading", { level: 2, name: "dois-layouts.csv" })).toBeVisible();
        await expectNoHorizontalOverflow(page);
        await page.getByRole("combobox", { name: "Layout", exact: true }).click();
        await page.getByRole("option", { name: /nubank-cartao-csv/ }).click();
        await page.getByRole("button", { name: "Usar layout" }).click();
        await expect(page.getByText("dois-layouts.csv: lido de novo com o layout nubank-cartao-csv.")).toBeVisible();
        await expect(row(items(page), "Uber Trip")).toBeVisible();

        // a protected PDF: the password is asked, a wrong one is refused inside the dialog, the right one reads it
        await chooseFiles(page, [PROTECTED]);
        const ask = page.getByRole("dialog", { name: "PDF protegido" });
        await expect(ask.getByText("PDF protegido por senha.")).toBeVisible();
        await ask.getByLabel(/Senha do PDF/).fill("errada");
        await ask.getByRole("button", { name: "Importar", exact: true }).click();
        await expect(ask.getByText("Senha incorreta. Tente de novo.")).toBeVisible();
        await ask.getByLabel(/Senha do PDF/).fill(PROTECTED_PDF_PASSWORD);
        await ask.getByRole("button", { name: "Importar", exact: true }).click();
        await expect(ask).toHaveCount(0);
        await expect(page.getByRole("heading", { level: 2, name: "protegido.pdf" })).toBeVisible();
        // the original is still protected: the password only opens the view
        await expect(page.getByText(/Este PDF é protegido por senha\./)).toBeVisible();
        await page.getByRole("button", { name: "Informar senha…" }).click();
        const view = page.getByRole("dialog", { name: "PDF protegido" });
        await view.getByLabel(/Senha do PDF/).fill(PROTECTED_PDF_PASSWORD);
        await view.getByRole("button", { name: "Abrir", exact: true }).click();
        await expect(page.getByRole("region", { name: "Página do documento" }).locator("canvas")).toBeVisible();

        // one undo takes the last import back
        await page.locator("h1").click();
        await page.keyboard.press("Control+z");
        await expect(queue(page).getByText("protegido.pdf")).toHaveCount(0);

        await settle(page);
        await expectNoHorizontalOverflow(page);
        await audit(page, "importar-revisao");
        expect(errors).toEqual([]);
      });
    });
  }
}
