/** Small Testing Library helpers the page tests share: viewport, text, rows, dialogs, fields, menus, undo. */
import { act as reactAct, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect } from "vitest";

export type User = ReturnType<typeof userEvent.setup>;

/** happy-dom evaluates media queries against the viewport: the wide band shows the inspector beside the table. */
export function setViewport(width: number, height = 900): void {
  (window as unknown as { happyDOM: { setViewport(v: { width: number; height: number }): void } }).happyDOM.setViewport(
    { width, height },
  );
}

/** A line of a table or card list, with its spaces collapsed. */
export const flat = (text: string | null | undefined) => (text ?? "").replace(/\s+/g, " ").trim();

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A label or name given as text matches from its start: required fields add "*", menu items a shortcut. */
export function starts(text: string | RegExp): string | RegExp {
  if (typeof text !== "string") return text;
  return new RegExp("^" + escape(text));
}

/** A label as typed, with or without the "*" of a required field. */
const labelPattern = (label: string | RegExp) =>
  typeof label === "string" ? new RegExp(`^${escape(label)}\\s*\\*?$`) : label;

/** The table (grid) with that accessible name; waits for it. */
export const table = (name: string) => screen.findByRole("grid", { name });

/** The first row of a table whose text (spaces collapsed) contains `text`. */
export function rowOf(grid: HTMLElement, text: string | RegExp): HTMLElement {
  const rows = within(grid)
    .getAllByRole("row")
    .filter((row) =>
      typeof text === "string" ? flat(row.textContent).includes(text) : text.test(flat(row.textContent)),
    );
  if (rows.length === 0) throw new Error(`no row with ${String(text)} in ${grid.getAttribute("aria-label")}`);
  return rows[0]!;
}

/** The row of a table by the id the table gives it (a bill's month, an installment's number). */
export function rowById(grid: HTMLElement, id: string): HTMLElement {
  const row = grid.querySelector<HTMLElement>(`[data-row-id="${id}"]`);
  if (!row) throw new Error(`no row ${id} in ${grid.getAttribute("aria-label")}`);
  return row;
}

/** Selects the row of a table that holds `text` (a click on the row). */
export async function clickRow(user: User, grid: HTMLElement, text: string | RegExp) {
  await user.click(rowOf(grid, text));
}

/** Clicks the first `text` inside the table with that name (selecting its row); returns the table. */
export async function clickInTable(user: User, tableName: string, text: string | RegExp) {
  const grid = await table(tableName);
  await user.click(within(grid).getAllByText(text)[0]!);
  return grid;
}

/** The selected row of a table, if any. */
export const selectedRow = (grid: HTMLElement) =>
  within(grid)
    .getAllByRole("row")
    .find((row) => row.getAttribute("aria-selected") === "true");

/** Chooses a tab and returns its panel. */
export async function goTab(user: User, name: string) {
  await user.click(screen.getByRole("tab", { name }));
  await waitFor(() => expect(screen.getByRole("tab", { name }).getAttribute("aria-selected")).toBe("true"));
  return screen.getByRole("tabpanel");
}

/** Waits for a dialog (by its name, or any). */
export const dialog = (name?: string | RegExp, options: { timeout?: number } = {}) =>
  screen.findByRole("dialog", name ? { name } : {}, options);

/** Waits until the dialog with that name is gone. */
export const closed = (name: string | RegExp) =>
  waitFor(() => expect(screen.queryByRole("dialog", { name })).toBeNull());

/** Opens a select (inside `scope`, the whole screen by default) and chooses an option by its name. */
export async function choose(user: User, label: string | RegExp, option: string | RegExp, scope?: HTMLElement) {
  const root = scope ? within(scope) : screen;
  await user.click(root.getByRole("combobox", { name: label }));
  await user.click(await screen.findByRole("option", { name: option }));
}

/** Replaces the text of a field found by its label (with or without the "*" of a required field). */
export async function fill(user: User, scope: HTMLElement, label: string | RegExp, text: string) {
  const field = within(scope).getByLabelText(labelPattern(label)) as HTMLInputElement;
  await user.clear(field);
  if (text) await user.type(field, text);
}

/** Clicks a button of `scope` by its name. */
export const submit = (user: User, scope: HTMLElement, name: string | RegExp) =>
  user.click(within(scope).getByRole("button", { name }));

/** Opens a menu button and chooses one of its items; an item given as text matches from its start (a shortcut follows). */
export async function menu(user: User, button: string | RegExp, item: string | RegExp) {
  await user.click(screen.getByRole("button", { name: button }));
  await user.click(await screen.findByRole("menuitem", { name: starts(item) }));
}

/** Undoes the last step of the project, as the shell's "Desfazer" does. */
export const undoOnce = (workspace: { undo(): unknown }) => reactAct(() => void workspace.undo());
