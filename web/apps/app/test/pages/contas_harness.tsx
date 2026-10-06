/** Mounting Contas e cartões on the demonstration project (or an empty or read-only one) for its tests. */
import { screen, waitFor, within, act as reactAct } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect } from "vitest";
import { mountPage, type MountOptions } from "./overview_calendar_helpers.tsx";
import { setViewport } from "./livro_harness.tsx";

export type User = ReturnType<typeof userEvent.setup>;

export async function openContas(path = "/contas", options: MountOptions & { width?: number } = {}) {
  setViewport(options.width ?? 1600);
  const mounted = await mountPage(path, options);
  await screen.findByRole("heading", { level: 1, name: "Contas e cartões" });
  return { ...mounted, ledger: mounted.workspace.ledger, user: userEvent.setup() };
}

/** Chooses a tab and returns its panel. */
export async function goTab(user: User, name: string) {
  await user.click(screen.getByRole("tab", { name }));
  await waitFor(() => expect(screen.getByRole("tab", { name }).getAttribute("aria-selected")).toBe("true"));
  return screen.getByRole("tabpanel");
}

export const flat = (text: string | null | undefined) => (text ?? "").replace(/\s+/g, " ").trim();

/** The table (grid) of the open tab. */
export const table = (name: string) => screen.findByRole("grid", { name });

/** The row of a table whose text contains `text`. */
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

/** Selects the row of a table (by a text in it). */
export async function pick(user: User, grid: HTMLElement, text: string | RegExp) {
  await user.click(rowOf(grid, text));
}

export const undoOnce = (workspace: { undo(): unknown }) => reactAct(() => void workspace.undo());

export const dialog = (name: string | RegExp) => screen.findByRole("dialog", { name });

/** Opens a select inside a dialog and chooses an option by its text. */
export async function choose(user: User, within_: HTMLElement, label: string | RegExp, option: string | RegExp) {
  await user.click(within(within_).getByRole("combobox", { name: label }));
  await user.click(await screen.findByRole("option", { name: option }));
}

/** A label as typed, with or without the "*" of a required field. */
const labelPattern = (label: string | RegExp) =>
  typeof label === "string" ? new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\*?$`) : label;

/** Replaces the text of a field. */
export async function fill(user: User, within_: HTMLElement, label: string | RegExp, text: string) {
  const field = within(within_).getByLabelText(labelPattern(label)) as HTMLInputElement;
  await user.clear(field);
  if (text) await user.type(field, text);
}

export const submit = (user: User, within_: HTMLElement, name: string | RegExp) =>
  user.click(within(within_).getByRole("button", { name }));

export const closed = (name: string | RegExp) =>
  waitFor(() => expect(screen.queryByRole("dialog", { name })).toBeNull());

/** What the project holds, to prove an undo brought everything back. */
export function snapshot(ledger: {
  accounts: Map<string, unknown>;
  cards: Map<string, unknown>;
  members: Map<string, unknown>;
  operations: Map<string, unknown>;
}) {
  return JSON.stringify([
    [...ledger.accounts.values()],
    [...ledger.cards.values()],
    [...ledger.members.values()],
    ledger.operations.size,
  ]);
}
