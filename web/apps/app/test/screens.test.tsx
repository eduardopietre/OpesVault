import { memoryPreferences } from "@opesvault/ui";
import { createMemoryHistory } from "@tanstack/react-router";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { attentionCounts } from "../src/data/attention.ts";
import { App } from "../src/App.tsx";
import { createAppRouter } from "../src/router.tsx";
import { DEMO, createFakeServices } from "../src/services/fake.ts";
import { SessionStore } from "../src/session.tsx";
import { mountApp } from "./mount.tsx";
import { navigations, wentTo } from "./navigations.ts";

describe("screens before a project", () => {
  it("send a signed-out visitor to sign in, validate the form and open the projects", async () => {
    const user = userEvent.setup();
    const { router } = await mountApp("/livro", { project: "signed-out" });
    await screen.findByRole("heading", { name: "Entrar" });
    expect(router.state.location.pathname).toBe("/entrar");
    await user.click(screen.getByRole("button", { name: "Entrar" }));
    expect(screen.getByText("Digite um e-mail válido.")).toBeTruthy();
    await user.type(screen.getByLabelText("E-mail"), DEMO.email);
    await user.type(screen.getByLabelText("Senha da conta"), DEMO.password);
    await user.click(screen.getByRole("button", { name: "Entrar" }));
    await screen.findByRole("heading", { name: "Projetos" });
    expect(await screen.findByText("Casa")).toBeTruthy();
  });

  it("shows and hides each password, and explains what to do when the account password is forgotten", async () => {
    const user = userEvent.setup();
    await mountApp("/entrar", { project: "signed-out" });
    await screen.findByRole("heading", { name: "Entrar" });
    const password = screen.getByLabelText("Senha da conta") as HTMLInputElement;
    expect(password.type).toBe("password");
    const reveal = screen.getByRole("button", { name: "Mostrar a senha" });
    expect(reveal.getAttribute("aria-pressed")).toBe("false");
    await user.click(reveal);
    expect(password.type).toBe("text");
    expect(reveal.getAttribute("aria-pressed")).toBe("true");
    await user.click(reveal);
    expect(password.type).toBe("password");

    await user.click(screen.getByRole("button", { name: "Esqueci a senha da conta" }));
    const box = await screen.findByRole("dialog", { name: "Esqueci a senha da conta" });
    const text = box.textContent ?? "";
    expect(text).toContain("não pode ser redefinida");
    expect(text).toContain("não é a senha do projeto");
    expect(text).toContain("Crie uma conta nova");
    expect(text).toContain("adicione esse e-mail como integrante");
    expect(text).toContain("backup");
    await user.click(screen.getByRole("button", { name: "Entendi" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("on sign up, the password and its confirmation each have their own show button", async () => {
    const user = userEvent.setup();
    await mountApp("/criar-conta", { project: "signed-out" });
    await screen.findByRole("heading", { name: "Criar conta" });
    const first = screen.getByLabelText("Senha da conta") as HTMLInputElement;
    const second = screen.getByLabelText("Confirme a senha") as HTMLInputElement;
    await user.click(screen.getByRole("button", { name: "Mostrar a confirmação" }));
    expect(second.type).toBe("text");
    expect(first.type).toBe("password");
    await user.click(screen.getByRole("button", { name: "Mostrar a senha" }));
    expect(first.type).toBe("text");
  });

  it("enables Criar conta only when the passwords match", async () => {
    const user = userEvent.setup();
    await mountApp("/criar-conta", { project: "signed-out" });
    await screen.findByRole("heading", { name: "Criar conta" });
    const submit = screen.getByRole("button", { name: "Criar conta" }) as HTMLButtonElement;
    await user.type(screen.getByLabelText("Seu nome"), "Carla");
    await user.type(screen.getByLabelText("E-mail"), "carla@example.com");
    await user.type(screen.getByLabelText("Senha da conta"), "uma frase longa");
    await user.type(screen.getByLabelText("Confirme a senha"), "uma frase");
    expect(submit.disabled).toBe(true);
    expect(screen.getByText("As senhas não coincidem.")).toBeTruthy();
    await user.type(screen.getByLabelText("Confirme a senha"), " longa");
    expect(submit.disabled).toBe(false);
  });
});

describe("the first-run assistant", () => {
  it("ends where its last step points: Importar, or Visão geral with Abrir o projeto", async () => {
    const user = userEvent.setup();
    const { router } = await mountApp("/comecar", { project: "new" });
    await screen.findByRole("heading", { name: "Primeiros passos" });
    for (const next of ["Próximo: Contas", "Próximo: Cartões", "Próximo: Conclusão"]) {
      await user.click(screen.getByRole("button", { name: next }));
    }
    expect(screen.getByText(/O próximo passo costuma ser importar um extrato/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Abrir o projeto" })).toBeTruthy();
    const seen = navigations(router);
    await user.click(screen.getByRole("button", { name: "Importar um extrato" }));
    await wentTo(seen, "/importar", {});
    await screen.findByRole("heading", { level: 1, name: "Importar e revisar" });
  });
});

describe("the shell", () => {
  it("shows the destination with its header, the current link and the counts, and locks", async () => {
    const user = userEvent.setup();
    const { session, workspace } = await mountApp("/livro", { heading: "Livro financeiro" });
    expect(screen.getByRole("link", { name: "Livro financeiro" }).getAttribute("aria-current")).toBe("page");
    // Counts come from the project itself (notices and items waiting for review).
    const counts = attentionCounts(workspace.ledger, workspace.today());
    const importName = counts["importar"]
      ? `Importar e revisar, ${counts["importar"]} itens pedem atenção`
      : "Importar e revisar";
    expect(screen.getByRole("link", { name: importName })).toBeTruthy();
    expect(screen.getByText("Sincronizado")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Bloquear o projeto" }));
    await screen.findByRole("heading", { name: "Casa está bloqueado" });
    expect(session.get().open).toBeNull();
    expect(screen.queryByRole("heading", { name: "Livro financeiro" })).toBeNull();
  });
});

describe("views outside the shell", () => {
  // Found by the every-screen e2e: a locked project has no workspace, and these views read it, so they left a
  // blank page with no way to unlock. They show the lock screen like the shell does.
  for (const path of [
    "/imprimir/relatorio-mensal",
    "/imprimir/relatorio-anual",
    "/imprimir/imposto",
    "/imprimir/investimentos",
    "/comecar",
  ]) {
    it(`${path} shows the lock screen while the project is locked, and the view after unlocking`, async () => {
      const user = userEvent.setup();
      const { services, session } = await mountApp(path);
      await waitFor(() => expect(session.get().open).not.toBeNull());
      await screen.findAllByRole("heading", { level: 1 });
      await act(async () => {
        await services.lock();
        session.update({ open: null, locked: true, lockedName: "Casa" });
      });
      await screen.findByRole("heading", { name: "Casa está bloqueado" });
      expect(screen.queryByText("Pão de Açúcar")).toBeNull();
      await user.type(screen.getByLabelText("Senha do projeto"), DEMO.projectPassword);
      await user.click(screen.getByRole("button", { name: "Desbloquear" }));
      await waitFor(() => expect(screen.queryByRole("heading", { name: "Casa está bloqueado" })).toBeNull());
    });
  }
});

describe("theme", () => {
  it("follows the system by default and applies a stored explicit choice", async () => {
    const services = createFakeServices();
    const session = new SessionStore();
    const router = createAppRouter({ session, history: createMemoryHistory({ initialEntries: ["/entrar"] }) });
    const view = render(
      <App router={router} services={services} session={session} preferences={memoryPreferences()} />,
    );
    await screen.findByRole("heading", { name: "Entrar" });
    expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
    view.unmount();
    render(
      <App
        router={createAppRouter({ session, history: createMemoryHistory({ initialEntries: ["/entrar"] }) })}
        services={services}
        session={session}
        preferences={memoryPreferences({ "aparencia/tema": "dark" })}
      />,
    );
    await waitFor(() => expect(document.documentElement.getAttribute("data-theme")).toBe("dark"));
  });
});
