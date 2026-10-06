/** Mounts the Livro with the demonstration project, the way `screens.test.tsx` mounts the shell. */
import { AccountType, type Operation } from "@opesvault/domain";
import { expect } from "vitest";
import { memoryPreferences } from "@opesvault/ui";
import { createMemoryHistory } from "@tanstack/react-router";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "../../src/App.tsx";
import { createAppRouter } from "../../src/router.tsx";
import { DEMO, createFakeServices } from "../../src/services/fake.ts";
import { SessionStore } from "../../src/session.tsx";

export type User = ReturnType<typeof userEvent.setup>;

/** happy-dom evaluates media queries against the viewport: the wide band shows the inspector beside the table. */
export function setViewport(width: number, height = 900): void {
  (window as unknown as { happyDOM: { setViewport(v: { width: number; height: number }): void } }).happyDOM.setViewport(
    { width, height },
  );
}

export async function openLivro(path = "/livro", options: { width?: number; empty?: boolean } = {}) {
  setViewport(options.width ?? 1600);
  const services = createFakeServices({ seed: true });
  const session = new SessionStore();
  let account = await services.signIn(DEMO.email, DEMO.password);
  let projectId = services.demoProjectId!;
  let password: string = DEMO.projectPassword;
  if (options.empty) {
    // a project of its own, with no operations at all
    account = await services.signUp({ name: "Carla", email: "carla@example.com", password: "uma frase longa" });
    const created = await services.createProject({ name: "Vazio", password: "senha do projeto" });
    projectId = created.project.id;
    password = "senha do projeto";
  }
  const open = await services.openProject(projectId, password);
  session.update({ account, open, operatorId: open.members[0]?.id ?? null });
  const history = createMemoryHistory({ initialEntries: [path] });
  const router = createAppRouter({ session, history });
  const preferences = memoryPreferences();
  render(<App router={router} services={services} session={session} preferences={preferences} />);
  await screen.findByRole("heading", { level: 1, name: "Livro financeiro" });
  if (!options.empty) {
    await waitFor(() =>
      expect(
        screen.queryByRole("grid", { name: "Lançamentos" }) ?? screen.queryByRole("listbox", { name: "Lançamentos" }),
      ).toBeTruthy(),
    );
  }
  return { workspace: open.workspace, router, session, preferences, user: userEvent.setup() };
}

export const grid = () => screen.getByRole("grid", { name: "Lançamentos" });

/** The visible rows whose text contains `text`. */
export const rowsWith = (text: string | RegExp) =>
  within(screen.queryByRole("grid", { name: "Lançamentos" }) ?? document.body)
    .queryAllByRole("row")
    .filter((row) => (typeof text === "string" ? row.textContent?.includes(text) : text.test(row.textContent ?? "")));

/** Selects the first visible row with this description (a click on its description cell). */
export async function pickRow(user: User, description: string): Promise<string> {
  const cell = within(grid())
    .getAllByRole("gridcell")
    .find((c) => c.textContent === description);
  if (!cell) throw new Error(`no row "${description}"`);
  await user.click(cell);
  const row = cell.closest("[role=row]") as HTMLElement;
  await waitFor(() => expect(row.getAttribute("aria-selected")).toBe("true"));
  return row.getAttribute("data-row-id") as string;
}

/** A label or name given as text matches from its start: required fields add "*", menu items a shortcut. */
export function starts(text: string | RegExp): string | RegExp {
  if (typeof text !== "string") return text;
  return new RegExp("^" + text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
}

/** Picks an option of a Select by its accessible name. */
export async function choose(user: User, name: string | RegExp, option: string | RegExp, scope?: HTMLElement) {
  const root = scope ? within(scope) : screen;
  await user.click(root.getByRole("combobox", { name }));
  await user.click(await screen.findByRole("option", { name: option }));
}

/** Opens a MenuButton and clicks one of its items. */
export async function menu(user: User, button: string | RegExp, item: string | RegExp) {
  await user.click(screen.getByRole("button", { name: button }));
  await user.click(await screen.findByRole("menuitem", { name: starts(item) }));
}

export const dialog = (name?: string | RegExp) => screen.findByRole("dialog", name ? { name } : {});

/** The operations of the project, newest created last is not guaranteed: look one up by description. */
export function opByDescription(workspace: { ledger: { operations: Map<string, Operation> } }, description: string) {
  return [...workspace.ledger.operations.values()].filter((o) => o.description === description);
}

export async function typeInto(user: User, scope: HTMLElement, label: string | RegExp, text: string) {
  const field = within(scope).getByLabelText(starts(label));
  await user.clear(field);
  await user.type(field, text);
}

export async function submit(user: User, scope: HTMLElement, name: string | RegExp) {
  await user.click(within(scope).getByRole("button", { name }));
}

/** The close button at the foot of a dialog (the corner "×" has the same name). */
export async function closeDialog(user: User, scope: HTMLElement) {
  const buttons = within(scope).getAllByRole("button", { name: "Fechar" });
  await user.click(buttons[buttons.length - 1] as HTMLElement);
}

export type Opened = Awaited<ReturnType<typeof openLivro>>;

export const byId = (o: Opened, id: string) => o.workspace.ledger.operations.get(id) as Operation;
export const count = (o: Opened) => o.workspace.ledger.operations.size;
export const category = (o: Opened, name: string, type: AccountType = AccountType.EXPENSE) =>
  o.workspace.ledger.categories(type).find((a) => a.name === name)!;
export const account = (o: Opened, name: string) =>
  [...o.workspace.ledger.accounts.values()].find((a) => a.name === name)!;
