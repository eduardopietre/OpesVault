/** Mounts the Livro with the demonstration project (or a new, empty one). */
import { type Operation } from "@opesvault/domain";
import { screen, waitFor, within } from "@testing-library/react";
import { expect } from "vitest";
import { starts, type User } from "../dom.ts";
import { mountApp, type MountOptions } from "../mount.tsx";

export async function openLivro(path = "/livro", options: MountOptions = {}) {
  const mounted = await mountApp(path, { width: 1600, heading: "Livro financeiro", ...options });
  if (options.project !== "new") {
    await waitFor(() =>
      expect(
        screen.queryByRole("grid", { name: "Lançamentos" }) ?? screen.queryByRole("listbox", { name: "Lançamentos" }),
      ).toBeTruthy(),
    );
  }
  return mounted;
}

export const grid = () => screen.getByRole("grid", { name: "Lançamentos" });

/** The visible rows whose text contains `text`. */
export const rowsWith = (text: string | RegExp) =>
  within(screen.queryByRole("grid", { name: "Lançamentos" }) ?? document.body)
    .queryAllByRole("row")
    .filter((row) => (typeof text === "string" ? row.textContent?.includes(text) : text.test(row.textContent ?? "")));

/** Selects the first visible operation with this description (a click on its description cell); returns its id. */
export async function selectOperation(user: User, description: string): Promise<string> {
  const cell = within(grid())
    .getAllByRole("gridcell")
    .find((c) => c.textContent === description);
  if (!cell) throw new Error(`no row "${description}"`);
  await user.click(cell);
  const row = cell.closest("[role=row]") as HTMLElement;
  await waitFor(() => expect(row.getAttribute("aria-selected")).toBe("true"));
  return row.getAttribute("data-row-id") as string;
}

/** The operations of the project, newest created last is not guaranteed: look one up by description. */
export function opByDescription(workspace: { ledger: { operations: Map<string, Operation> } }, description: string) {
  return [...workspace.ledger.operations.values()].filter((o) => o.description === description);
}

export async function typeInto(user: User, scope: HTMLElement, label: string | RegExp, text: string) {
  const field = within(scope).getByLabelText(starts(label));
  await user.clear(field);
  await user.type(field, text);
}

/** The close button at the foot of a dialog (the corner "×" has the same name). */
export async function closeDialog(user: User, scope: HTMLElement) {
  const buttons = within(scope).getAllByRole("button", { name: "Fechar" });
  await user.click(buttons[buttons.length - 1] as HTMLElement);
}

export type Opened = Awaited<ReturnType<typeof openLivro>>;

export const byId = (o: Opened, id: string) => o.workspace.ledger.operations.get(id) as Operation;
export const count = (o: Opened) => o.workspace.ledger.operations.size;
