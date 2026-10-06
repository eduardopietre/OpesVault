/**
 * Orçamento end to end (docs/18 §5, SCREENS.md): the demonstration project, every button and menu item,
 * every dialog submitted, no console errors, no sideways scroll at the five sizes, axe clean, light and dark.
 */
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import {
  SCHEMES,
  SIZES,
  expectNoHorizontalOverflow,
  openDemo,
  recordAddresses,
  settle,
  watchErrors,
} from "../helpers.ts";

async function audit(page: Page, label: string) {
  await page.mouse.move(1, 1); // a hovered button is another color: audit the resting state
  await settle(page, 250);
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

for (const size of SIZES) {
  for (const scheme of SCHEMES) {
    test.describe(`${size.width}x${size.height} ${scheme}`, () => {
      test.use({ viewport: size, colorScheme: scheme, contextOptions: { reducedMotion: "reduce" } });

      test("every button and dialog works, cleanly", async ({ page }) => {
        const errors = watchErrors(page);
        const phone = size.width < 640;
        const addresses = await recordAddresses(page);
        await openDemo(page, "/orcamento");
        const table = page.getByRole(phone ? "listbox" : "grid", { name: "Orçamento por categoria" });
        await expect(table).toBeVisible();
        await expect(page.getByText("Estourado").first()).toBeVisible();
        await expect(page.getByText("Perto do limite").first()).toBeVisible();
        // the charts draw (lazy chunk) without the fallback message
        await expect(page.locator("canvas").first()).toBeVisible();
        await expect(page.getByText("Não foi possível desenhar o gráfico")).toHaveCount(0);
        await settle(page);
        await expectNoHorizontalOverflow(page);
        await audit(page, "orçamento");

        // select a row: the actions for it appear
        await table.getByText("Alimentação").first().click();
        await expect(page.getByText("Selecionada:")).toBeVisible();
        await expectNoHorizontalOverflow(page);

        // Alterar valor…
        await page.getByRole("button", { name: "Alterar valor…" }).click();
        let dialog = page.getByRole("dialog", { name: /Orçamento de/ });
        await expect(dialog).toBeVisible();
        await expect(dialog.getByLabel("Planejado para o mês")).toHaveValue("600,00");
        await expectNoHorizontalOverflow(page);
        await audit(page, "alterar valor");
        await dialog.getByLabel("Planejado para o mês").fill("700,00");
        await dialog.getByRole("button", { name: "Salvar" }).click();
        await expect(dialog).toBeHidden();
        await expect(table.getByText("R$ 700,00")).toBeVisible();

        // Remover do orçamento, then Desfazer in the notice
        await page.getByRole("button", { name: "Remover do orçamento" }).click();
        await expect(table.getByText("Alimentação")).toHaveCount(0);
        await page.getByRole("button", { name: "Desfazer", exact: true }).click();
        await expect(table.getByText("Alimentação").first()).toBeVisible();

        // Ver lançamentos goes to the ledger with the category and the month, and back
        await table.getByText("Transporte").first().click();
        await page.getByRole("button", { name: "Ver lançamentos" }).click();
        // the Livro reads its link and clears it from the address at once
        await expect.poll(async () => (await addresses()).some((u) => /\/livro\?.*ref=categoria/.test(u))).toBe(true);
        await expect(page.getByRole("heading", { level: 1, name: "Livro financeiro" })).toBeVisible();
        await page.goBack();
        await expect(page.getByRole("heading", { level: 1, name: "Orçamento" })).toBeVisible();

        // Mais: Definir valor… (choosing the category), Copiar do mês anterior, Alterar, Remover, Ver
        await page.getByRole("button", { name: "Mais", exact: true }).click();
        await page.getByRole("menuitem", { name: "Definir valor…" }).click();
        dialog = page.getByRole("dialog", { name: /Orçamento de/ });
        await dialog.getByRole("button", { name: "Salvar" }).click();
        await expect(dialog.getByText("Escolha a categoria.")).toBeVisible();
        await audit(page, "definir valor com erro");
        await dialog.getByRole("combobox", { name: "Categoria" }).click();
        await page.getByRole("option", { name: "Lazer" }).click();
        await dialog.getByLabel("Planejado para o mês").fill("300");
        await dialog.getByRole("button", { name: "Salvar" }).click();
        await expect(dialog).toBeHidden();
        await expect(table.getByText("Lazer")).toBeVisible();

        for (const item of ["Alterar valor…", "Ver lançamentos"]) {
          await table.getByText("Moradia").first().click();
          await page.getByRole("button", { name: "Mais", exact: true }).click();
          await page.getByRole("menuitem", { name: item }).click();
          if (item === "Alterar valor…") {
            await page
              .getByRole("dialog", { name: /Orçamento de/ })
              .getByRole("button", { name: "Cancelar" })
              .click();
          } else {
            await expect(page).toHaveURL(/\/livro/);
            await page.goBack();
            await expect(page.getByRole("heading", { level: 1, name: "Orçamento" })).toBeVisible();
          }
        }
        await table.getByText("Moradia").first().click();
        await page.getByRole("button", { name: "Mais", exact: true }).click();
        await page.getByRole("menuitem", { name: "Remover do orçamento" }).click();
        await page.getByRole("button", { name: "Desfazer", exact: true }).click();

        // the whole month in the grid, copying from the previous month, then saving
        await page.getByRole("button", { name: "Mês anterior", exact: true }).click();
        await page.getByRole("button", { name: "Mês anterior", exact: true }).click();
        await page.getByRole("button", { name: "Mês anterior", exact: true }).click();
        await expect(page.getByRole("heading", { name: "Sem orçamento neste mês" })).toBeVisible();
        await audit(page, "mês vazio");
        await page.getByRole("button", { name: "Definir o mês…" }).click();
        dialog = page.getByRole("dialog", { name: /Orçamento de/ });
        await expect(dialog.getByLabel("Planejado para Lazer")).toBeVisible();
        await expectNoHorizontalOverflow(page);
        await audit(page, "grade do mês");
        await dialog.getByLabel("Planejado para Lazer").fill("1.250,75");
        await dialog.getByRole("button", { name: "Copiar do mês anterior" }).click();
        await dialog.getByLabel("Planejado para Lazer").fill("abc");
        await dialog.getByRole("button", { name: "Salvar orçamento" }).click();
        await expect(dialog.getByText("Lazer: informe um valor positivo ou deixe vazio.")).toBeVisible();
        await dialog.getByLabel("Planejado para Lazer").fill("1.250,75");
        await dialog.getByRole("button", { name: "Salvar orçamento" }).click();
        await expect(dialog).toBeHidden();
        await expect(table.getByText("Lazer")).toBeVisible();

        // Copiar do mês anterior (menu), and the notice when there is nothing more to copy
        await page.getByRole("button", { name: "Mais", exact: true }).click();
        await page.getByRole("menuitem", { name: "Copiar do mês anterior" }).click();
        await expect(page.getByText(/Nada a copiar|copiada/).first()).toBeVisible();

        // the next month and back to this one
        await page.getByRole("button", { name: "Próximo mês", exact: true }).click();
        await page.getByRole("button", { name: "Próximo mês", exact: true }).click();
        await page.getByRole("button", { name: "Próximo mês", exact: true }).click();

        // every collapsible section opens and closes
        const toggles = page.locator("button[aria-expanded]");
        for (let index = 0; index < (await toggles.count()); index++) {
          const toggle = toggles.nth(index);
          await toggle.click();
          await toggle.click();
        }
        await expectNoHorizontalOverflow(page);
        await audit(page, "depois de usar");
        expect(errors).toEqual([]);
      });

      test("opens the category and the action asked by a link, once", async ({ page }) => {
        const errors = watchErrors(page);
        const addresses = await recordAddresses(page);
        await openDemo(page, "/orcamento");
        const table = page.getByRole(size.width < 640 ? "listbox" : "grid", { name: "Orçamento por categoria" });
        await table.getByText("Transporte").first().click();
        await page.getByRole("button", { name: "Ver lançamentos" }).click();
        await expect.poll(async () => (await addresses()).some((u) => u.includes("ref=categoria"))).toBe(true);
        const ref = new URL(
          (await addresses()).find((u) => u.includes("ref=categoria")) ?? "",
          "http://x",
        ).searchParams.get("ref");
        expect(ref).toMatch(/^categoria:[^:]+:\d{4}-\d{2}$/);
        await page.goBack();
        // go there with an action, as the overview alerts do
        const id = ref!.split(":")[1]!;
        await page.evaluate(
          ([target]) => {
            window.history.pushState({}, "", `/orcamento?ref=categoria:${target}&act=alterar`);
            window.dispatchEvent(new PopStateEvent("popstate"));
          },
          [id],
        );
        const dialog = page.getByRole("dialog", { name: /Orçamento de/ });
        await expect(dialog).toBeVisible();
        await expect(dialog.getByLabel("Planejado para o mês")).toHaveValue("120,00");
        await dialog.getByRole("button", { name: "Cancelar" }).click();
        await expect(dialog).toBeHidden();
        await expect(page).not.toHaveURL(/act=/);
        expect(errors).toEqual([]);
      });
    });
  }
}
