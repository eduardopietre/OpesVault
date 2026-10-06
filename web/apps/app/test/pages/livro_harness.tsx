/** Mounts the Livro with the demonstration project, the way `screens.test.tsx` mounts the shell. */
import { memoryPreferences } from "@opesvault/ui";
import { createMemoryHistory } from "@tanstack/react-router";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "../../src/App.tsx";
import { createAppRouter } from "../../src/router.tsx";
import { DEMO, createFakeServices } from "../../src/services/fake.ts";
import { SessionStore } from "../../src/session.tsx";

export type User = ReturnType<typeof userEvent.setup>;

/** happy-dom evaluates media queries against the viewport: the wide band shows the inspector beside the table. */
export function setViewport(width: number, height = 900): void {
  (window as unknown as { happyDOM: { setViewport(v: { width: number; height: number }): void } }).happyDOM.setViewport(
    {
      width,
      height,
    },
  );
}

export async function openLivro(path = "/livro", options: { width?: number } = {}) {
  setViewport(options.width ?? 1600);
  const services = createFakeServices({ seed: true });
  const session = new SessionStore();
  const account = await services.signIn(DEMO.email, DEMO.password);
  const open = await services.openProject(services.demoProjectId!, DEMO.projectPassword);
  session.update({ account, open, operatorId: open.members[0]?.id ?? null });
  const history = createMemoryHistory({ initialEntries: [path] });
  const router = createAppRouter({ session, history });
  const preferences = memoryPreferences();
  render(<App router={router} services={services} session={session} preferences={preferences} />);
  await screen.findByRole("heading", { level: 1, name: "Livro financeiro" });
  await screen.findByRole("grid", { name: "Lançamentos" });
  return { workspace: open.workspace, router, session, preferences, user: userEvent.setup() };
}

/** Picks an option of a Select by its accessible name. */
export async function choose(user: User, name: string | RegExp, option: string | RegExp, scope?: HTMLElement) {
  const root = scope ? within(scope) : screen;
  await user.click(root.getByRole("combobox", { name }));
  await user.click(await screen.findByRole("option", { name: option }));
}

/** Opens a MenuButton and clicks one of its items. */
export async function menu(user: User, button: string | RegExp, item: string | RegExp, scope?: HTMLElement) {
  const root = scope ? within(scope) : screen;
  await user.click(root.getByRole("button", { name: button }));
  await user.click(await screen.findByRole("menuitem", { name: item }));
}

export function dialog(): HTMLElement {
  return screen.getByRole("dialog");
}
