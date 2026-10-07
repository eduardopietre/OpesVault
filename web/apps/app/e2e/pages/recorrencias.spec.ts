/**
 * Recorrências end to end (docs/18 §5, SCREENS.md): the demonstration project, every button and menu item,
 * every dialog submitted, no console errors, no sideways scroll at the five sizes, axe clean, light and dark.
 * A second block seeds what the demonstration lacks (an operation to link, a charge that repeats) through the
 * app itself and walks the link, the suggestions and the creation from a candidate.
 */
import AxeBuilder from "@axe-core/playwright";
import { animationsDone } from "../helpers.ts";
import { expect, test, type Page } from "@playwright/test";
import {
  TEST_SCHEMES,
  TEST_SIZES,
  expectNoHorizontalOverflow,
  openDemo,
  recordAddresses,
  settle,
  watchErrors,
} from "../helpers.ts";
import { dialogOf, menuItem, pick, tableOf } from "./recorrencias_helpers.ts";

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

for (const size of TEST_SIZES) {
  for (const scheme of TEST_SCHEMES) {
    test.describe(`${size.width}x${size.height} ${scheme}`, () => {
      test.use({ viewport: size, colorScheme: scheme, contextOptions: { reducedMotion: "reduce" } });

      test("every button and dialog works, cleanly", async ({ page }) => {
        const errors = watchErrors(page);
        const addresses = await recordAddresses(page);
        await openDemo(page, "/recorrencias");
        const rules = tableOf(page, "Regras de recorrência");
        const forecasts = tableOf(page, "Previsões");
        await expect(rules).toBeVisible();
        await expect(forecasts).toBeVisible();
        await expect(rules.getByText("Aluguel").first()).toBeVisible();
        await expect(forecasts.getByText("Atrasada").first()).toBeVisible();
        await expect(forecasts.getByText("Prevista").first()).toBeVisible();
        await expect(tableOf(page, "Assinaturas e contas fixas")).toBeVisible();
        await expect(page.getByText(/2 regra\(s\) ativa\(s\)/)).toBeVisible();
        await settle(page);
        await expectNoHorizontalOverflow(page);
        await audit(page, "recorrências");

        // without a selection the commands ask for one, never open a dialog
        await page.getByRole("button", { name: "Editar…" }).click();
        await expect(page.getByText("Selecione uma regra.").first()).toBeVisible();
        await page.getByRole("button", { name: "Vincular realizado…" }).click();
        await expect(page.getByText("Selecione uma previsão.").first()).toBeVisible();
        await expect(page.getByRole("dialog")).toHaveCount(0);

        // Editar…: the form starts from the rule; saving changes the table
        await rules.getByText("Aluguel").first().click();
        await page.getByRole("button", { name: "Editar…" }).click();
        let dialog = dialogOf(page, "Editar recorrência");
        await expect(dialog).toBeVisible();
        await expect(dialog.getByLabel("Valor esperado")).toHaveValue("2.350,00");
        await expectNoHorizontalOverflow(page);
        await audit(page, "editar recorrência");
        await dialog.getByLabel("Valor esperado").fill("2.400,00");
        await dialog.getByRole("button", { name: "Salvar", exact: true }).click();
        await expect(dialog).toBeHidden();
        await expect(rules.getByText("R$ 2.400,00").first()).toBeVisible();
        await expect(page.getByText("Recorrência atualizada.").first()).toBeVisible();

        // Pausar / Retomar
        await page.getByRole("button", { name: "Pausar", exact: true }).click();
        await expect(rules.getByText("Pausada").first()).toBeVisible();
        // the paused rule leaves the forecasts: the late ones were its own
        await expect(forecasts.getByText("Atrasada")).toHaveCount(0);
        await audit(page, "regra pausada");
        await page.getByRole("button", { name: "Retomar", exact: true }).click();
        await expect(forecasts.getByText("Atrasada").first()).toBeVisible();

        // a forecast with nothing to link
        await forecasts.getByText("Atrasada").first().click();
        await page.getByRole("button", { name: "Vincular realizado…" }).click();
        await expect(page.getByText("Nenhum lançamento compatível (conta, valor e data).").first()).toBeVisible();

        // Mais: Pular previsão (with Desfazer), the single-candidate suggestions, the projection
        await menuItem(page, "Pular previsão");
        await expect(forecasts.getByText("Pulada")).toBeVisible();
        await page.getByRole("button", { name: "Desfazer", exact: true }).click();
        await expect(forecasts.getByText("Pulada")).toHaveCount(0);
        // the condominium fee due today has one compatible entry: it is offered, and refusing links nothing
        await menuItem(page, "Vincular sugestões únicas");
        const offer = page.getByRole("alertdialog");
        await expect(offer.getByText(/Condomínio ← Condomínio/)).toBeVisible();
        await offer.getByRole("button", { name: "Cancelar" }).click();
        await expect(offer).toHaveCount(0);
        await menuItem(page, "Projeção de compromissos (Relatórios)");
        await expect
          .poll(async () => (await addresses()).some((url) => /\/relatorios\?.*ref=projected_balance/.test(url)))
          .toBe(true);
        await expect(page.getByRole("heading", { level: 1, name: "Relatórios" })).toBeVisible();
        await page.goBack();
        await expect(page.getByRole("heading", { level: 1, name: "Recorrências" })).toBeVisible();

        // Nova recorrência…: the form refuses, then creates
        await page.getByRole("button", { name: "Nova recorrência…" }).click();
        dialog = dialogOf(page, "Nova recorrência");
        await dialog.getByRole("button", { name: "Criar recorrência" }).click();
        await expect(dialog.getByText("Informe a descrição.")).toBeVisible();
        await audit(page, "nova recorrência com erro");
        await dialog.getByLabel("Descrição").fill("Academia");
        await pick(page, dialog, "Conta", "Banco A");
        await pick(page, dialog, "Categoria", "Despesa: Lazer");
        await dialog.getByLabel("Valor esperado").fill("99,90");
        await dialog.getByLabel("Dia do vencimento").fill("15");
        await pick(page, dialog, "Frequência", "Semanal");
        await expect(dialog.getByLabel("Dia do vencimento")).toBeDisabled();
        await pick(page, dialog, "Frequência", "Mensal");
        await expectNoHorizontalOverflow(page);
        await dialog.getByRole("button", { name: "Criar recorrência" }).click();
        await expect(dialog).toBeHidden();
        await expect(rules.getByText("Academia").first()).toBeVisible();
        await expect(tableOf(page, "Assinaturas e contas fixas").getByText("Academia").first()).toBeVisible();
        await expectNoHorizontalOverflow(page);

        // every collapsible section closes and opens
        const toggles = page.locator("button[aria-expanded]");
        for (let index = 0; index < (await toggles.count()); index++) {
          const toggle = toggles.nth(index);
          if (!(await toggle.isVisible())) continue;
          await toggle.click();
          await toggle.click();
        }
        await audit(page, "depois de usar");
        expect(errors).toEqual([]);
      });

      test("opens the forecast a link names, ready to link, once", async ({ page }) => {
        const errors = watchErrors(page);
        const addresses = await recordAddresses(page);
        await openDemo(page, "/recorrencias");
        const forecasts = tableOf(page, "Previsões");
        await expect(forecasts).toBeVisible();
        // the id of the first late forecast, from its row
        const row = forecasts.locator("[data-row-id]").first();
        const ref = await row.getAttribute("data-row-id");
        expect(ref).toMatch(/^[^:]+:\d{4}-\d{2}-\d{2}$/);
        await page.evaluate((target) => {
          window.history.pushState({}, "", `/recorrencias?ref=${target}&act=vincular`);
          window.dispatchEvent(new PopStateEvent("popstate"));
        }, ref);
        await expect(page.getByText("Nenhum lançamento compatível (conta, valor e data).").first()).toBeVisible();
        await expect(row).toHaveAttribute("aria-selected", "true");
        expect((await addresses()).some((url) => url.includes("act=vincular"))).toBe(true);
        await expect(page).not.toHaveURL(/act=/);
        // a rule link opens the subscriptions with the rule selected
        const ruleId = ref!.split(":")[0];
        await page.evaluate((target) => {
          window.history.pushState({}, "", `/recorrencias?ref=rule:${target}`);
          window.dispatchEvent(new PopStateEvent("popstate"));
        }, ruleId);
        await expect(tableOf(page, "Assinaturas e contas fixas").locator(`[data-row-id="${ruleId}"]`)).toHaveAttribute(
          "aria-selected",
          "true",
        );
        expect(errors).toEqual([]);
      });
    });
  }
}

test.describe("recorrências: linking and the charges that repeat, on the web demonstration's own data", () => {
  test.use({ viewport: { width: 1920, height: 1080 }, contextOptions: { reducedMotion: "reduce" } });

  test("links a forecast, links the single candidates, and creates a rule from a repeating charge", async ({
    page,
  }) => {
    const errors = watchErrors(page);
    await openDemo(page, "/recorrencias");
    const forecasts = tableOf(page, "Previsões");
    const due = forecasts.locator("[data-row-id]", { hasText: "Condomínio" }).first();
    // the condominium fee is due today and the entry that paid it is in the book
    await due.click();
    await page.getByRole("button", { name: "Vincular realizado…" }).click();
    let dialog = dialogOf(page, "Vincular realizado");
    await expect(dialog.getByRole("radio")).toHaveCount(1);
    await expect(dialog.getByText(/Condomínio/).first()).toBeVisible();
    await audit(page, "vincular realizado");
    await dialog.getByRole("button", { name: "Vincular", exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(due.getByText("Realizada")).toBeVisible();
    await expect(tableOf(page, "Assinaturas e contas fixas").getByText("Como previsto")).toBeVisible();
    await page
      .getByRole("button", { name: /^Desfazer/ })
      .first()
      .click();
    await expect(due.getByText("Realizada")).toHaveCount(0);

    // the same link as a suggestion: nothing changes until it is confirmed
    await menuItem(page, "Vincular sugestões únicas");
    const ask = page.getByRole("alertdialog");
    await expect(ask.getByText(/Condomínio ← Condomínio/)).toBeVisible();
    await audit(page, "vincular sugestões");
    await ask.getByRole("button", { name: "Cancelar" }).click();
    await menuItem(page, "Vincular sugestões únicas");
    await page.getByRole("alertdialog").getByRole("button", { name: "Vincular", exact: true }).click();
    await expect(page.getByText("1 previsão(ões) vinculada(s).").first()).toBeVisible();
    await expect(due.getByText("Realizada")).toBeVisible();
    await page
      .getByRole("button", { name: /^Desfazer/ })
      .first()
      .click();
    await expect(due.getByText("Realizada")).toHaveCount(0);

    // a charge that repeats for three months in a row is offered; the rule is created from it
    const candidates = tableOf(page, "Cobranças que parecem recorrentes");
    await expect(candidates.getByText("Academia Fit")).toBeVisible();
    await audit(page, "cobranças que parecem recorrentes");
    await page.getByRole("button", { name: "Criar recorrência…" }).click();
    await expect(page.getByText("Selecione uma cobrança.").first()).toBeVisible();
    await candidates.getByText("Academia Fit").click();
    await page.getByRole("button", { name: "Criar recorrência…" }).click();
    dialog = dialogOf(page, "Nova recorrência");
    await expect(dialog.getByLabel("Descrição")).toHaveValue("Academia Fit");
    await expect(dialog.getByLabel("Valor esperado")).toHaveValue("119,90");
    await dialog.getByRole("button", { name: "Criar recorrência" }).click();
    await expect(dialog).toBeHidden();
    await expect(candidates).toHaveCount(0);
    await expect(tableOf(page, "Regras de recorrência").getByText("Academia Fit")).toBeVisible();
    expect(errors).toEqual([]);
  });
});
