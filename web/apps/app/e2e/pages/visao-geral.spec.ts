/**
 * Visão geral end to end (docs/18 §5, SCREENS.md): every button and menu item, the dialogs, the print view
 * of the report, no console errors, no sideways scrolling at the five sizes and axe clean, in light and dark.
 */
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { SCHEMES, SIZES, expectNoHorizontalOverflow, openDemo, settle, watchErrors } from "../helpers.ts";

async function audit(page: Page, label: string) {
  await settle(page, 300);
  const result = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    .analyze();
  expect(
    result.violations.map(
      (v) =>
        `${label}: ${v.id} (${v.impact}) ${v.nodes
          .map((n) => n.target.join(" "))
          .slice(0, 3)
          .join(", ")}`,
    ),
  ).toEqual([]);
}

async function stubPrint(page: Page) {
  await page.addInitScript(() => {
    (window as unknown as { __prints: number }).__prints = 0;
    window.print = () => {
      (window as unknown as { __prints: number }).__prints++;
    };
  });
}

const prints = (page: Page) => page.evaluate(() => (window as unknown as { __prints: number }).__prints);

for (const size of SIZES) {
  for (const scheme of SCHEMES) {
    test.describe(`visão geral ${size.width}x${size.height} ${scheme}`, () => {
      test.use({ viewport: size, colorScheme: scheme });

      test("renders cleanly, never scrolls sideways and passes axe", async ({ page }) => {
        const errors = watchErrors(page);
        await openDemo(page, "/visao-geral");
        await expect(page.getByRole("heading", { level: 1, name: "Visão geral" })).toBeVisible();
        await expect(page.getByRole("region", { name: "Atenção" })).toBeVisible();
        await expect(page.getByRole("heading", { name: "Caixa" })).toBeVisible();
        // The chart is drawn from its values, without a fallback message.
        await expect(page.locator("canvas").first()).toBeVisible();
        await expect(page.getByText("Não foi possível desenhar o gráfico")).toHaveCount(0);
        await settle(page, 1200);
        await expectNoHorizontalOverflow(page);
        await audit(page, "visão geral");
        // Scrolled to the end, with every part open.
        await page.evaluate(() => document.getElementById("conteudo")?.scrollTo(0, 1e6));
        await expectNoHorizontalOverflow(page);
        expect(errors).toEqual([]);
      });

      test("the print view of the report fits the screen and passes axe", async ({ page }) => {
        const errors = watchErrors(page);
        await openDemo(page, "/imprimir/relatorio-mensal");
        await expect(page.getByRole("heading", { level: 1, name: /Projeto Teste — / })).toBeVisible();
        await expectNoHorizontalOverflow(page);
        await audit(page, "relatório");
        expect(errors).toEqual([]);
      });
    });
  }
}

test.describe("visão geral: every action", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test("every notice goes to the place where it is resolved", async ({ page }) => {
    const errors = watchErrors(page);
    await openDemo(page, "/visao-geral");
    const panel = page.getByRole("region", { name: "Atenção" });
    await panel.getByRole("button", { name: /Mostrar todos/ }).click();
    const buttons = panel.getByRole("listitem").getByRole("button");
    const count = await buttons.count();
    expect(count).toBeGreaterThan(6);
    await panel.getByRole("button", { name: "Mostrar menos" }).click();
    await expect(panel.getByRole("listitem")).toHaveCount(6);
    const targets: string[] = [];
    for (let index = 0; index < count; index++) {
      await openDemo(page, "/visao-geral");
      const again = page.getByRole("region", { name: "Atenção" });
      await again.getByRole("button", { name: /Mostrar todos/ }).click();
      await again.getByRole("listitem").getByRole("button").nth(index).click();
      await expect(page).not.toHaveURL(/\/visao-geral/);
      const url = new URL(page.url());
      targets.push(`${url.pathname}${url.search ? " " + decodeURIComponent(url.search) : ""}`);
    }
    // The links carry the object and the action (page.url is read before the destination clears them).
    expect(targets.some((t) => t.startsWith("/contas") && t.includes("act=pagar"))).toBe(true);
    expect(targets.some((t) => t.startsWith("/recorrencias") && t.includes("act=vincular"))).toBe(true);
    // Orçamento consumes its ref at once (it selects the category), so only the destination is checked.
    expect(targets.some((t) => t.startsWith("/orcamento"))).toBe(true);
    expect(targets.some((t) => t.startsWith("/importar"))).toBe(true);
    expect(targets.some((t) => t.startsWith("/livro") && t.includes("filter:"))).toBe(true);
    expect(errors).toEqual([]);
  });

  test("hides the attention panel until the next opening and shows it again", async ({ page }) => {
    const errors = watchErrors(page);
    await openDemo(page, "/visao-geral");
    await page.getByRole("button", { name: "Ocultar" }).click();
    await expect(page.getByRole("region", { name: "Atenção" })).toHaveCount(0);
    await expect(page.getByText(/avisos ocultos até a próxima abertura/)).toBeVisible();
    await page.getByRole("button", { name: "Mostrar avisos" }).click();
    await expect(page.getByRole("region", { name: "Atenção" })).toBeVisible();
    await page.getByRole("button", { name: "Ocultar" }).click();
    // Opened again (a new opening of the project): the panel is back.
    await openDemo(page, "/visao-geral");
    await expect(page.getByRole("region", { name: "Atenção" })).toBeVisible();
    expect(errors).toEqual([]);
  });

  test("lines of the tables open the operations; the month, member and sections work", async ({ page }) => {
    const errors = watchErrors(page);
    await openDemo(page, "/visao-geral");
    // Month picker: previous, next, and the list of months.
    const picker = page.getByRole("group", { name: "Mês" });
    await picker.getByRole("button", { name: "Mês anterior" }).click();
    await expect(picker.getByRole("button", { name: /setembro de 2026/i })).toBeVisible();
    await picker.getByRole("button", { name: "Próximo mês" }).click();
    await expect(picker.getByRole("button", { name: /outubro de 2026/i })).toBeVisible();
    await picker.getByRole("button", { name: /Escolher outro mês/ }).click();
    await page.getByRole("button", { name: "março de 2026" }).click();
    await expect(picker.getByRole("button", { name: /março de 2026/i })).toBeVisible();
    // The member's view.
    await page.getByRole("combobox", { name: "Visão de" }).click();
    await page.getByRole("option", { name: "Ana" }).click();
    await expect(page.getByText(/das contas de que é titular/)).toBeVisible();
    await page.getByRole("combobox", { name: "Visão de" }).click();
    await page.getByRole("option", { name: "Projeto inteiro" }).click();
    await expect(page.getByText(/Saldos de todas as contas/)).toBeVisible();
    // Sections fold and unfold.
    for (const title of ["Indicadores", "Comparado aos meses anteriores", "Mês a mês", "Valores"]) {
      const toggle = page.getByRole("button", { name: title, exact: true });
      await toggle.click();
      await expect(toggle).toHaveAttribute("aria-expanded", "false");
      await toggle.click();
      await expect(toggle).toHaveAttribute("aria-expanded", "true");
    }
    // A line of "Despesas por categoria" opens its operations in the Livro.
    const categories = page.getByRole("region", { name: "Despesas por categoria" });
    await categories.getByRole("button").first().click();
    await expect(page).toHaveURL(/\/livro/);
    expect(decodeURIComponent(page.url())).toContain("filter:");
    expect(errors).toEqual([]);
  });

  test("closes the month with pending items (reason required), undoes, then reopens with a reason", async ({
    page,
  }) => {
    const errors = watchErrors(page);
    await openDemo(page, "/visao-geral");
    await expect(page.getByText("Mês aberto")).toBeVisible();
    await page.getByRole("button", { name: "Fechar mês…" }).click();
    const close = page.getByRole("dialog", { name: "Fechar com pendências" });
    await expect(close.getByText(/previsão\(ões\) recorrente\(s\) sem realização/)).toBeVisible();
    await audit(page, "fechar com pendências");
    // A reason is required; Cancel closes nothing.
    await close.getByRole("button", { name: "Fechar mês" }).click();
    await expect(close.getByText("O motivo é obrigatório.")).toBeVisible();
    await close.getByRole("button", { name: "Cancelar" }).click();
    await expect(close).toHaveCount(0);
    await expect(page.getByText("Mês aberto")).toBeVisible();
    await page.getByRole("button", { name: "Fechar mês…" }).click();
    await close.getByLabel(/Justificativa/).fill("Aluguel pago em dinheiro");
    await close.getByRole("button", { name: "Fechar mês" }).click();
    await expect(page.getByText("Mês fechado", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Reabrir mês…" })).toBeVisible();
    // One undo reverts the closing.
    await page.getByRole("button", { name: /^Desfazer/ }).click();
    await expect(page.getByText("Mês aberto")).toBeVisible();
    // Close again, then reopen with a reason.
    await page.getByRole("button", { name: "Fechar mês…" }).click();
    await close.getByLabel(/Justificativa/).fill("De novo");
    await close.getByRole("button", { name: "Fechar mês" }).click();
    await page.getByRole("button", { name: "Reabrir mês…" }).click();
    const reopen = page.getByRole("dialog", { name: "Reabrir mês" });
    await audit(page, "reabrir mês");
    await reopen.getByRole("button", { name: "Reabrir mês" }).click();
    await expect(reopen.getByText("O motivo é obrigatório.")).toBeVisible();
    await reopen.getByLabel(/Motivo/).fill("Faltou um recibo");
    await reopen.getByRole("button", { name: "Reabrir mês" }).click();
    await expect(page.getByText("Mês aberto")).toBeVisible();
    await page.getByRole("button", { name: /^Desfazer/ }).click();
    await expect(page.getByText("Mês fechado", { exact: true })).toBeVisible();
    expect(errors).toEqual([]);
  });

  test("the Mais menu: full comparison, and the report printed from its own view", async ({ page }) => {
    const errors = watchErrors(page);
    await stubPrint(page);
    await openDemo(page, "/visao-geral");
    await page.getByRole("button", { name: "Mais" }).click();
    await page.getByRole("menuitem", { name: "Comparação completa (Relatórios)" }).click();
    await expect(page).toHaveURL(/\/relatorios/);
    expect(decodeURIComponent(page.url())).toContain("ref=comparison");
    await openDemo(page, "/visao-geral");
    await page.getByRole("button", { name: "Comparação completa", exact: true }).click();
    await expect(page).toHaveURL(/\/relatorios/);
    await openDemo(page, "/visao-geral");
    await page.getByRole("button", { name: "Mais" }).click();
    await page.getByRole("menuitem", { name: "Relatório do mês em PDF…" }).click();
    await expect(page).toHaveURL(/\/imprimir\/relatorio-mensal/);
    await expect(page.getByRole("heading", { level: 1, name: /Projeto Teste — outubro de 2026/ })).toBeVisible();
    await expect.poll(() => prints(page)).toBe(1);
    for (const title of [
      "Resumo",
      "Comparado aos meses anteriores",
      "Despesas por categoria",
      "Vencimentos do mês",
      "Indicadores",
      "Pendências",
    ]) {
      await expect(page.getByRole("heading", { level: 2, name: title })).toBeVisible();
    }
    await page.getByRole("button", { name: "Imprimir ou salvar em PDF" }).click();
    await expect.poll(() => prints(page)).toBe(2);
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page.getByRole("button", { name: "Baixar como arquivo HTML" }).click(),
    ]);
    expect(download.suggestedFilename()).toBe("resumo-2026-10.html");
    await page.getByRole("button", { name: "Voltar à Visão geral" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Visão geral" })).toBeVisible();
    expect(errors).toEqual([]);
  });

  test("the pending items link to where they are resolved", async ({ page }) => {
    const errors = watchErrors(page);
    await openDemo(page, "/visao-geral");
    await page.getByRole("button", { name: /^Ver previsões:/ }).click();
    await expect(page).toHaveURL(/\/recorrencias/);
    expect(errors).toEqual([]);
  });
});

test.describe("visão geral on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("shows fewer notices first, and every action stays reachable", async ({ page }) => {
    const errors = watchErrors(page);
    await openDemo(page, "/visao-geral");
    const panel = page.getByRole("region", { name: "Atenção" });
    await expect(panel.getByRole("listitem")).toHaveCount(3);
    await panel.getByRole("button", { name: /Mostrar todos/ }).click();
    await expect(panel.getByRole("listitem").nth(5)).toBeVisible();
    await page.getByRole("button", { name: "Fechar mês…" }).click();
    await expect(page.getByRole("dialog", { name: "Fechar com pendências" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expectNoHorizontalOverflow(page);
    expect(errors).toEqual([]);
  });
});
