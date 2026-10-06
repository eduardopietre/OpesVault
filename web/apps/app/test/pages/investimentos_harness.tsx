/** Mounting Investimentos on the demonstration project (or an empty or read-only one) for its tests. */
import { dom, investments, makeDate, type Id, type Ledger } from "@opesvault/domain";
import { act as reactAct, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect } from "vitest";
import { setViewport } from "./livro_harness.tsx";
import { mountPage, type MountOptions } from "./overview_calendar_helpers.tsx";

export type User = ReturnType<typeof userEvent.setup>;

export async function openInvestimentos(path = "/investimentos", options: MountOptions & { width?: number } = {}) {
  setViewport(options.width ?? 1600);
  const mounted = await mountPage(path, options);
  await screen.findByRole("heading", { level: 1, name: "Investimentos" }, { timeout: 15_000 });
  return { ...mounted, ledger: mounted.workspace.ledger, user: userEvent.setup() };
}

export const flat = (text: string | null | undefined) => (text ?? "").replace(/\s+/g, " ").trim();

/** The table (grid) of a section; waits for it. */
export const table = (name: string) => screen.findByRole("grid", { name });

export function rowOf(grid: HTMLElement, text: string | RegExp): HTMLElement {
  const rows = within(grid)
    .getAllByRole("row")
    .filter((row) =>
      typeof text === "string" ? flat(row.textContent).includes(text) : text.test(flat(row.textContent)),
    );
  if (rows.length === 0) throw new Error(`no row with ${String(text)} in ${grid.getAttribute("aria-label")}`);
  return rows[0]!;
}

export const selectedRow = (grid: HTMLElement) =>
  within(grid)
    .getAllByRole("row")
    .find((row) => row.getAttribute("aria-selected") === "true");

export const undoOnce = (workspace: { undo(): unknown }) => reactAct(() => void workspace.undo());

export const dialog = (name: string | RegExp) => screen.findByRole("dialog", { name });

export const closed = (name: string | RegExp) =>
  waitFor(() => expect(screen.queryByRole("dialog", { name })).toBeNull());

/** Opens a menu of the header and chooses an item. */
export async function menu(user: User, button: string, item: string | RegExp) {
  await user.click(screen.getByRole("button", { name: button }));
  await user.click(await screen.findByRole("menuitem", { name: item }));
}

export async function choose(user: User, within_: HTMLElement, label: string | RegExp, option: string | RegExp) {
  await user.click(within(within_).getByRole("combobox", { name: label }));
  await user.click(await screen.findByRole("option", { name: option }));
}

const labelPattern = (label: string | RegExp) =>
  typeof label === "string" ? new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\*?$`) : label;

export async function fill(user: User, within_: HTMLElement, label: string | RegExp, text: string) {
  const field = within(within_).getByLabelText(labelPattern(label)) as HTMLInputElement;
  await user.clear(field);
  if (text) await user.type(field, text);
}

export const submit = (user: User, within_: HTMLElement, name: string | RegExp) =>
  user.click(within(within_).getByRole("button", { name }));

/** What the investments of the project hold, to prove an undo brought everything back. */
export function snapshot(ledger: Ledger): string {
  const { service, trades, profile, benchmarks } = investments;
  return JSON.stringify([
    [...service.assets(ledger).values()],
    [...service.positions(ledger).values()],
    [...service.valuations(ledger).values()],
    [...service.events(ledger).values()],
    [...trades.lots(ledger).values()],
    [...profile.profiles(ledger).values()],
    [...benchmarks.benchmarks(ledger).values()],
    [...ledger.entities("tax_rule").values()],
    ledger.operations.size,
    ledger.accounts.size,
  ]);
}

export const MARCH_28 = makeDate(2026, 3, 28);

/** The demonstration project's CDB (tracked by value, three gross valuations). */
export const cdbOf = (ledger: Ledger): Id => investments.service.positions(ledger).values().next().value!.id;

/** A bank account of the demo to move money from or to. */
export const cashOf = (ledger: Ledger): Id => [...dom.banking.bankAccounts(ledger).values()][0]!.checking_id!;
