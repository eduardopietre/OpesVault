/**
 * Reembolsos e acertos end to end (docs/18 §5, SCREENS.md): the demonstration project, every button, every
 * dialog submitted, no console errors, no sideways scroll at the five sizes, axe clean, light and dark.
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
import { audit, goTo, shareAnExpense, tableOf } from "./sharing_helpers.ts";

for (const size of SIZES) {
  for (const scheme of SCHEMES) {
    test.describe(`reembolsos ${size.width}x${size.height} ${scheme}`, () => {
      test.use({ viewport: size, colorScheme: scheme, contextOptions: { reducedMotion: "reduce" } });
      const phone = size.width < 640;

      test("every button and dialog works, cleanly", async ({ page }) => {
        const errors = watchErrors(page);
        const addresses = await recordAddresses(page);
        await openDemo(page, "/livro");
        await expect(page.locator("[data-row-id]").first()).toBeVisible();
        await shareAnExpense(page);
        await goTo(page, "b", /\/reembolsos$/);
        await expect(page.getByRole("heading", { level: 1, name: "Reembolsos e acertos" })).toBeVisible();

        const reimbursements = tableOf(page, "Reembolsos", phone);
        const balances = tableOf(page, "Saldos entre integrantes", phone);
        await expect(reimbursements).toBeVisible();
        await expect(reimbursements.getByText("Recebido em parte").first()).toBeVisible();
        await expect(balances.getByText("Bruno").first()).toBeVisible();
        await expect(
          tableOf(page, "Despesas que formam o saldo", phone).getByText("Restaurante Bom Prato"),
        ).toBeVisible();
        await settle(page);
        await expectNoHorizontalOverflow(page);
        await audit(page, "reembolsos");

        // without a selection the buttons only guide
        await page.getByRole("button", { name: "Registrar recebimento…" }).click();
        await expect(page.getByText("Selecione um reembolso na tabela.").first()).toBeVisible();
        await expect(page.getByRole("dialog")).toHaveCount(0);

        // Registrar recebimento…: the missing amount is suggested; an empty value is refused
        await reimbursements.getByText("Consulta pediatra").click();
        await page.getByRole("button", { name: "Registrar recebimento…" }).click();
        let dialog = page.getByRole("dialog", { name: "Reembolso recebido" });
        await expect(dialog.getByLabel("Valor recebido")).toHaveValue("150,00");
        await expectNoHorizontalOverflow(page);
        await audit(page, "reembolso recebido");
        await dialog.getByLabel("Valor recebido").fill("");
        await dialog.getByRole("button", { name: "Registrar recebimento", exact: true }).click();
        await expect(dialog.getByText("Informe o valor.")).toBeVisible();
        await audit(page, "reembolso recebido com erro");
        await dialog.getByLabel("Valor recebido").fill("50,00");
        await dialog.getByRole("button", { name: "Registrar recebimento", exact: true }).click();
        await expect(dialog).toBeHidden();
        await expect(reimbursements.getByText("R$ 200,00").first()).toBeVisible();

        // Desfazer with the project's shortcut brings the 150,00 back
        await page.keyboard.press("Control+z");
        await expect(reimbursements.getByText("R$ 200,00")).toHaveCount(0);
        await page.keyboard.press("Control+Shift+z");
        await expect(reimbursements.getByText("R$ 200,00").first()).toBeVisible();

        // Registrar acerto…: the pair and amount of the selected balance, then a refusal and the record
        await page.getByRole("button", { name: "Registrar acerto…" }).click();
        dialog = page.getByRole("dialog", { name: "Registrar acerto" });
        await expect(dialog.getByRole("combobox", { name: "Quem pagou" })).toContainText("Bruno");
        await expect(dialog.getByRole("combobox", { name: "Para quem" })).toContainText("Ana");
        await expectNoHorizontalOverflow(page);
        await audit(page, "registrar acerto");
        await dialog.getByRole("combobox", { name: "Para quem" }).click();
        await page.getByRole("option", { name: "Bruno", exact: true }).click();
        await dialog.getByRole("button", { name: "Registrar", exact: true }).click();
        await expect(dialog.getByText("Escolha dois integrantes diferentes.")).toBeVisible();
        await dialog.getByRole("combobox", { name: "Para quem" }).click();
        await page.getByRole("option", { name: "Ana", exact: true }).click();
        await dialog.getByLabel("Valor", { exact: true }).fill("30,00");
        await dialog.getByLabel("Observação").fill("Pix de sábado");
        await dialog.getByRole("button", { name: "Registrar", exact: true }).click();
        await expect(dialog).toBeHidden();
        const history = tableOf(page, "Acertos registrados", phone);
        await expect(history.getByText("R$ 30,00")).toBeVisible();

        // double click on a balance opens the settlement already filled
        await balances.getByText("Bruno").first().dblclick();
        dialog = page.getByRole("dialog", { name: "Registrar acerto" });
        await expect(dialog).toBeVisible();
        await dialog.getByRole("button", { name: "Cancelar" }).click();
        await expect(dialog).toBeHidden();

        // Negado…: the reason is required
        await reimbursements.getByText("Consulta pediatra").click();
        await page.getByRole("button", { name: "Negado…" }).click();
        dialog = page.getByRole("dialog", { name: "Reembolso negado" });
        await dialog.getByRole("button", { name: "Marcar como negado" }).click();
        await expect(dialog.getByText("O motivo é obrigatório.")).toBeVisible();
        await audit(page, "reembolso negado");
        await dialog.getByLabel("Motivo").fill("Fora da cobertura");
        await dialog.getByRole("button", { name: "Marcar como negado" }).click();
        await expect(dialog).toBeHidden();
        await expect(reimbursements.getByText("Negado").first()).toBeVisible();

        // Ver lançamento (reimbursement) and the share's, each in the Livro, and back
        await reimbursements.getByText("Consulta pediatra").click();
        await page.getByRole("button", { name: "Ver lançamento" }).first().click();
        await expect.poll(async () => (await addresses()).some((u) => /\/livro\?.*ref=/.test(u))).toBe(true);
        await expect(page.getByRole("heading", { level: 1, name: "Livro financeiro" })).toBeVisible();
        await page.goBack();
        await expect(page.getByRole("heading", { level: 1, name: "Reembolsos e acertos" })).toBeVisible();
        await tableOf(page, "Despesas que formam o saldo", phone).getByText("Restaurante Bom Prato").click();
        await page
          .getByText("Selecionado:")
          .locator("xpath=../..")
          .getByRole("button", { name: "Ver lançamento" })
          .click();
        await expect(page).toHaveURL(/\/livro/);
        await page.goBack();
        await expect(page.getByRole("heading", { level: 1, name: "Reembolsos e acertos" })).toBeVisible();

        // every collapsible section closes and opens
        const toggles = page.locator("button[aria-expanded]");
        for (let index = 0; index < (await toggles.count()); index++) {
          const toggle = toggles.nth(index);
          await toggle.click();
          await toggle.click();
        }
        await settle(page);
        await expectNoHorizontalOverflow(page);
        await audit(page, "depois de usar");
        expect(errors).toEqual([]);
      });

      test("the demonstration alone shows only its reimbursement", async ({ page }) => {
        const errors = watchErrors(page);
        await openDemo(page, "/reembolsos");
        // the demonstration has a reimbursement and no balance: the balance section is not shown
        await expect(page.getByRole("heading", { name: "Reembolsos", exact: true })).toBeVisible();
        await expect(page.getByRole("heading", { name: "Acertos entre integrantes" })).toHaveCount(0);
        await expectNoHorizontalOverflow(page);
        await audit(page, "só reembolsos");
        expect(errors).toEqual([]);
      });

      test("opens the reimbursement and starts the receipt from a link", async ({ page }) => {
        const errors = watchErrors(page);
        await openDemo(page, "/livro");
        await page.getByRole("searchbox", { name: "Buscar lançamentos" }).fill("Consulta pediatra");
        // the refund received is an operation of its own that carries the same words
        const expense = page.locator("[data-row-id]").filter({ hasText: "Consulta pediatra", hasNotText: "Reembolso" });
        await expect(expense.first()).toBeVisible();
        const id = await expense.first().getAttribute("data-row-id");
        await page.evaluate(
          ([target]) => {
            window.history.pushState({}, "", `/reembolsos?ref=${target}&act=receber`);
            window.dispatchEvent(new PopStateEvent("popstate"));
          },
          [id],
        );
        const dialog = page.getByRole("dialog", { name: "Reembolso recebido" });
        await expect(dialog).toBeVisible();
        await expect(dialog.getByLabel("Valor recebido")).toHaveValue("150,00");
        await dialog.getByRole("button", { name: "Cancelar" }).click();
        await expect(dialog).toBeHidden();
        await expect(page).not.toHaveURL(/act=/);
        expect(errors).toEqual([]);
      });
    });
  }
}
