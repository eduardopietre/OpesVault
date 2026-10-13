/**
 * The shell beyond navigation: the palette finds records (lançamentos, contas, documentos) and creates
 * (lançamento, importação, meta), `n` starts a new lançamento, recent notices stay reachable after their toast
 * goes, and on a phone undo, redo, help and the notices live in the top bar's "Mais ações".
 */
import { notify } from "@opesvault/ui";
import { act as reactAct, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { READ_ONLY_TIP } from "../src/data/read_only.ts";
import { DEMO, createFakeServices } from "../src/services/fake.ts";
import { MIN_QUERY, findRecords } from "../src/shell/record_search.ts";
import { noticeTime } from "../src/shell/RecentNotices.tsx";
import { dialog } from "./dom.ts";
import { mountApp } from "./mount.tsx";
import { navigations, wentTo } from "./navigations.ts";

async function demoProject() {
  const services = createFakeServices({ seed: true });
  await services.signIn(DEMO.email, DEMO.password);
  const open = await services.openProject(services.demoProjectId!, DEMO.projectPassword);
  return open.workspace;
}

const mountShell = (path: string, width = 1280) =>
  mountApp(path, { viaActions: true, width, services: { extras: false } });

async function openPalette(user: Awaited<ReturnType<typeof mountShell>>["user"]) {
  reactAct(() => (document.getElementById("conteudo") as HTMLElement).focus());
  await user.keyboard("{Control>}k{/Control}");
  return (await screen.findByRole("combobox", { name: "Buscar comando ou seção" })) as HTMLInputElement;
}

describe("finding records", () => {
  it("finds operations by words of the description, the amount or the date, newest first and a few", async () => {
    const workspace = await demoProject();
    const ledger = workspace.ledger;
    const docs = workspace.session.documents;
    const rents = findRecords(ledger, docs, "aluguel");
    expect(rents.filter((hit) => hit.kind === "operation").map((hit) => hit.detail)).toEqual([
      "R$ 2.350,00 · 10/03/2026",
      "R$ 2.350,00 · 10/02/2026",
      "R$ 2.350,00 · 10/01/2026",
    ]);
    expect(rents[0]).toMatchObject({ page: "livro", label: "Aluguel" });
    expect(rents[0]!.ref).toBe(rents[0]!.id);
    // the amount, as shown or plain, and the date narrow it
    expect(findRecords(ledger, docs, "2.350,00 10/02").map((hit) => hit.detail)).toEqual(["R$ 2.350,00 · 10/02/2026"]);
    expect(findRecords(ledger, docs, "2350 alug").length).toBe(3);
    // accents and case do not matter; every word must be there
    expect(findRecords(ledger, docs, "SALARIO").some((hit) => hit.label === "Salário")).toBe(true);
    expect(findRecords(ledger, docs, "aluguel salario")).toEqual([]);
    // a few of each kind, and nothing for a query too short
    expect(findRecords(ledger, docs, "2026", 4).filter((hit) => hit.kind === "operation")).toHaveLength(4);
    expect(findRecords(ledger, docs, "a".repeat(MIN_QUERY - 1))).toEqual([]);
  });

  it("finds accounts (not categories) and documents, each where it lives", async () => {
    const workspace = await demoProject();
    const hits = findRecords(workspace.ledger, workspace.session.documents, "banco a");
    const account = hits.find((hit) => hit.kind === "account");
    expect(account).toMatchObject({ page: "contas", label: "Banco A" });
    expect(account!.ref).toBe(`conta:${account!.id}`);
    expect(findRecords(workspace.ledger, [], "moradia").some((hit) => hit.kind === "account")).toBe(false);
    const document = workspace.session.documents[0];
    if (document) {
      const found = findRecords(workspace.ledger, workspace.session.documents, document.meta.original_name);
      expect(found.find((hit) => hit.kind === "document")).toMatchObject({
        page: "documentos",
        ref: document.meta.id,
      });
    }
  });
});

describe("the palette", () => {
  it("opens a lançamento found by its description in the Livro", async () => {
    const { user, router } = await mountShell("/visao-geral");
    await screen.findByRole("heading", { level: 1, name: /Visão geral|Casa/ });
    const seen = navigations(router);
    const input = await openPalette(user);
    await user.type(input, "aluguel 10/02");
    const option = await screen.findByRole("option", { name: /Aluguel.*10\/02\/2026/ });
    expect(within(screen.getByRole("listbox")).getByRole("group", { name: "Lançamentos" })).toBeTruthy();
    await user.click(option);
    await wentTo(seen, "/livro", { ref: expect.any(String) });
    await screen.findByRole("heading", { level: 1, name: "Livro financeiro" });
  });

  it("creates: a new lançamento, an import and a goal, each on its screen", async () => {
    const { user, router } = await mountShell("/visao-geral");
    await screen.findByRole("heading", { level: 1, name: /Visão geral|Casa/ });
    const seen = navigations(router);
    let input = await openPalette(user);
    await user.type(input, "nova meta");
    await user.keyboard("{Enter}");
    await wentTo(seen, "/metas", { act: "nova" });
    const goal = await dialog("Nova meta");
    await user.click(within(goal).getByRole("button", { name: "Cancelar" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Nova meta" })).toBeNull());

    input = await openPalette(user);
    await user.type(input, "novo lancamento");
    await user.keyboard("{Enter}");
    await wentTo(seen, "/livro", { act: "novo" });
    expect(await dialog("Despesa")).toBeTruthy();
  });

  it("offers Importar arquivo, which goes to Importar e revisar to pick the file", async () => {
    const { user, router } = await mountShell("/visao-geral");
    await screen.findByRole("heading", { level: 1, name: /Visão geral|Casa/ });
    const seen = navigations(router);
    const input = await openPalette(user);
    await user.type(input, "importar arquivo");
    expect(screen.getAllByRole("option")[0]?.textContent).toContain("Importar arquivo");
    await user.keyboard("{Enter}");
    await wentTo(seen, "/importar", { act: "arquivo" });
    await screen.findByRole("heading", { level: 1, name: "Importar e revisar" });
  });
});

describe("the n key", () => {
  it("starts a new lançamento from any screen, but not while typing or with a dialog open", async () => {
    const { user, router } = await mountShell("/metas");
    await screen.findByRole("heading", { level: 1, name: "Metas" });
    const seen = navigations(router);
    // typing in a field: an n is a letter
    const input = document.createElement("input");
    document.body.append(input);
    fireEvent.keyDown(input, { key: "n" });
    input.remove();
    expect(seen).toEqual([]);
    reactAct(() => (document.getElementById("conteudo") as HTMLElement).focus());
    await user.keyboard("n");
    await wentTo(seen, "/livro", { act: "novo" });
    const form = await dialog("Despesa");
    // with the form open, another n is just a letter
    const before = seen.length;
    fireEvent.keyDown(form, { key: "n" });
    expect(seen.length).toBe(before);
  });

  it("explains why when the project is read-only", async () => {
    const { user, router } = await mountApp("/metas", { readOnly: true, width: 1280 });
    await screen.findByRole("heading", { level: 1, name: "Metas" });
    const seen = navigations(router);
    reactAct(() => (document.getElementById("conteudo") as HTMLElement).focus());
    await user.keyboard("n");
    expect(await screen.findByText(READ_ONLY_TIP)).toBeTruthy();
    expect(seen).toEqual([]);
  });
});

describe("recent notices", () => {
  it("keeps the toasts of the tab, newest first, with the time and without their action", async () => {
    const { user } = await mountShell("/metas");
    await screen.findByRole("heading", { level: 1, name: "Metas" });
    reactAct(() => {
      notify("Primeiro aviso.");
      notify("Item corrigido.", { action: { label: "Desfazer", run: () => undefined } });
    });
    await user.click(screen.getByRole("button", { name: "Avisos recentes" }));
    const sheet = await dialog("Avisos recentes");
    const items = within(within(sheet).getByRole("list", { name: "Avisos recentes" })).getAllByRole("listitem");
    expect(items.map((item) => item.textContent)).toEqual([
      expect.stringContaining("Item corrigido."),
      expect.stringContaining("Primeiro aviso."),
    ]);
    expect(within(sheet).queryByRole("button", { name: "Desfazer" })).toBeNull();
    expect(items[0]!.querySelector("time")?.textContent).toMatch(/^\d{2}:\d{2}$/);
  });

  it("is also a command of the palette, and says so when there is nothing yet", async () => {
    const { user } = await mountShell("/metas");
    await screen.findByRole("heading", { level: 1, name: "Metas" });
    const input = await openPalette(user);
    await user.type(input, "avisos recentes");
    await user.keyboard("{Enter}");
    const sheet = await dialog("Avisos recentes");
    expect(within(sheet).getByText("Nenhum aviso ainda")).toBeTruthy();
  });

  it("shows the day too for a notice of another day", () => {
    const now = new Date(2026, 9, 13, 15, 0).getTime();
    expect(noticeTime(new Date(2026, 9, 13, 9, 5).getTime(), now)).toBe("09:05");
    expect(noticeTime(new Date(2026, 9, 12, 9, 5).getTime(), now)).toBe("12/10 09:05");
  });
});

describe("the top bar on a phone", () => {
  it("puts undo, redo, help and the notices in Mais ações", async () => {
    const { user } = await mountShell("/metas", 390);
    await screen.findByRole("heading", { level: 1, name: "Metas" });
    expect(screen.queryByRole("button", { name: /^Desfazer/ })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Mais ações" }));
    const names = (await screen.findAllByRole("menuitem")).map((item) => item.textContent);
    for (const name of ["Desfazer", "Refazer", "Avisos recentes", "Ajuda desta tela"]) {
      expect(
        names.some((text) => text?.startsWith(name)),
        name,
      ).toBe(true);
    }
    await user.click(screen.getByRole("menuitem", { name: /^Ajuda desta tela/ }));
    expect(await dialog("Ajuda: Metas")).toBeTruthy();
  });
});
