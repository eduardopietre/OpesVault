/** Helpers of the Recorrências end-to-end tests and screenshots. */
import type { Locator, Page } from "@playwright/test";

export const dialogOf = (page: Page, name: string | RegExp) => page.getByRole("dialog", { name });

export async function pick(page: Page, scope: Locator | Page, name: string, option: string | RegExp) {
  await scope.getByRole("combobox", { name, exact: true }).click();
  await page.getByRole("option", { name: option, exact: typeof option === "string" }).click();
}

export async function menuItem(page: Page, item: string) {
  await page.getByRole("button", { name: "Mais", exact: true }).click();
  await page.getByRole("menuitem", { name: item, exact: true }).click();
}

/** A table by its accessible name: a grid, or a list of cards on phones. */
export const tableOf = (page: Page, name: string) =>
  page.locator(`[role="grid"][aria-label="${name}"], [role="listbox"][aria-label="${name}"]`);
