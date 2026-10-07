/**
 * Livro financeiro, end to end on the production build with the demonstration project (`?demo`): it renders
 * cleanly at the five sizes in light and dark (no console errors, no horizontal overflow, axe without
 * violations), every button and menu item works, and every dialog is filled and submitted. The local AI is
 * answered by the test (`fakeOllama`): a real Ollama is never contacted.
 */
import {
  auditWith,
  TEST_SCHEMES,
  TEST_SIZES,
  expectNoHorizontalOverflow,
  openDemo,
  watchErrors,
  ONE_PIXEL_PNG,
} from "../helpers.ts";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { fakeOllama, pickRow } from "./livro_helpers.ts";
import { dialogOf, giveReason, menu, pickOption, submitAndClose } from "../ui.ts";

const audit = auditWith({ restPointer: false, settleMs: 300, skipNotices: false });

async function fill(dialog: Locator, label: string, value: string) {
  await dialog.getByLabel(label, { exact: true }).fill(value);
}

const total = async (page: Page) => {
  const text =
    (await page
      .getByText(/^\d+ (de \d+ )?lançamentos?$/)
      .first()
      .textContent()) ?? "";
  return Number(/(?:de )?(\d+) lançamentos?$/.exec(text)?.[1] ?? "0");
};

for (const size of TEST_SIZES) {
  for (const scheme of TEST_SCHEMES) {
    test.describe(`livro ${size.width}x${size.height} ${scheme}`, () => {
      test.use({ viewport: size, colorScheme: scheme, contextOptions: { reducedMotion: "reduce" } });

      test("renders cleanly: no errors, no overflow, accessible, with the details and a dialog open", async ({
        page,
      }) => {
        const errors = watchErrors(page);
        await fakeOllama(page);
        await openDemo(page, "/livro");
        await expect(page.locator("[data-row-id]").first()).toBeVisible();
        await expectNoHorizontalOverflow(page);
        await audit(page, "livro");

        // the details of a row: beside the table when wide, a sheet otherwise
        await pickRow(page, "Mercado do mês");
        if (size.width >= 640 && size.width < 1440) await page.getByRole("button", { name: "Detalhes" }).click();
        await expect(page.getByTestId("operation-details")).toBeVisible();
        await expectNoHorizontalOverflow(page);
        await audit(page, "livro com detalhes");
        if (size.width < 1440) {
          await dialogOf(page, "Detalhes do lançamento").getByRole("button", { name: "Fechar" }).click();
          await expect(dialogOf(page, "Detalhes do lançamento")).toHaveCount(0);
        }

        // a dialog with a select list open
        await page.getByRole("button", { name: "Novo lançamento", exact: true }).click();
        await page.getByRole("menuitem", { name: "Despesa" }).click();
        const dialog = dialogOf(page, "Despesa");
        await dialog.getByRole("combobox", { name: "Categoria", exact: true }).click();
        await expect(page.getByRole("option", { name: "Lazer" })).toBeVisible();
        await audit(page, "novo lançamento");
        await expectNoHorizontalOverflow(page);
        await page.keyboard.press("Escape");
        await expect(page.getByRole("option", { name: "Lazer" })).toHaveCount(0);
        await page.waitForTimeout(400); // Escape may close the list and the dialog together
        if ((await dialog.count()) > 0) await dialog.getByRole("button", { name: "Cancelar" }).click();
        await expect(dialog).toHaveCount(0);
        expect(errors).toEqual([]);
      });
    });
  }
}

test.describe("livro: every command", () => {
  test.use({ viewport: { width: 1920, height: 1080 }, contextOptions: { reducedMotion: "reduce" } });

  test("creates every kind of entry", async ({ page }) => {
    const errors = watchErrors(page);
    await openDemo(page, "/livro");
    await expect(page.locator("[data-row-id]").first()).toBeVisible();
    let count = await total(page);

    for (const [kind, fields] of [
      ["Despesa", { Descrição: "Livraria", Valor: "89,90" }],
      ["Receita", { Descrição: "Freela", Valor: "1.500,00" }],
      ["Transferência", { Valor: "300" }],
      ["Compra no cartão", { Descrição: "Cadeira", Valor: "450,00" }],
      ["Pagamento de fatura", { Valor: "200" }],
    ] as const) {
      await page.getByRole("button", { name: "Novo lançamento", exact: true }).click();
      await page.getByRole("menuitem", { name: kind, exact: true }).click();
      const dialog = dialogOf(page, kind);
      for (const [label, value] of Object.entries(fields)) await fill(dialog, label, value);
      if (kind === "Transferência") await pickOption(page, dialog, "Para", "Poupança");
      if (kind === "Pagamento de fatura") await pickOption(page, dialog, "Pago pela conta", "Banco A");
      await submitAndClose(dialog, "Registrar");
      count += 1;
      await expect.poll(() => total(page)).toBe(count);
    }

    // installments: one purchase paid in six parts (the whole expense in the month of the purchase)
    await page.getByRole("button", { name: "Novo lançamento", exact: true }).click();
    await page.getByRole("menuitem", { name: "Compra no cartão", exact: true }).click();
    let dialog = dialogOf(page, "Compra no cartão");
    await fill(dialog, "Descrição", "Notebook");
    await fill(dialog, "Valor", "3.000,00");
    await fill(dialog, "Parcelas", "6");
    await submitAndClose(dialog, "Registrar");
    await expect.poll(() => total(page)).toBe(count + 1);
    count += 1;

    // a split between categories
    await page.getByRole("button", { name: "Novo lançamento", exact: true }).click();
    await page.getByRole("menuitem", { name: "Despesa", exact: true }).click();
    dialog = dialogOf(page, "Despesa");
    await fill(dialog, "Descrição", "Mercado e farmácia");
    await fill(dialog, "Valor", "200,00");
    await dialog.getByRole("switch", { name: /Ratear entre categorias/ }).click();
    await pickOption(page, dialog, "Categoria da parte 1", "Alimentação");
    await fill(dialog, "Valor da parte 1", "150,00");
    await pickOption(page, dialog, "Categoria da parte 2", "Saúde");
    await fill(dialog, "Valor da parte 2", "50,00");
    await expect(dialog.getByText("Rateio fechado ✓")).toBeVisible();
    await submitAndClose(dialog, "Registrar");
    await expect.poll(() => total(page)).toBe(count + 1);

    // the usual category, learned, and the local AI asked about an unknown description
    await fakeOllama(page);
    await page.getByRole("button", { name: "Novo lançamento", exact: true }).click();
    await page.getByRole("menuitem", { name: "Despesa", exact: true }).click();
    dialog = dialogOf(page, "Despesa");
    await fill(dialog, "Descrição", "Padaria Real");
    await expect(dialog.getByText(/Categoria sugerida pelo uso/)).toBeVisible();
    await fill(dialog, "Descrição", "Ingresso do cinema");
    await dialog.getByRole("button", { name: "Perguntar à IA local" }).click();
    await expect(dialog.getByText(/Categoria sugerida pela IA local/)).toBeVisible();
    await dialog.getByRole("button", { name: "Cancelar" }).click();
    await expect(dialog).toHaveCount(0);

    await expectNoHorizontalOverflow(page);
    expect(errors).toEqual([]);
  });

  test("every row command, with a dialog each", async ({ page }) => {
    const errors = watchErrors(page);
    await openDemo(page, "/livro");
    await expect(page.locator("[data-row-id]").first()).toBeVisible();

    await pickRow(page, "Posto Shell");
    // corrections: the day-to-day form (Enter), the full editor, and a refusal
    await page.keyboard.press("Enter");
    let dialog = dialogOf(page, "Corrigir lançamento");
    await fill(dialog, "Valor", "150,00");
    await dialog.getByRole("button", { name: "Salvar correção" }).click();
    await expect(dialog.getByRole("alert")).toContainText("O motivo da correção é obrigatório.");
    await giveReason(dialog, "Troco do frentista", "Salvar correção", /Motivo da correção/);
    await expect(page.getByTestId("operation-details")).toContainText("Troco do frentista");

    await menu(page, "Ações", "Corrigir partidas…");
    dialog = dialogOf(page, "Editar lançamento");
    await pickOption(page, dialog, "Integrante da partida 1", "Ana");
    await giveReason(dialog, "Quem paga a gasolina", "Salvar correção", /Motivo da correção/);

    // classification
    await menu(page, "Ações", "Reclassificar…");
    dialog = dialogOf(page, "Reclassificar lançamentos");
    await pickOption(page, dialog, "Nova categoria", "Despesa: Lazer");
    await giveReason(dialog, "Passeio de domingo", "Reclassificar");

    await menu(page, "Ações", "Marcadores…");
    dialog = dialogOf(page, "Marcadores");
    await dialog.getByLabel("Marcador", { exact: true }).fill("Passeio");
    await submitAndClose(dialog, "Aplicar");
    await expect(page.getByTestId("operation-details")).toContainText("Passeio");

    await menu(page, "Ações", "Nomear estabelecimento…");
    dialog = dialogOf(page, "Nomear estabelecimento");
    await dialog.getByLabel(/Nome do estabelecimento/).fill("Shell Centro");
    await submitAndClose(dialog, "Salvar nome");
    await expect(page.getByTestId("operation-details")).toContainText("Shell Centro");

    // a receipt: attach, open, close
    await page
      .getByLabel("Escolher o comprovante")
      .setInputFiles({ name: "nota.png", mimeType: "image/png", buffer: ONE_PIXEL_PNG });
    await page.getByRole("button", { name: "Abrir comprovante" }).click();
    dialog = dialogOf(page, "Comprovante");
    await expect(dialog.getByRole("img", { name: "Comprovante nota.png" })).toBeVisible();
    await dialog.getByRole("button", { name: "Fechar" }).last().click();
    await expect(dialog).toHaveCount(0);

    // planning from an operation
    await menu(page, "Ações", "Reembolso a receber…");
    dialog = dialogOf(page, "Reembolso a receber");
    await fill(dialog, "Quem reembolsa", "Empresa");
    await fill(dialog, "Valor esperado", "100,00");
    await submitAndClose(dialog, "Registrar");
    await expect(page.getByTestId("operation-details")).toContainText("Empresa");

    await menu(page, "Ações", "Marcar categoria como dedutível…");
    dialog = dialogOf(page, /Despesa dedutível/);
    await pickOption(page, dialog, "Tipo de dedução", "Saúde");
    await submitAndClose(dialog, "Salvar");

    await menu(page, "Ações", "Conferir saldo da conta…");
    dialog = dialogOf(page, /Conferir saldo/);
    await fill(dialog, "Saldo no banco", "8.000,00");
    await submitAndClose(dialog, "Conferir");

    await menu(page, "Ações", "Está certo");
    await menu(page, "Ações", "Histórico");
    dialog = dialogOf(page, "Histórico");
    await expect(dialog).toContainText("Troco do frentista");
    await dialog.getByRole("button", { name: "Fechar" }).last().click();
    await expect(dialog).toHaveCount(0);

    // an income detail
    await pickRow(page, "Salário");
    await menu(page, "Ações", "Detalhar rendimento");
    dialog = dialogOf(page, "Detalhar rendimento");
    await fill(dialog, "Bruto", "9.000,00");
    await submitAndClose(dialog, "Salvar");

    // reverse one entry and cancel another
    await pickRow(page, "Aluguel");
    await menu(page, "Ações", "Estornar…");
    dialog = dialogOf(page, "Estornar lançamento");
    await giveReason(dialog, "Cobrança indevida", "Estornar");

    await pickRow(page, "Padaria Real");
    await menu(page, "Ações", "Cancelar lançamento…");
    dialog = dialogOf(page, "Cancelar lançamento");
    await giveReason(dialog, "Lançado em duplicidade", "Cancelar lançamento");
    await expect(page.getByTestId("operation-details")).toContainText("Cancelado");

    // undo reverts the last action, from the keyboard
    await page.locator('[role="grid"]').focus();
    await page.keyboard.press("Control+z");
    await expect(page.getByTestId("operation-details")).not.toContainText("Cancelado");

    await expectNoHorizontalOverflow(page);
    expect(errors).toEqual([]);
  });

  test("filters, saved filters, columns, ticking, export and the local AI", async ({ page }) => {
    const errors = watchErrors(page);
    await fakeOllama(page);
    await openDemo(page, "/livro");
    await expect(page.locator("[data-row-id]").first()).toBeVisible();
    const all = await total(page);

    // search, filters and the way back
    await page.getByRole("searchbox", { name: "Buscar lançamentos" }).fill("aluguel");
    await expect.poll(() => page.locator("[data-row-id]").count()).toBe(3);
    await page.getByRole("button", { name: "Limpar filtros" }).first().click();
    await pickOption(page, page, "Período", "Este ano");
    await pickOption(page, page, "Período", "Personalizado");
    await page.getByLabel("Data inicial").fill("01/03/2026");
    await page.getByLabel("Data final").fill("31/03/2026");
    await expect.poll(() => page.locator("[data-row-id]").count()).toBeGreaterThan(0);
    await pickOption(page, page, "Período", "Todo o período");
    await pickOption(page, page, "Conta ou categoria", "Categoria: Moradia");
    await pickOption(page, page, "Integrante", "Todos os integrantes");
    await pickOption(page, page, "Situação", "Só ativos");
    await pickOption(page, page, "Origem", "Manual");
    // the three rents of the demonstration and this month's condominium fee
    await expect.poll(() => page.locator("[data-row-id]").count()).toBe(4);

    // a filter saved in the project, applied and deleted
    await menu(page, "Filtros salvos", "Salvar filtro atual…");
    let dialog = dialogOf(page, "Salvar filtro");
    await dialog.getByLabel(/^Nome do filtro/).fill("Só a moradia");
    await submitAndClose(dialog, "Salvar filtro");
    await page.getByRole("button", { name: "Limpar filtros" }).first().click();
    await menu(page, "Filtros salvos", "Só a moradia");
    await expect.poll(() => page.locator("[data-row-id]").count()).toBe(4);
    await menu(page, "Filtros salvos", /Excluir “Só a moradia”/);
    await page.getByRole("button", { name: "Limpar filtros" }).first().click();

    // columns
    await menu(page, "Colunas", "Ocultar Origem");
    await expect(page.getByRole("columnheader", { name: "Origem" })).toHaveCount(0);
    await menu(page, "Colunas", "Mostrar Origem");
    await expect(page.getByRole("columnheader", { name: "Origem" })).toBeVisible();

    // ticking: with the mouse, from the menu and with Space; then sorting
    await page.getByRole("row").nth(1).getByRole("checkbox").click();
    await expect(page.getByText("1 marcado")).toBeVisible();
    await menu(page, "Ações", /Marcar os \d+ exibidos/);
    await expect(page.getByText(`${all} marcados`)).toBeVisible();
    await page.getByRole("button", { name: "Limpar marcação" }).first().click();
    await page.getByRole("columnheader", { name: "Valor" }).getByRole("button").click();
    await expect(page.getByRole("columnheader", { name: "Valor" })).toHaveAttribute("aria-sort", "ascending");
    await page.getByRole("columnheader", { name: "Valor" }).getByRole("button").click();
    await page.getByRole("columnheader", { name: "Valor" }).getByRole("button").click();

    // export: the whole book and what is shown, each after the warning
    for (const item of ["Livro completo (CSV)", "Lançamentos exibidos (CSV)"]) {
      const download = page.waitForEvent("download");
      await menu(page, "Exportar", item);
      await page.getByRole("alertdialog").getByRole("button", { name: "Exportar CSV" }).click();
      expect((await download).suggestedFilename()).toMatch(/\.csv$/);
    }

    // the local AI: categories (reviewed, applied) and names
    await menu(page, "IA local", "Sugerir categorias…");
    dialog = dialogOf(page, "Sugestões de categoria");
    await expect(dialog.getByRole("table")).toBeVisible();
    await dialog.getByRole("button", { name: "Desmarcar todas" }).click();
    await dialog.getByRole("button", { name: "Reclassificar marcadas" }).click();
    await expect(dialog.getByRole("alert")).toContainText("Marque ao menos uma sugestão");
    await dialog.getByRole("checkbox", { name: "Aluguel" }).click();
    await submitAndClose(dialog, "Reclassificar marcadas");

    await menu(page, "IA local", "Sugerir nomes de estabelecimentos…");
    dialog = dialogOf(page, "Nomes de estabelecimentos");
    await expect(dialog.getByRole("table")).toBeVisible();
    await submitAndClose(dialog, "Aprovar marcados");

    await expectNoHorizontalOverflow(page);
    expect(errors).toEqual([]);
  });

  test("links from other pages: the address carries the object and the action", async ({ page }) => {
    const errors = watchErrors(page);
    await openDemo(page, "/livro");
    await expect(page.locator("[data-row-id]").first()).toBeVisible();
    await page.getByRole("button", { name: "Buscar seção ou comando" }).click();
    await page.keyboard.press("Escape");
    // Visão geral → "Ver lançamentos": the account and month filter the Livro
    await page.keyboard.press("g");
    await page.keyboard.press("v");
    await expect(page.getByRole("heading", { level: 1, name: "Visão geral" })).toBeVisible();
    await page.getByRole("link", { name: /Livro/ }).first().click();
    await expect(page.getByRole("heading", { level: 1, name: "Livro financeiro" })).toBeVisible();
    await expect(page.locator("[data-row-id]").first()).toBeVisible();
    expect(errors).toEqual([]);
  });
});

test.describe("livro on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, contextOptions: { reducedMotion: "reduce" } });

  test("cards, the details sheet and the commands inside it", async ({ page }) => {
    const errors = watchErrors(page);
    await openDemo(page, "/livro");
    await expect(page.getByRole("listbox", { name: "Lançamentos" })).toBeVisible();
    await page.getByRole("option").first().click();
    const sheet = dialogOf(page, "Detalhes do lançamento");
    await expect(sheet).toBeVisible();
    await sheet.getByRole("button", { name: "Corrigir", exact: true }).click();
    const edit = dialogOf(page, /Corrigir lançamento/);
    await expect(edit).toBeVisible();
    await fill(edit, "Valor", "10,00");
    await giveReason(edit, "Teste no celular", "Salvar correção", /Motivo da correção/);
    await sheet.getByRole("button", { name: "Mais ações" }).click();
    await page.getByRole("menuitem", { name: /^Histórico/ }).click();
    await expect(dialogOf(page, "Histórico")).toContainText("Teste no celular");
    await expectNoHorizontalOverflow(page);
    expect(errors).toEqual([]);
  });

  test("one toolbar row before the entries: search, the filters sheet and one overflow menu", async ({ page }) => {
    const errors = watchErrors(page);
    await fakeOllama(page);
    await openDemo(page, "/livro");
    const toolbar = page.getByRole("toolbar", { name: "Busca e comandos do livro" });
    const search = toolbar.getByRole("searchbox", { name: "Buscar lançamentos" });
    const filters = toolbar.getByRole("button", { name: "Filtros", exact: true });
    const more = toolbar.getByRole("button", { name: "Mais comandos" });
    // The three controls share one row, and the old stacked commands are gone from the page.
    const tops = await Promise.all([search, filters, more].map(async (l) => (await l.boundingBox())!.y));
    expect(Math.max(...tops) - Math.min(...tops)).toBeLessThan(8);
    for (const name of ["Filtros salvos", "Ações", "IA local", "Exportar"]) {
      await expect(page.getByRole("button", { name, exact: true })).toHaveCount(0);
    }

    // A compact card: description and amount, then the accounts and the date, without column names.
    const card = page.getByRole("listbox", { name: "Lançamentos" }).getByRole("option").first();
    await expect(card).toBeVisible();
    await expect(card).toContainText(/R\$/);
    await expect(card).toContainText("→");
    await expect(card).not.toContainText(/Valor|Data|De → Para/);
    const box = (await card.boundingBox())!;
    expect(box.height).toBeLessThan(80);

    // The filters sheet: choosing one narrows the list and the button says how many are active.
    await filters.click();
    const sheet = dialogOf(page, "Filtros");
    await expect(sheet.getByRole("button", { name: "Filtros salvos" })).toBeVisible();
    await pickOption(page, sheet, "Situação", "Só ativos");
    await sheet.getByRole("button", { name: /^Ver \d+ lançamento/ }).click();
    await expect(sheet).toHaveCount(0);
    await expect(toolbar.getByRole("button", { name: "Filtros (1 ativo)" })).toBeVisible();
    await toolbar.getByRole("button", { name: "Filtros (1 ativo)" }).click();
    await dialogOf(page, "Filtros").getByRole("button", { name: "Limpar filtros" }).click();
    await page.keyboard.press("Escape");
    await expect(filters).toBeVisible();

    // The overflow menu: the row commands, the local AI and the export, in groups.
    await more.click();
    await expect(page.getByRole("menuitem", { name: /Marcar os \d+ exibidos/ })).toBeVisible();
    await expect(page.getByRole("menuitem", { name: "Sugerir categorias…" })).toBeVisible();
    await expect(page.getByRole("menuitem", { name: "Livro completo (CSV)" })).toBeVisible();
    await page.getByRole("menuitem", { name: /Marcar os \d+ exibidos/ }).click();
    await expect(page.getByText(/\d+ marcados/)).toBeVisible();
    await expectNoHorizontalOverflow(page);
    expect(errors).toEqual([]);
  });
});
