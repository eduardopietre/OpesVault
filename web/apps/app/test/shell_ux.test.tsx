/**
 * The shell's helps: code that loads before the click, named undo steps, the demonstration's month and the
 * shortcuts sheet (`?`) with the shortcuts in the buttons' tooltips.
 */
import { dom, edits, makeDate, ym, ymAdd, ymOf, type Ledger } from "@opesvault/domain";
import { Sidebar, memoryPreferences } from "@opesvault/ui";
import { createMemoryHistory } from "@tanstack/react-router";
import { act as reactAct, fireEvent, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { App } from "../src/App.tsx";
import { actionName, nameAction } from "../src/data/action_names.ts";
import { lastCompleteMonth } from "../src/data/month.ts";
import { sharedMonth } from "../src/data/shared_month.ts";
import { preloadPage, screenLoader } from "../src/page_code.ts";
import { createAppRouter } from "../src/router.tsx";
import { DEMO, createFakeServices } from "../src/services/fake.ts";
import { SessionStore, sessionActions } from "../src/session.tsx";
import { SHORTCUTS, useShortcuts, type ShortcutHandlers } from "../src/shell/shortcuts.ts";

vi.mock("../../../packages/ui/src/chart/echarts.ts", () => import("./pages/fake_echarts.ts"));

const preloaded = vi.hoisted(() => [] as string[]);
vi.mock("../src/page_code.ts", async (original) => {
  const real = await original<typeof import("../src/page_code.ts")>();
  return {
    ...real,
    preloadPage: (id: string) => {
      preloaded.push(id);
      return real.preloadPage(id);
    },
  };
});

async function mountShell(path: string, options: { extras?: boolean } = {}) {
  const services = createFakeServices({ seed: true, extras: options.extras ?? false });
  const session = new SessionStore();
  const actions = sessionActions(services, session);
  await actions.signIn(DEMO.email, DEMO.password);
  await actions.openProject(services.demoProjectId!, DEMO.projectPassword);
  const router = createAppRouter({ session, history: createMemoryHistory({ initialEntries: [path] }) });
  render(<App router={router} services={services} session={session} preferences={memoryPreferences()} />);
  const workspace = session.get().open!.workspace;
  return { router, session, services, workspace, user: userEvent.setup() };
}

const category = (ledger: Ledger, name: string) =>
  [...ledger.accounts.values()].find((account) => account.name === name)!.id;
/** The demonstration's three rents (January to March). */
const rents = (ledger: Ledger) =>
  [...ledger.operations.values()].filter((op) => op.description === "Aluguel").map((op) => op.id);
const bank = (ledger: Ledger) => [...ledger.accounts.values()].find((account) => account.name === "Banco A")!.id;

describe("preloading a destination's code", () => {
  it("is idempotent: the same load for the same destination, nothing for an unknown one", async () => {
    const first = preloadPage("metas");
    expect(first).toBeDefined();
    expect(preloadPage("metas")).toBe(first);
    expect(preloadPage("nao-existe")).toBeUndefined();
    expect(screenLoader("nao-existe")).toBeUndefined();
    await first;
  });

  it("the sidebar asks for it when the pointer rests on a link or focus reaches it", () => {
    const onPreload = vi.fn();
    render(
      <Sidebar
        groups={[{ label: "Dia a dia", items: [{ id: "livro", label: "Livro", href: "/livro", icon: null }] }]}
        selectedId={null}
        onNavigate={() => undefined}
        onPreload={onPreload}
      />,
    );
    const link = screen.getByRole("link", { name: "Livro" });
    fireEvent.pointerEnter(link);
    expect(onPreload).toHaveBeenLastCalledWith("livro");
    reactAct(() => link.focus());
    expect(onPreload).toHaveBeenCalledTimes(2);
  });

  it("the shell preloads on hover and focus of a sidebar link, and on the palette's selection", async () => {
    const { user } = await mountShell("/visao-geral");
    await screen.findByRole("heading", { level: 1, name: /Visão geral|Casa/ });
    preloaded.length = 0;
    fireEvent.pointerEnter(screen.getByRole("link", { name: "Metas" }));
    expect(preloaded).toContain("metas");
    reactAct(() => screen.getByRole("link", { name: "Recorrências" }).focus());
    expect(preloaded).toContain("recorrencias");
    // the palette: the highlighted destination loads while the person still chooses
    await user.keyboard("{Control>}k{/Control}");
    const input = await screen.findByRole("combobox", { name: "Buscar comando ou seção" });
    await user.type(input, "reembolsos");
    await waitFor(() => expect(preloaded).toContain("reembolsos"));
  });
});

describe("named undo", () => {
  it("names an action by what it changed: created, removed or changed, and how many", () => {
    const services = createFakeServices({ seed: true });
    return services.signIn(DEMO.email, DEMO.password).then(async () => {
      const open = await services.openProject(services.demoProjectId!, DEMO.projectPassword);
      const workspace = open.workspace;
      const ledger = workspace.ledger;
      const on = workspace.today();
      workspace.act((l) => l.recordExpense(bank(l), category(l, "Lazer"), "10.00", on, "Cinema"));
      expect(workspace.undoStack.undoLabel()).toBe("novo lançamento");
      workspace.act((l) => {
        l.recordExpense(bank(l), category(l, "Lazer"), "10.00", on, "Pipoca");
        l.recordExpense(bank(l), category(l, "Lazer"), "12.00", on, "Refrigerante");
      });
      expect(workspace.undoStack.undoLabel()).toBe("2 novos lançamentos");
      const month = ymOf(on);
      workspace.act((l) => dom.budget.setBudget(l, category(l, "Lazer"), ymAdd(month, 5), "100.00"));
      expect(workspace.undoStack.undoLabel()).toBe("novo orçamento");
      workspace.act((l) => dom.budget.removeBudget(l, category(l, "Lazer"), ymAdd(month, 5)));
      expect(workspace.undoStack.undoLabel()).toBe("excluir orçamento");
      // a screen that knows what the person did names it
      const ids = rents(ledger);
      workspace.act(
        (l) =>
          edits.reclassify(l, ids, category(l, "Saúde"), "teste"),
        actionName("reclassificar", ids.length, "lançamento", "lançamentos"),
      );
      expect(workspace.undoStack.undoLabel()).toBe("reclassificar 3 lançamentos");
      expect(actionName("excluir", 1, "lançamento", "lançamentos")).toBe("excluir lançamento");
      expect(nameAction([])).toBe("alteração");
    });
  });

  it("shows the name in the top bar's button and in the notice after Ctrl+Z and Ctrl+Shift+Z", async () => {
    const { workspace, user } = await mountShell("/livro");
    await screen.findByRole("heading", { level: 1, name: "Livro financeiro" });
    const ids = rents(workspace.ledger);
    reactAct(() => {
      workspace.act(
        (l) => edits.reclassify(l, ids, category(l, "Saúde"), "teste"),
        "reclassificar 3 lançamentos",
      );
    });
    const undo = await screen.findByRole("button", { name: "Desfazer: reclassificar 3 lançamentos" });
    expect(undo.getAttribute("title")).toBe("Desfazer: reclassificar 3 lançamentos (Ctrl+Z)");
    expect(undo.getAttribute("aria-keyshortcuts")).toBe("Control+Z Meta+Z");
    reactAct(() => (document.getElementById("conteudo") as HTMLElement).focus());
    await user.keyboard("{Control>}z{/Control}");
    expect(await screen.findByText("Desfeito: reclassificar 3 lançamentos.")).toBeTruthy();
    const redo = await screen.findByRole("button", { name: "Refazer: reclassificar 3 lançamentos" });
    expect(redo.getAttribute("aria-keyshortcuts")).toContain("Control+Y");
    await user.keyboard("{Control>}{Shift>}z{/Shift}{/Control}");
    expect(await screen.findByText("Refeito: reclassificar 3 lançamentos.")).toBeTruthy();
  });
});

describe("the demonstration's month", () => {
  it("is the last complete month with entries: the previous one while this one is partial", () => {
    const services = createFakeServices({ seed: true });
    return services.signIn(DEMO.email, DEMO.password).then(async () => {
      const ledger = (await services.openProject(services.demoProjectId!, DEMO.projectPassword)).workspace.ledger;
      // the domain's demonstration has entries in January–March 2026 and in the current month
      expect(lastCompleteMonth(ledger, makeDate(2026, 3, 31))).toEqual(ym(2026, 3));
      expect(lastCompleteMonth(ledger, makeDate(2026, 4, 15))).toEqual(ym(2026, 3));
      expect(lastCompleteMonth(ledger, makeDate(2026, 2, 10))).toEqual(ym(2026, 1));
      // nothing before: the current month
      expect(lastCompleteMonth(ledger, makeDate(2025, 6, 10))).toEqual(ym(2025, 6));
    });
  });

  it("opens Visão geral, Orçamento, Livro and Relatórios on it (only the web demonstration)", async () => {
    const { workspace, router } = await mountShell("/visao-geral", { extras: true });
    const expected = lastCompleteMonth(workspace.ledger, workspace.today());
    expect(sharedMonth()).toEqual(expected);
    const today = ymOf(workspace.today());
    if (Number(workspace.today().slice(8)) < 28) expect(expected).toEqual(ymAdd(today, -1));
    const label = new RegExp(
      `${["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"][expected.month - 1]} de ${expected.year}`,
      "i",
    );
    for (const [path, title] of [
      ["/visao-geral", null],
      ["/orcamento", "Orçamento"],
      ["/livro", "Livro financeiro"],
      ["/relatorios", "Relatórios"],
    ] as const) {
      if (path !== "/visao-geral") await reactAct(() => router.navigate({ to: path }));
      if (title) await screen.findByRole("heading", { level: 1, name: title });
      const pickers = await screen.findAllByRole("group", { name: /mês|Mês|período/ });
      expect(pickers.some((group) => label.test(group.textContent ?? "")), path).toBe(true);
    }
    // a project of one's own opens on the current month
    const plain = await mountOther();
    expect(sharedMonth()).toEqual(ymOf(plain.today()));
  });
});

async function mountOther() {
  const services = createFakeServices({ seed: true });
  const session = new SessionStore();
  const actions = sessionActions(services, session);
  await actions.signIn(DEMO.email, DEMO.password);
  await actions.openProject(services.demoProjectId!, DEMO.projectPassword);
  return session.get().open!.workspace;
}

describe("keyboard shortcuts", () => {
  const handlers = (): ShortcutHandlers & Record<string, ReturnType<typeof vi.fn>> =>
    ({
      palette: vi.fn(),
      help: vi.fn(),
      shortcuts: vi.fn(),
      goIndex: vi.fn(),
      goLetter: vi.fn(() => true),
      undo: vi.fn(),
      redo: vi.fn(),
      toggleSidebar: vi.fn(),
      lock: vi.fn(),
    }) as never;

  it("each shell entry of the list is a key the handler answers", () => {
    const h = handlers();
    renderHook(() => useShortcuts(h));
    const press = (init: KeyboardEventInit) => fireEvent.keyDown(window, init);
    press({ key: "k", ctrlKey: true });
    press({ key: "F1" });
    press({ key: "?", shiftKey: true });
    press({ key: "1", code: "Digit1", altKey: true });
    press({ key: "g" });
    press({ key: "l" });
    press({ key: "z", ctrlKey: true });
    press({ key: "z", ctrlKey: true, shiftKey: true });
    press({ key: "y", ctrlKey: true });
    press({ key: "B", ctrlKey: true, shiftKey: true });
    press({ key: "L", ctrlKey: true, shiftKey: true });
    for (const id of ["palette", "help", "shortcuts", "goIndex", "goLetter", "undo", "toggleSidebar", "lock"]) {
      expect(h[id], id).toHaveBeenCalledTimes(1);
    }
    expect(h["redo"]).toHaveBeenCalledTimes(2);
    // every handler is in the list the sheet and the tooltips read
    for (const id of Object.keys(h)) expect(SHORTCUTS.some((item) => item.id === id), id).toBe(true);
  });

  it("`?` does not fire while typing or with a dialog open", () => {
    const h = handlers();
    renderHook(() => useShortcuts(h));
    const input = document.createElement("input");
    document.body.append(input);
    fireEvent.keyDown(input, { key: "?", shiftKey: true });
    expect(h["shortcuts"]).not.toHaveBeenCalled();
    input.remove();
    const dialog = document.createElement("dialog");
    dialog.setAttribute("open", "");
    document.body.append(dialog);
    fireEvent.keyDown(window, { key: "?", shiftKey: true });
    expect(h["shortcuts"]).not.toHaveBeenCalled();
    dialog.remove();
    fireEvent.keyDown(window, { key: "?", shiftKey: true });
    expect(h["shortcuts"]).toHaveBeenCalledTimes(1);
  });

  it("`?` opens Atalhos de teclado with every shortcut; buttons show theirs in the tooltip", async () => {
    const { user } = await mountShell("/livro");
    await screen.findByRole("heading", { level: 1, name: "Livro financeiro" });
    const lock = screen.getByRole("button", { name: "Bloquear o projeto" });
    expect(lock.getAttribute("title")).toBe("Bloquear o projeto (Ctrl+Shift+L)");
    expect(lock.getAttribute("aria-keyshortcuts")).toBe("Control+Shift+L Meta+Shift+L");
    const search = screen.getByRole("button", { name: /Buscar seção ou comando/ });
    expect(search.getAttribute("title")).toBe("Buscar seção ou comando (Ctrl+K)");
    expect(search.getAttribute("aria-keyshortcuts")).toBe("Control+K Meta+K");
    expect(screen.getByRole("link", { name: "Orçamento" }).getAttribute("aria-keyshortcuts")).toBe("Alt+2");
    reactAct(() => (document.getElementById("conteudo") as HTMLElement).focus());
    await user.keyboard("?");
    const sheet = await screen.findByRole("dialog", { name: "Atalhos de teclado" });
    for (const item of SHORTCUTS) {
      expect(within(sheet).getAllByText(item.what).length, item.id).toBeGreaterThan(0);
      for (const keys of item.keys) expect(within(sheet).getAllByText(keys).length, keys).toBeGreaterThan(0);
    }
    expect(within(sheet).getByText("Livro financeiro")).toBeTruthy();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Atalhos de teclado" })).toBeNull());
  });
});
