/**
 * Relatórios end to end (docs/18 §5, SCREENS.md): the demonstration project, every report drawn, every filter,
 * button and menu item, the image and values exports, the year-end print view, no console errors, no sideways
 * scroll at the five sizes, axe clean, light and dark.
 */
import {
  auditWith,
  TEST_SCHEMES,
  TEST_SIZES,
  expectNoHorizontalOverflow,
  openDemo,
  recordAddresses,
  settle,
  watchErrors,
  prints,
  stubPrint,
} from "../helpers.ts";
import { expect, test, type Page } from "@playwright/test";

const REPORTS = [
  "Entradas e saídas mensais",
  "Resultado mensal (competência)",
  "Fluxo de caixa",
  "Saldo projetado",
  "Despesas por categoria",
  "Comparação com a média",
  "Patrimônio",
  "Composição da carteira",
  "Projeção de compromissos",
  "Despesas por estabelecimento",
  "Marcadores",
  "Despesas dedutíveis",
  "Fechamento do ano",
] as const;

const audit = auditWith({ skipNotices: false });

/** Opens a report from the list (wide) or from the picker (narrow). */
async function openReport(page: Page, label: string) {
  const list = page.getByRole("navigation", { name: "Relatórios" });
  if (await list.isVisible()) {
    await list.getByRole("button", { name: label, exact: true }).click();
    await expect(list.getByRole("button", { name: label, exact: true })).toHaveAttribute("aria-current", "true");
  } else {
    await page.getByRole("combobox", { name: "Relatório", exact: true }).click();
    await page.getByRole("option", { name: label, exact: true }).click();
    await expect(page.getByRole("combobox", { name: "Relatório", exact: true })).toContainText(label);
  }
}

/** The chart really has pixels: its picture is well beyond that of a blank canvas of the same size. */
async function expectDrawn(page: Page, label: string) {
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const canvas = document.querySelector("canvas");
          if (!canvas || !canvas.width) return 0;
          const blank = document.createElement("canvas");
          blank.width = canvas.width;
          blank.height = canvas.height;
          return canvas.toDataURL().length - blank.toDataURL().length;
        }),
      { message: `${label}: the chart is drawn`, timeout: 10_000 },
    )
    .toBeGreaterThan(1500);
  await expect(page.getByText("Não foi possível desenhar o gráfico")).toHaveCount(0);
}

for (const size of TEST_SIZES) {
  for (const scheme of TEST_SCHEMES) {
    test.describe(`relatórios ${size.width}x${size.height} ${scheme}`, () => {
      test.use({ viewport: size, colorScheme: scheme, contextOptions: { reducedMotion: "reduce" } });

      test("every report is drawn with its table, never scrolls sideways and passes axe", async ({ page }) => {
        const errors = watchErrors(page);
        await openDemo(page, "/relatorios");
        await expect(page.getByRole("heading", { level: 1, name: "Relatórios" })).toBeVisible();
        for (const label of REPORTS) {
          await openReport(page, label);
          await expect(page.getByRole("table", { name: /^Valores de / })).toBeVisible();
          await expectDrawn(page, label);
          await settle(page, 150);
          await expectNoHorizontalOverflow(page);
          await audit(page, label);
        }
        expect(errors).toEqual([]);
      });

      test("the print view of the closing fits the screen and passes axe", async ({ page }) => {
        const errors = watchErrors(page);
        await openDemo(page, "/imprimir/relatorio-anual");
        await expect(page.getByRole("heading", { level: 1, name: /fechamento de 2026/ })).toBeVisible();
        await expect(page.getByRole("heading", { level: 2, name: "Despesas dedutíveis" })).toBeVisible();
        await expectNoHorizontalOverflow(page);
        await audit(page, "relatório anual");
        expect(errors).toEqual([]);
      });
    });
  }
}

test.describe("relatórios: every action", () => {
  test.use({ viewport: { width: 1280, height: 800 }, contextOptions: { reducedMotion: "reduce" } });

  test("filters, points, links to the Livro and exports", async ({ page }) => {
    const errors = watchErrors(page);
    const addresses = await recordAddresses(page);
    await openDemo(page, "/relatorios");
    await expectDrawn(page, "entradas e saídas");

    // every filter of every report
    await page.getByRole("combobox", { name: "Conta", exact: true }).click();
    await page.getByRole("option", { name: "Banco A" }).click();
    await expect(page.getByRole("combobox", { name: "Conta", exact: true })).toContainText("Banco A");
    await expectDrawn(page, "banco a");
    await page.getByRole("combobox", { name: "Período", exact: true }).click();
    await page.getByRole("option", { name: "Últimos 6 meses" }).click();
    await expect(page.getByRole("table", { name: /^Valores de / }).getByRole("row")).toHaveCount(1 + 6 + 2);
    await page.getByRole("combobox", { name: "Período", exact: true }).click();
    await page.getByRole("option", { name: "Últimos 24 meses" }).click();
    await expect(page.getByRole("table", { name: /^Valores de / }).getByRole("row")).toHaveCount(1 + 24 + 2);

    await openReport(page, "Resultado mensal (competência)");
    await page.getByRole("combobox", { name: "Integrante" }).click();
    await page.getByRole("option", { name: "Bruno" }).click();
    await expect(page.getByText(/Visão de Bruno/).first()).toBeVisible();
    await openReport(page, "Despesas por categoria");
    await page.getByRole("combobox", { name: "Categoria", exact: true }).click();
    await page.getByRole("option", { name: "Alimentação" }).click();
    await expect(page.getByRole("table", { name: "Valores de Despesas: Alimentação" })).toBeVisible();
    await openReport(page, "Comparação com a média");
    await page.getByRole("combobox", { name: "Média de comparação" }).click();
    await page.getByRole("option", { name: "Média de 6 meses" }).click();
    await expect(page.getByRole("columnheader", { name: "Média de 6 meses" })).toBeVisible();
    await openReport(page, "Saldo projetado");
    await page.getByRole("combobox", { name: "Horizonte" }).click();
    await page.getByRole("option", { name: "Próximos 30 dias" }).click();
    await expectDrawn(page, "30 dias");
    await openReport(page, "Marcadores");
    await page.getByRole("combobox", { name: "Marcador", exact: true }).click();
    await page.getByRole("option", { name: "Viagem Serra 2026" }).click();
    await expectDrawn(page, "marcador");
    await openReport(page, "Despesas dedutíveis");
    await page.getByRole("combobox", { name: "Ano", exact: true }).click();
    await page.getByRole("option", { name: "Ano de 2025" }).click();
    await expect(page.getByRole("heading", { name: "Sem dados neste relatório" })).toBeVisible();
    await expectNoHorizontalOverflow(page);
    await audit(page, "relatório vazio");
    await page.getByRole("combobox", { name: "Ano", exact: true }).click();
    await page.getByRole("option", { name: "Ano de 2026" }).click();
    await expectDrawn(page, "dedutíveis");

    // a point: from the table, described beside the chart, with its origin in the Livro
    const values = page.getByRole("table", { name: /^Valores de / });
    await values.getByRole("button").first().click();
    const point = page.getByRole("group", { name: "Dados do ponto selecionado" });
    await expect(point).not.toContainText("Clique em um ponto");
    await page.getByRole("button", { name: "Ver lançamentos" }).click();
    await expect.poll(async () => (await addresses()).some((u) => /\/livro\?.*ref=filter/.test(u))).toBe(true);
    await expect(page.getByRole("heading", { level: 1, name: "Livro financeiro" })).toBeVisible();
    await page.goBack();
    await expect(page.getByRole("heading", { level: 1, name: "Relatórios" })).toBeVisible();

    // a point of the chart itself
    await openReport(page, "Entradas e saídas mensais");
    await expectDrawn(page, "entradas");
    const box = (await page.locator("canvas").first().boundingBox())!;
    await page.mouse.click(box.x + box.width - 60, box.y + box.height / 2);
    await settle(page, 300);

    // the image: asked about, cancelled, then downloaded
    await page.getByRole("button", { name: "Exportar imagem…" }).click();
    let ask = page.getByRole("alertdialog", { name: "Exportar imagem sem criptografia?" });
    await expect(ask).toBeVisible();
    await audit(page, "exportar imagem");
    await ask.getByRole("button", { name: "Cancelar" }).click();
    await expect(ask).toBeHidden();
    await page.getByRole("button", { name: "Exportar imagem…" }).click();
    const [image] = await Promise.all([
      page.waitForEvent("download"),
      page.getByRole("alertdialog").getByRole("button", { name: "Exportar", exact: true }).click(),
    ]);
    expect(image.suggestedFilename()).toBe("Entradas e saidas mensais.png");
    await expect(page.getByText(/Imagem do gráfico gerada/)).toBeVisible();

    // the values as CSV
    await page.getByRole("button", { name: "Exportar valores…" }).click();
    ask = page.getByRole("alertdialog", { name: "Exportar valores sem criptografia?" });
    await expect(ask).toBeVisible();
    const [csv] = await Promise.all([
      page.waitForEvent("download"),
      ask.getByRole("button", { name: "Exportar", exact: true }).click(),
    ]);
    expect(csv.suggestedFilename()).toBe("valores-in_out.csv");

    // folding the chart and the values, and unfolding them again
    await page.getByRole("button", { name: "Entradas e saídas mensais", exact: true, expanded: true }).click();
    await expect(page.locator("canvas")).toHaveCount(0);
    await page.getByRole("button", { name: "Entradas e saídas mensais", exact: true, expanded: false }).click();
    await expectDrawn(page, "reaberto");
    await page.getByRole("button", { name: "Valores", exact: true, expanded: true }).click();
    await expect(page.getByRole("table", { name: /^Valores de / })).toHaveCount(0);
    await page.getByRole("button", { name: "Valores", exact: true, expanded: false }).click();

    // the shared month
    await page.getByRole("button", { name: "Mês anterior" }).click();
    await expect(page.getByText(/a setembro de 2026/)).toBeVisible();
    expect(errors).toEqual([]);
  });

  test("the year-end closing is printed from its own view and downloads as the same report", async ({ page }) => {
    const errors = watchErrors(page);
    await stubPrint(page);
    await openDemo(page, "/relatorios");
    await openReport(page, "Fechamento do ano");
    await expect(page.getByRole("button", { name: "Relatório anual (PDF)…" })).toBeVisible();
    await page.getByRole("button", { name: "Relatório anual (PDF)…" }).click();
    await expect(page).toHaveURL(/\/imprimir\/relatorio-anual/);
    await expect(page.getByRole("heading", { level: 1, name: /fechamento de 2026/ })).toBeVisible();
    await expect.poll(() => prints(page)).toBe(1);
    for (const title of [
      "Bens e dívidas em 31/12/2026",
      "Receitas do ano por categoria",
      "Investimentos",
      "Despesas dedutíveis",
    ]) {
      await expect(page.getByRole("heading", { level: 2, name: title })).toBeVisible();
    }
    await page.getByRole("button", { name: "Imprimir ou salvar em PDF" }).click();
    await expect.poll(() => prints(page)).toBe(2);
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page.getByRole("button", { name: "Baixar como arquivo HTML" }).click(),
    ]);
    expect(download.suggestedFilename()).toBe("fechamento-2026.html");
    await page.getByRole("button", { name: "Voltar aos Relatórios" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Relatórios" })).toBeVisible();
    await expect(
      page.getByRole("navigation", { name: "Relatórios" }).getByRole("button", { name: "Fechamento do ano" }),
    ).toHaveAttribute("aria-current", "true");
    expect(errors).toEqual([]);
  });

  test("a link opens the report by its key", async ({ page }) => {
    const errors = watchErrors(page);
    await page.goto("/relatorios?ref=projected_balance&demo");
    const list = page.getByRole("navigation", { name: "Relatórios" });
    await expect(list.getByRole("button", { name: "Saldo projetado" })).toHaveAttribute("aria-current", "true");
    await expectDrawn(page, "saldo projetado");
    await page.goto("/relatorios?ref=comparison&demo");
    await expect(list.getByRole("button", { name: "Comparação com a média" })).toHaveAttribute("aria-current", "true");
    expect(errors).toEqual([]);
  });
});

test.describe("relatórios on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, contextOptions: { reducedMotion: "reduce" } });

  test("the report picker, the filters and the exports stay reachable", async ({ page }) => {
    const errors = watchErrors(page);
    await openDemo(page, "/relatorios");
    await expectDrawn(page, "entradas e saídas");
    await openReport(page, "Despesas por estabelecimento");
    await expectDrawn(page, "estabelecimentos");
    await page.getByRole("combobox", { name: "Período", exact: true }).click();
    await page.getByRole("option", { name: "Últimos 6 meses" }).click();
    await page.getByRole("button", { name: "Exportar imagem…" }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Cancelar" }).click();
    await expectNoHorizontalOverflow(page);
    expect(errors).toEqual([]);
  });
});
