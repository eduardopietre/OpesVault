/** Pieces the Investimentos end-to-end specs share. */
import AxeBuilder from "@axe-core/playwright";
import { expect, type Locator, type Page } from "@playwright/test";
import { expectNoHorizontalOverflow, settle } from "../helpers.ts";

export async function audit(page: Page, label: string) {
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

/** A table: a grid, or a list of cards on a phone. */
export const tableOf = (page: Page, name: string, phone: boolean): Locator =>
  page.getByRole(phone ? "listbox" : "grid", { name, exact: true });

/** The open dialog by its name; checks it fits and is accessible. */
export async function openDialog(page: Page, name: string | RegExp, label: string): Promise<Locator> {
  const dialog = page.getByRole("dialog", { name });
  await expect(dialog).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await audit(page, label);
  return dialog;
}

export const submit = async (dialog: Locator, name: string) =>
  dialog.getByRole("button", { name, exact: true }).click();

/** Chooses an option of a select. */
export async function choose(page: Page, dialog: Locator | Page, label: string, option: string | RegExp) {
  await dialog.getByRole("combobox", { name: label, exact: true }).click();
  await page.getByRole("listbox", { name: label, exact: true }).getByRole("option", { name: option }).first().click();
}

/** A command of one of the header menus ("Registrar", "Negociação", "Mais"). */
export async function menu(page: Page, button: string, item: string | RegExp) {
  await page.getByRole("button", { name: button, exact: true }).click();
  await page.getByRole("menuitem", typeof item === "string" ? { name: item, exact: true } : { name: item }).click();
}

/** Types into a field by its label (a required field's label ends with "*"). */
export const field = (scope: Locator | Page, label: string) =>
  scope.getByLabel(new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\*?$`));

/** The notice (toast) with this text. */
export const notice = (page: Page, text: string | RegExp) => page.getByText(text).first();
