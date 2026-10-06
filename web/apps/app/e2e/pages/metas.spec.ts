/**
 * Metas end to end (docs/18 §5, SCREENS.md): the demonstration project, every button and menu item, every
 * dialog submitted, no console errors, no sideways scroll at the five sizes, axe clean, light and dark.
 */
import AxeBuilder from "@axe-core/playwright";
import { animationsDone } from "../helpers.ts";
import { expect, test, type Page } from "@playwright/test";
import { SCHEMES, SIZES, expectNoHorizontalOverflow, openDemo, settle, watchErrors } from "../helpers.ts";

async function audit(page: Page, label: string) {
  await page.mouse.move(1, 1); // a hovered button is another color: audit the resting state
  await settle(page, 250);
  await animationsDone(page);
  const result = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    .analyze();
  expect(
    result.violations.map(
      (violation) =>
        `${label}: ${violation.id} (${violation.impact}) ${violation.nodes
          .map((node) => `${node.target.join(" ")} ${node.failureSummary ?? ""}`)
          .slice(0, 3)
          .join(", ")}`,
    ),
  ).toEqual([]);
}

const dialogOf = (page: Page, name: string | RegExp) => page.getByRole("dialog", { name });
const tableOf = (page: Page) => page.locator('[role="grid"][aria-label="Metas"], [role="listbox"][aria-label="Metas"]');

for (const size of SIZES) {
  for (const scheme of SCHEMES) {
    test.describe(`${size.width}x${size.height} ${scheme}`, () => {
      test.use({ viewport: size, colorScheme: scheme, contextOptions: { reducedMotion: "reduce" } });

      test("every button and dialog works, cleanly", async ({ page }) => {
        const errors = watchErrors(page);
        await openDemo(page, "/metas");
        const table = tableOf(page);
        await expect(table).toBeVisible();
        await expect(table.getByText("Reserva de emergência").first()).toBeVisible();
        await expect(table.getByText("54%").first()).toBeVisible();
        // the selected goal's chart draws (lazy chunk) and its values sit beside or below it
        await expect(page.locator("canvas").first()).toBeVisible();
        await expect(page.getByText("Não foi possível desenhar o gráfico")).toHaveCount(0);
        await expect(page.getByRole("table", { name: "Valores de Meta: Reserva de emergência" })).toBeVisible();
        await settle(page);
        await expectNoHorizontalOverflow(page);
        await audit(page, "metas");

        // Nova meta…: refuses, then creates (over chosen accounts, with a deadline)
        await page.getByRole("button", { name: "Nova meta…" }).click();
        let dialog = dialogOf(page, "Nova meta");
        await dialog.getByRole("button", { name: "Criar meta" }).click();
        await expect(dialog.getByText("Dê um nome à meta.")).toBeVisible();
        await audit(page, "nova meta com erro");
        await dialog.getByLabel("Nome").fill("Viagem");
        await dialog.getByLabel("Valor da meta").fill("8.000");
        await dialog.getByRole("combobox", { name: "Conta como" }).click();
        await page.getByRole("option", { name: "Saldo de contas escolhidas" }).click();
        await dialog.getByRole("button", { name: "Criar meta" }).click();
        await expect(dialog.getByText("Escolha as contas que formam a meta.")).toBeVisible();
        await dialog.getByRole("checkbox", { name: "Poupança" }).click();
        await dialog.getByRole("checkbox", { name: /Prazo/ }).click();
        await dialog.getByLabel("Prazo", { exact: true }).fill("31/12/2030");
        await expectNoHorizontalOverflow(page);
        await audit(page, "nova meta");
        await dialog.getByRole("button", { name: "Criar meta" }).click();
        await expect(dialog).toBeHidden();
        await expect(table.getByText("Viagem").first()).toBeVisible();
        await expect(page.getByRole("table", { name: "Valores de Meta: Viagem" })).toBeVisible();
        await expect(page.getByText("2 meta(s) ativa(s)")).toBeVisible();

        // select the other goal: its chart and details follow
        await table.getByText("Reserva de emergência").first().click();
        await expect(page.getByRole("table", { name: "Valores de Meta: Reserva de emergência" })).toBeVisible();

        // Editar meta… (button of the selection)
        await page.getByRole("button", { name: "Editar meta…" }).click();
        dialog = dialogOf(page, "Editar meta");
        await expect(dialog.getByLabel("Valor da meta")).toHaveValue("30.000,00");
        await expectNoHorizontalOverflow(page);
        await audit(page, "editar meta");
        await dialog.getByLabel("Valor da meta").fill("32.000,00");
        await dialog.getByRole("button", { name: "Salvar", exact: true }).click();
        await expect(dialog).toBeHidden();
        await expect(table.getByText("R$ 32.000,00").first()).toBeVisible();

        // Mais: Editar meta… and Arquivar ou reativar…
        await page.getByRole("button", { name: "Mais", exact: true }).click();
        await page.getByRole("menuitem", { name: "Editar meta…" }).click();
        await dialogOf(page, "Editar meta").getByRole("button", { name: "Cancelar" }).click();
        await expect(dialogOf(page, "Editar meta")).toHaveCount(0);

        await page.getByRole("button", { name: "Mais", exact: true }).click();
        await page.getByRole("menuitem", { name: "Arquivar ou reativar…" }).click();
        dialog = dialogOf(page, "Arquivar meta");
        await dialog.getByRole("button", { name: "Arquivar", exact: true }).click();
        await expect(dialog.getByText("O motivo é obrigatório.")).toBeVisible();
        await audit(page, "arquivar meta com erro");
        await dialog.getByLabel(/Motivo/).fill("Concluída");
        await dialog.getByRole("button", { name: "Arquivar", exact: true }).click();
        await expect(dialog).toBeHidden();
        await expect(table.getByText("arquivada").first()).toBeVisible();
        await expect(page.getByText("1 meta(s) ativa(s)")).toBeVisible();
        await page.getByRole("button", { name: "Reativar…" }).click();
        dialog = dialogOf(page, "Reativar meta");
        await dialog.getByLabel(/Motivo/).fill("Voltou");
        await dialog.getByRole("button", { name: "Reativar", exact: true }).click();
        await expect(dialog).toBeHidden();
        await expect(page.getByText("2 meta(s) ativa(s)")).toBeVisible();

        // every collapsible part of the chart opens and closes
        const toggles = page.locator("button[aria-expanded]");
        for (let index = 0; index < (await toggles.count()); index++) {
          const toggle = toggles.nth(index);
          if (!(await toggle.isVisible())) continue;
          await toggle.click();
          await toggle.click();
        }
        await expectNoHorizontalOverflow(page);
        await audit(page, "depois de usar");
        expect(errors).toEqual([]);
      });

      test("opens the goal a link names, with its form when asked, once", async ({ page }) => {
        const errors = watchErrors(page);
        await openDemo(page, "/metas");
        const table = tableOf(page);
        await expect(table).toBeVisible();
        const id = await table.locator("[data-row-id]").first().getAttribute("data-row-id");
        await page.evaluate((target) => {
          window.history.pushState({}, "", `/metas?ref=${target}&act=editar`);
          window.dispatchEvent(new PopStateEvent("popstate"));
        }, id);
        const dialog = dialogOf(page, "Editar meta");
        await expect(dialog).toBeVisible();
        await expect(dialog.getByLabel("Nome")).toHaveValue("Reserva de emergência");
        await dialog.getByRole("button", { name: "Cancelar" }).click();
        await expect(dialog).toBeHidden();
        await expect(page).not.toHaveURL(/act=/);
        expect(errors).toEqual([]);
      });
    });
  }
}
