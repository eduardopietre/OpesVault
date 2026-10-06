/** Helpers of the Recorrências end-to-end tests and screenshots: driving the app to the data the demonstration lacks. */
import { expect, type Locator, type Page } from "@playwright/test";

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

/** dd/mm/aaaa of the first day of the month `back` months before the app's today. */
export async function firstOfMonth(page: Page, back: number): Promise<string> {
  return page.evaluate((offset) => {
    const now = new Date();
    const d = new Date(now.getFullYear(), now.getMonth() - offset, 1);
    return `01/${String(d.getMonth() + 1).padStart(2, "0")}/${d.getFullYear()}`;
  }, back);
}

/** Creates a rule due on the app's today, from Banco A, through the dialog. */
export async function createRule(page: Page, description: string, value: string, category: string) {
  const todayDay = await page.evaluate(() => String(new Date().getDate()));
  await page.getByRole("button", { name: "Nova recorrência…" }).first().click();
  const dialog = dialogOf(page, "Nova recorrência");
  await dialog.getByLabel("Descrição").fill(description);
  await pick(page, dialog, "Conta", "Banco A");
  await pick(page, dialog, "Categoria", category);
  await dialog.getByLabel("Valor esperado").fill(value);
  await dialog.getByLabel("Dia do vencimento").fill(todayDay);
  await dialog.getByRole("button", { name: "Criar recorrência" }).click();
  await expect(dialog).toBeHidden();
}

/** Moves inside the app without reloading it (a reload would open a fresh demonstration project). */
export async function goTo(page: Page, path: string) {
  await page.evaluate((target) => {
    window.history.pushState({}, "", target);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }, path);
}

/** Three months in a row of one charge, through the Livro; the project stays open between the pages. */
export async function recordRepeatingCharge(page: Page, description: string, value: string) {
  await goTo(page, "/livro");
  await expect(page.getByRole("heading", { level: 1, name: "Livro financeiro" })).toBeVisible();
  for (const back of [2, 1, 0]) {
    await page.getByRole("button", { name: "Novo lançamento" }).click();
    await page.getByRole("menuitem", { name: "Despesa", exact: true }).click();
    const dialog = dialogOf(page, "Despesa");
    await dialog.getByLabel("Descrição", { exact: true }).fill(description);
    await dialog.getByLabel("Valor", { exact: true }).fill(value);
    await dialog.getByLabel("Data", { exact: true }).fill(await firstOfMonth(page, back));
    await dialog.getByRole("button", { name: "Registrar", exact: true }).click();
    await expect(dialog).toHaveCount(0);
  }
  await goTo(page, "/recorrencias");
  await expect(page.getByRole("heading", { level: 1, name: "Recorrências" })).toBeVisible();
}
