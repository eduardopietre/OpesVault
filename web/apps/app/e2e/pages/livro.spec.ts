/**
 * Livro financeiro, end to end on the production build with the demonstration project (`?demo`): it renders
 * cleanly at the five sizes in light and dark (no console errors, no horizontal overflow, axe without
 * violations), every button and menu item works, and every dialog is filled and submitted. The local AI is
 * answered by the test (`fakeOllama`): a real Ollama is never contacted.
 */
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { SCHEMES, SIZES, expectNoHorizontalOverflow, openDemo, settle, watchErrors } from "../helpers.ts";
import { fakeOllama, pickRow } from "./livro_helpers.ts";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

async function audit(page: Page, label: string) {
  await settle(page, 300);
  const result = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    .analyze();
  const summary = result.violations.map(
    (violation) =>
      `${label}: ${violation.id} (${violation.impact}) ${violation.nodes
        .map((node) => `${node.target.join(" ")} ${node.failureSummary ?? ""}`)
        .slice(0, 3)
        .join(", ")}`,
  );
  expect(summary).toEqual([]);
}

const dialogOf = (page: Page, name: string | RegExp) => page.getByRole("dialog", { name });

async function pick(page: Page, scope: Locator | Page, name: string, option: string | RegExp) {
  await scope.getByRole("combobox", { name, exact: true }).click();
  await page.getByRole("option", { name: option, exact: typeof option === "string" }).click();
}

async function menuItem(page: Page, button: string, item: string | RegExp) {
  await page.getByRole("button", { name: button, exact: true }).click();
  await page
    .getByRole("menuitem", {
      name: typeof item === "string" ? new RegExp(`^${item.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`) : item,
    })
    .click();
}

async function fill(dialog: Locator, label: string, value: string) {
  await dialog.getByLabel(label, { exact: true }).fill(value);
}

async function finish(_page: Page, dialog: Locator, button: string) {
  await dialog.getByRole("button", { name: button, exact: true }).click();
  await expect(dialog).toHaveCount(0);
}

const total = async (page: Page) => {
  const text =
    (await page
      .getByText(/^\d+ (de \d+ )?lançamentos?$/)
      .first()
      .textContent()) ?? "";
  return Number(/(?:de )?(\d+) lançamentos?$/.exec(text)?.[1] ?? "0");
};

for (const size of SIZES) {
  for (const scheme of SCHEMES) {
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
        await page.getByRole("button", { name: "Novo lançamento" }).click();
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
      await page.getByRole("button", { name: "Novo lançamento" }).click();
      await page.getByRole("menuitem", { name: kind, exact: true }).click();
      const dialog = dialogOf(page, kind);
      for (const [label, value] of Object.entries(fields)) await fill(dialog, label, value);
      if (kind === "Transferência") await pick(page, dialog, "Para", "Poupança");
      if (kind === "Pagamento de fatura") await pick(page, dialog, "Pago pela conta", "Banco A");
      await finish(page, dialog, "Registrar");
      count += 1;
      await expect.poll(() => total(page)).toBe(count);
    }

    // installments: one purchase paid in six parts (the whole expense in the month of the purchase)
    await page.getByRole("button", { name: "Novo lançamento" }).click();
    await page.getByRole("menuitem", { name: "Compra no cartão", exact: true }).click();
    let dialog = dialogOf(page, "Compra no cartão");
    await fill(dialog, "Descrição", "Notebook");
    await fill(dialog, "Valor", "3.000,00");
    await fill(dialog, "Parcelas", "6");
    await finish(page, dialog, "Registrar");
    await expect.poll(() => total(page)).toBe(count + 1);
    count += 1;

    // a split between categories
    await page.getByRole("button", { name: "Novo lançamento" }).click();
    await page.getByRole("menuitem", { name: "Despesa", exact: true }).click();
    dialog = dialogOf(page, "Despesa");
    await fill(dialog, "Descrição", "Mercado e farmácia");
    await fill(dialog, "Valor", "200,00");
    await dialog.getByRole("switch", { name: /Ratear entre categorias/ }).click();
    await pick(page, dialog, "Categoria da parte 1", "Alimentação");
    await fill(dialog, "Valor da parte 1", "150,00");
    await pick(page, dialog, "Categoria da parte 2", "Saúde");
    await fill(dialog, "Valor da parte 2", "50,00");
    await expect(dialog.getByText("Rateio fechado ✓")).toBeVisible();
    await finish(page, dialog, "Registrar");
    await expect.poll(() => total(page)).toBe(count + 1);

    // the usual category, learned, and the local AI asked about an unknown description
    await fakeOllama(page);
    await page.getByRole("button", { name: "Novo lançamento" }).click();
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
    await dialog.getByLabel(/Motivo da correção/).fill("Troco do frentista");
    await finish(page, dialog, "Salvar correção");
    await expect(page.getByTestId("operation-details")).toContainText("Troco do frentista");

    await menuItem(page, "Ações", "Corrigir partidas…");
    dialog = dialogOf(page, "Editar lançamento");
    await pick(page, dialog, "Integrante da partida 1", "Ana");
    await dialog.getByLabel(/Motivo da correção/).fill("Quem paga a gasolina");
    await finish(page, dialog, "Salvar correção");

    // classification
    await menuItem(page, "Ações", "Reclassificar…");
    dialog = dialogOf(page, "Reclassificar lançamentos");
    await pick(page, dialog, "Nova categoria", "Despesa: Lazer");
    await dialog.getByLabel(/Motivo/).fill("Passeio de domingo");
    await finish(page, dialog, "Reclassificar");

    await menuItem(page, "Ações", "Marcadores…");
    dialog = dialogOf(page, "Marcadores");
    await dialog.getByLabel("Marcador", { exact: true }).fill("Passeio");
    await finish(page, dialog, "Aplicar");
    await expect(page.getByTestId("operation-details")).toContainText("Passeio");

    await menuItem(page, "Ações", "Nomear estabelecimento…");
    dialog = dialogOf(page, "Nomear estabelecimento");
    await dialog.getByLabel(/Nome do estabelecimento/).fill("Shell Centro");
    await finish(page, dialog, "Salvar nome");
    await expect(page.getByTestId("operation-details")).toContainText("Shell Centro");

    // a receipt: attach, open, close
    await page
      .getByLabel("Escolher o comprovante")
      .setInputFiles({ name: "nota.png", mimeType: "image/png", buffer: PNG });
    await page.getByRole("button", { name: "Abrir comprovante" }).click();
    dialog = dialogOf(page, "Comprovante");
    await expect(dialog.getByRole("img", { name: "Comprovante nota.png" })).toBeVisible();
    await dialog.getByRole("button", { name: "Fechar" }).last().click();
    await expect(dialog).toHaveCount(0);

    // planning from an operation
    await menuItem(page, "Ações", "Reembolso a receber…");
    dialog = dialogOf(page, "Reembolso a receber");
    await fill(dialog, "Quem reembolsa", "Empresa");
    await fill(dialog, "Valor esperado", "100,00");
    await finish(page, dialog, "Registrar");
    await expect(page.getByTestId("operation-details")).toContainText("Empresa");

    await menuItem(page, "Ações", "Marcar categoria como dedutível…");
    dialog = dialogOf(page, /Despesa dedutível/);
    await pick(page, dialog, "Tipo de dedução", "Saúde");
    await finish(page, dialog, "Salvar");

    await menuItem(page, "Ações", "Conferir saldo da conta…");
    dialog = dialogOf(page, /Conferir saldo/);
    await fill(dialog, "Saldo no banco", "8.000,00");
    await finish(page, dialog, "Conferir");

    await menuItem(page, "Ações", "Está certo");
    await menuItem(page, "Ações", "Histórico");
    dialog = dialogOf(page, "Histórico");
    await expect(dialog).toContainText("Troco do frentista");
    await dialog.getByRole("button", { name: "Fechar" }).last().click();
    await expect(dialog).toHaveCount(0);

    // an income detail
    await pickRow(page, "Salário");
    await menuItem(page, "Ações", "Detalhar rendimento");
    dialog = dialogOf(page, "Detalhar rendimento");
    await fill(dialog, "Bruto", "9.000,00");
    await finish(page, dialog, "Salvar");

    // reverse one entry and cancel another
    await pickRow(page, "Aluguel");
    await menuItem(page, "Ações", "Estornar…");
    dialog = dialogOf(page, "Estornar lançamento");
    await dialog.getByLabel(/Motivo/).fill("Cobrança indevida");
    await finish(page, dialog, "Estornar");

    await pickRow(page, "Padaria Real");
    await menuItem(page, "Ações", "Cancelar lançamento…");
    dialog = dialogOf(page, "Cancelar lançamento");
    await dialog.getByLabel(/Motivo/).fill("Lançado em duplicidade");
    await finish(page, dialog, "Cancelar lançamento");
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
    await pick(page, page, "Período", "Este ano");
    await pick(page, page, "Período", "Personalizado");
    await page.getByLabel("Data inicial").fill("01/03/2026");
    await page.getByLabel("Data final").fill("31/03/2026");
    await expect.poll(() => page.locator("[data-row-id]").count()).toBeGreaterThan(0);
    await pick(page, page, "Período", "Todo o período");
    await pick(page, page, "Conta ou categoria", "Categoria: Moradia");
    await pick(page, page, "Integrante", "Todos os integrantes");
    await pick(page, page, "Situação", "Só ativos");
    await pick(page, page, "Origem", "Manual");
    await expect.poll(() => page.locator("[data-row-id]").count()).toBe(3);

    // a filter saved in the project, applied and deleted
    await menuItem(page, "Filtros salvos", "Salvar filtro atual…");
    let dialog = dialogOf(page, "Salvar filtro");
    await dialog.getByLabel(/^Nome do filtro/).fill("Só a moradia");
    await finish(page, dialog, "Salvar filtro");
    await page.getByRole("button", { name: "Limpar filtros" }).first().click();
    await menuItem(page, "Filtros salvos", "Só a moradia");
    await expect.poll(() => page.locator("[data-row-id]").count()).toBe(3);
    await menuItem(page, "Filtros salvos", /Excluir “Só a moradia”/);
    await page.getByRole("button", { name: "Limpar filtros" }).first().click();

    // columns
    await menuItem(page, "Colunas", "Ocultar Origem");
    await expect(page.getByRole("columnheader", { name: "Origem" })).toHaveCount(0);
    await menuItem(page, "Colunas", "Mostrar Origem");
    await expect(page.getByRole("columnheader", { name: "Origem" })).toBeVisible();

    // ticking: with the mouse, from the menu and with Space; then sorting
    await page.getByRole("row").nth(1).getByRole("checkbox").click();
    await expect(page.getByText("1 marcado")).toBeVisible();
    await menuItem(page, "Ações", /Marcar os \d+ exibidos/);
    await expect(page.getByText(`${all} marcados`)).toBeVisible();
    await page.getByRole("button", { name: "Limpar marcação" }).first().click();
    await page.getByRole("columnheader", { name: "Valor" }).getByRole("button").click();
    await expect(page.getByRole("columnheader", { name: "Valor" })).toHaveAttribute("aria-sort", "ascending");
    await page.getByRole("columnheader", { name: "Valor" }).getByRole("button").click();
    await page.getByRole("columnheader", { name: "Valor" }).getByRole("button").click();

    // export: the whole book and what is shown, each after the warning
    for (const item of ["Livro completo (CSV)", "Lançamentos exibidos (CSV)"]) {
      const download = page.waitForEvent("download");
      await menuItem(page, "Exportar", item);
      await page.getByRole("alertdialog").getByRole("button", { name: "Exportar CSV" }).click();
      expect((await download).suggestedFilename()).toMatch(/\.csv$/);
    }

    // the local AI: categories (reviewed, applied) and names
    await menuItem(page, "IA local", "Sugerir categorias…");
    dialog = dialogOf(page, "Sugestões de categoria");
    await expect(dialog.getByRole("table")).toBeVisible();
    await dialog.getByRole("button", { name: "Desmarcar todas" }).click();
    await dialog.getByRole("button", { name: "Reclassificar marcadas" }).click();
    await expect(dialog.getByRole("alert")).toContainText("Marque ao menos uma sugestão");
    await dialog.getByRole("checkbox", { name: "Aluguel" }).click();
    await finish(page, dialog, "Reclassificar marcadas");

    await menuItem(page, "IA local", "Sugerir nomes de estabelecimentos…");
    dialog = dialogOf(page, "Nomes de estabelecimentos");
    await expect(dialog.getByRole("table")).toBeVisible();
    await finish(page, dialog, "Aprovar marcados");

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
    await edit.getByLabel(/Motivo da correção/).fill("Teste no celular");
    await finish(page, edit, "Salvar correção");
    await sheet.getByRole("button", { name: "Mais ações" }).click();
    await page.getByRole("menuitem", { name: /^Histórico/ }).click();
    await expect(dialogOf(page, "Histórico")).toContainText("Teste no celular");
    await expectNoHorizontalOverflow(page);
    expect(errors).toEqual([]);
  });
});
