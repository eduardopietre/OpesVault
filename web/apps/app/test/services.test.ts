import { describe, expect, it } from "vitest";
import { cspHeader, cspMeta } from "../src/security.ts";
import { DEMO, createFakeServices } from "../src/services/fake.ts";
import { ServiceError } from "../src/services/types.ts";
import { SessionStore, sessionActions, syncStateOf } from "../src/session.tsx";
import { isTyping } from "../src/shell/shortcuts.ts";
import { PAGES, SECTIONS, shortcutOf } from "../src/pages.tsx";

describe("fake services", () => {
  it("signs up, creates a project with a recovery key and opens it only with its password", async () => {
    const services = createFakeServices({ random: () => 0.5 });
    const account = await services.signUp({ name: "Carla", email: "Carla@Example.com", password: "uma frase longa" });
    expect(account.email).toBe("carla@example.com");
    await expect(services.signUp({ name: "x", email: "carla@example.com", password: "y" })).rejects.toBeInstanceOf(
      ServiceError,
    );
    const created = await services.createProject({ name: "Casa", password: "senha do projeto" });
    expect(created.recoveryKey).toMatch(/^([0-9A-Z]{4}-){8}[0-9A-Z]{4}$/);
    // A wrong password never opens an empty project.
    await expect(services.openProject(created.project.id, "errada")).rejects.toMatchObject({ code: "bad-password" });
    const open = await services.openProject(created.project.id, "senha do projeto");
    expect(open.project.name).toBe("Casa");
    expect(await services.listProjects()).toHaveLength(1);
  });

  it("locks and unlocks with the project password", async () => {
    const services = createFakeServices({ seed: true });
    await services.signIn(DEMO.email, DEMO.password);
    await services.openProject(services.demoProjectId!, DEMO.projectPassword);
    await services.lock();
    await expect(services.unlock("errada")).rejects.toMatchObject({ code: "bad-password" });
    const open = await services.unlock(DEMO.projectPassword);
    expect(open.members.length).toBe(2);
  });

  it("refuses wrong credentials with a message for the user", async () => {
    const services = createFakeServices({ seed: true });
    await expect(services.signIn(DEMO.email, "x")).rejects.toThrow("E-mail ou senha não conferem.");
    await expect(services.listProjects()).rejects.toMatchObject({ code: "signed-out" });
  });
});

describe("session", () => {
  it("follows sign in, open, lock and sign out, and never keeps a password", async () => {
    const services = createFakeServices({ seed: true });
    const store = new SessionStore();
    const actions = sessionActions(services, store);
    await actions.signIn(DEMO.email, DEMO.password);
    await actions.openProject(services.demoProjectId!, DEMO.projectPassword);
    expect(store.get().open?.project.name).toBe("Casa");
    expect(store.get().operatorId).toBe(store.get().open?.members[0]?.id);
    expect(store.get().open?.members.map((m) => m.name)).toEqual(["Ana", "Bruno"]);
    expect(syncStateOf(store.get())).toBe("synced");
    await actions.lock();
    expect(store.get()).toMatchObject({ open: null, locked: true, lockedName: "Casa" });
    expect(syncStateOf(store.get())).toBe("locked");
    expect(JSON.stringify(store.get())).not.toContain(DEMO.projectPassword);
    await actions.unlock(DEMO.projectPassword);
    store.update({ online: false });
    expect(syncStateOf(store.get())).toBe("offline");
    await actions.signOut();
    expect(store.get().account).toBeNull();
  });
});

describe("pages", () => {
  it("keep the desktop's order, titles and groups, with Configurações pinned", () => {
    expect(PAGES.map((page) => page.title)).toEqual([
      "Visão geral",
      "Orçamento",
      "Calendário",
      "Livro financeiro",
      "Importar e revisar",
      "Contas e cartões",
      "Recorrências",
      "Investimentos",
      "Relatórios",
      "Assistente",
      "Metas",
      "Reembolsos e acertos",
      "Imposto de renda",
      "Documentos",
      "Configurações",
    ]);
    expect(SECTIONS).toEqual(["Dia a dia", "Cadastros", "Acompanhamento", "Arquivo"]);
    expect(PAGES.at(-1)?.section).toBeNull();
    expect(new Set(PAGES.map((page) => page.letter)).size).toBe(PAGES.length);
    expect(shortcutOf(PAGES[0]!)).toBe("Alt+1");
    expect(shortcutOf(PAGES[9]!)).toBeUndefined();
  });
});

describe("shortcuts", () => {
  it("know when the user is typing", () => {
    const input = document.createElement("input");
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    expect(isTyping(input)).toBe(true);
    expect(isTyping(checkbox)).toBe(false);
    expect(isTyping(document.createElement("textarea"))).toBe(true);
    expect(isTyping(document.body)).toBe(false);
  });
});

describe("content security policy", () => {
  it("is strict and carries frame-ancestors only in the header", () => {
    expect(cspMeta()).not.toMatch(/'unsafe-(inline|eval)'/);
    expect(cspMeta()).toContain("require-trusted-types-for 'script'");
    expect(cspMeta()).not.toContain("frame-ancestors");
    expect(cspHeader()).toContain("frame-ancestors 'none'");
  });
});
