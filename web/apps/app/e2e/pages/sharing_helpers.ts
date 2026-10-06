/** Helpers of the Reembolsos e acertos and Documentos end-to-end tests. */
import AxeBuilder from "@axe-core/playwright";
import { animationsDone } from "../helpers.ts";
import { expect, type Page } from "@playwright/test";
import { settle } from "../helpers.ts";
import { pickRow } from "./livro_helpers.ts";

export async function audit(page: Page, label: string) {
  await page.mouse.move(1, 1); // a hovered button is another color: audit the resting state
  await settle(page, 250);
  await animationsDone(page);
  const result = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    // a notice fading in or out has the contrast of its half-transparent text for a moment
    .exclude("[data-tone]")
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

/**
 * A table by its name. The same data is a card list ("listbox") when the room it has is narrow, which depends on
 * the container and not on the window, so both are accepted.
 */
export const tableOf = (page: Page, name: string, _phone = false) =>
  page.getByRole("grid", { name, exact: true }).or(page.getByRole("listbox", { name, exact: true }));

/** Goes to a destination with the keyboard sequence `g` + letter. */
export async function goTo(page: Page, letter: string, path: RegExp): Promise<void> {
  await page.keyboard.press("g");
  await page.keyboard.press(letter);
  await expect(page).toHaveURL(path);
}

/**
 * The demonstration's pediatrician was paid from a joint account, so nothing is owed between members. The
 * way to create a debt is the one a person uses: in the Livro, a card purchase of Ana's card is made the
 * responsibility of Bruno (Ações › Corrigir partidas…), and Bruno owes Ana its amount.
 */
export async function shareAnExpense(page: Page, description = "Restaurante Bom Prato"): Promise<void> {
  await pickRow(page, description);
  // on a phone the details open in a sheet, and the commands are inside it
  const sheet = page.getByRole("dialog", { name: "Detalhes do lançamento" });
  const inSheet = await sheet.isVisible();
  await (
    inSheet
      ? sheet.getByRole("button", { name: "Mais ações" })
      : page.getByRole("button", { name: "Ações", exact: true })
  ).click();
  await page.getByRole("menuitem", { name: /^Corrigir partidas…/ }).click();
  const dialog = page.getByRole("dialog", { name: "Editar lançamento" });
  await dialog.getByRole("combobox", { name: "Responsável", exact: true }).click();
  await page.getByRole("option", { name: "Bruno", exact: true }).click();
  await dialog.getByLabel(/Motivo da correção/).fill("Despesa do Bruno");
  await dialog.getByRole("button", { name: "Salvar correção", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  if (inSheet) {
    await sheet.getByRole("button", { name: "Fechar" }).first().click();
    await expect(sheet).toHaveCount(0);
  }
}

/** Attaches a receipt to the first operation that matches `description`, the way the Livro does it. */
export async function attach(
  page: Page,
  description: string,
  file: { name: string; mimeType: string; buffer: Buffer },
) {
  await pickRow(page, description);
  await page.getByLabel("Escolher o comprovante").setInputFiles(file);
  await expect(page.getByText(/anexado/i).first()).toBeVisible();
  // on a phone the details are a sheet that covers the search box
  const sheet = page.getByRole("dialog", { name: "Detalhes do lançamento" });
  if (await sheet.isVisible()) {
    await sheet.getByRole("button", { name: "Fechar" }).first().click();
    await expect(sheet).toHaveCount(0);
  }
}
