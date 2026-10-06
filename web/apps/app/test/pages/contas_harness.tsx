/** Mounting Contas e cartões on the demonstration project (or an empty or read-only one) for its tests. */
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { act as reactAct } from "@testing-library/react";
import { mountPage, type MountOptions } from "./overview_calendar_helpers.tsx";
import { setViewport } from "./livro_harness.tsx";

export type User = ReturnType<typeof userEvent.setup>;

export async function openContas(path = "/contas", options: MountOptions & { width?: number } = {}) {
  setViewport(options.width ?? 1600);
  const mounted = await mountPage(path, options);
  await screen.findByRole("heading", { level: 1, name: "Contas e cartões" });
  return { ...mounted, ledger: mounted.workspace.ledger, user: userEvent.setup() };
}

export async function goTab(user: User, name: string) {
  await user.click(screen.getByRole("tab", { name }));
  return screen.getByRole("tabpanel");
}

export const flat = (text: string | null | undefined) => (text ?? "").replace(/\s+/g, " ").trim();

/** The row of a table (grid) whose text contains `text`. */
export function rowOf(table: HTMLElement, text: string | RegExp): HTMLElement {
  const rows = within(table)
    .getAllByRole("row")
    .filter((row) => (typeof text === "string" ? flat(row.textContent).includes(text) : text.test(row.textContent ?? "")));
  if (rows.length === 0) throw new Error(`no row with ${String(text)} in ${table.getAttribute("aria-label")}`);
  return rows[0]!;
}

export const undoOnce = (workspace: { undo(): unknown }) => reactAct(() => void workspace.undo());

/** The dialog and its fields by label. */
export const dialog = (name: string | RegExp) => screen.findByRole("dialog", { name });
