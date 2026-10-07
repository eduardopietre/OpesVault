/** Dialogs, menus, selects, tabs and tables as the end-to-end specs drive them. */
import { expect, type Locator, type Page } from "@playwright/test";
import { auditWith, expectNoHorizontalOverflow, settle, type AuditOptions } from "./helpers.ts";

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A name given as text matches from its start (a menu item has its shortcut after it). */
export const fromStart = (text: string | RegExp): RegExp =>
  typeof text === "string" ? new RegExp(`^${escape(text)}`) : text;

/** A label as typed, with or without the "*" of a required field. */
export const labelled = (label: string): RegExp => new RegExp(`^${escape(label)}\\s*\\*?$`);

/** The dialog with this name (open or not). */
export const dialogOf = (page: Page, name: string | RegExp): Locator => page.getByRole("dialog", { name });

/**
 * The audit of a spec (see `AuditOptions`) and `openDialog`, which waits for a dialog by its name, checks that it
 * fits and passes that audit, and returns it.
 */
export function audited(options: AuditOptions = {}) {
  const audit = auditWith(options);
  async function openDialog(page: Page, name: string | RegExp, label: string): Promise<Locator> {
    const dialog = dialogOf(page, name);
    await expect(dialog).toBeVisible();
    await expectNoHorizontalOverflow(page);
    await audit(page, label);
    return dialog;
  }
  return { audit, openDialog };
}

/** A tab of the page's own list (the shell has other tabs and navigation); waits for it to be selected. */
export async function goTab(page: Page, name: string): Promise<void> {
  await page.getByRole("tab", { name, exact: true }).click();
  await expect(page.getByRole("tab", { name, exact: true })).toHaveAttribute("aria-selected", "true");
  await settle(page, 200);
}

/**
 * A table whose form the size decides: the grid, or on a phone its list of cards. Unlike `tableOf`, the role is
 * checked too.
 */
export const tableAt = (page: Page, name: string, phone: boolean): Locator =>
  page.getByRole(phone ? "listbox" : "grid", { name, exact: true });

/** Clicks the button of `scope` with exactly this name. */
export const submit = (scope: Locator, name: string): Promise<void> =>
  scope.getByRole("button", { name, exact: true }).click();

/** Clicks the dialog's button with exactly this name and waits until the dialog is gone. */
export async function submitAndClose(dialog: Locator, name: string): Promise<void> {
  await submit(dialog, name);
  await expect(dialog).toHaveCount(0);
}

/** Gives the reason a dialog asks for, confirms with exactly `confirm` and waits until the dialog is gone. */
export async function giveReason(
  dialog: Locator,
  reason: string,
  confirm: string,
  label: string | RegExp = /Motivo/,
): Promise<void> {
  await dialog.getByLabel(label).fill(reason);
  await submitAndClose(dialog, confirm);
}

/** Chooses an option of a select whose options are listed under its own name (the first that matches). */
export async function choose(page: Page, scope: Locator | Page, label: string, option: string | RegExp) {
  await scope.getByRole("combobox", { name: label, exact: true }).click();
  await page.getByRole("listbox", { name: label, exact: true }).getByRole("option", { name: option }).first().click();
}

/** Chooses an option of a select: the one with exactly this text, or that matches. */
export async function pickOption(page: Page, scope: Locator | Page, label: string, option: string | RegExp) {
  await scope.getByRole("combobox", { name: label, exact: true }).click();
  await page.getByRole("option", { name: option, exact: typeof option === "string" }).click();
}

/** Opens the menu button with exactly this name and clicks an item (text matches from its start). */
export async function menu(page: Page, button: string, item: string | RegExp): Promise<void> {
  await page.getByRole("button", { name: button, exact: true }).click();
  await page.getByRole("menuitem", { name: fromStart(item) }).click();
}
