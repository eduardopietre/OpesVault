import { memoryPreferences } from "@opesvault/ui";
import { createMemoryHistory } from "@tanstack/react-router";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { App } from "../src/App.tsx";
import { createAppRouter } from "../src/router.tsx";
import { DEMO, createFakeServices } from "../src/services/fake.ts";
import { SessionStore } from "../src/session.tsx";

function mount(path: string) {
  const services = createFakeServices({ seed: true });
  const session = new SessionStore();
  const history = createMemoryHistory({ initialEntries: [path] });
  const router = createAppRouter({ session, history });
  render(<App router={router} services={services} session={session} preferences={memoryPreferences()} />);
  return { router, session, services };
}

describe("screens before a project", () => {
  it("send a signed-out visitor to sign in, validate the form and open the projects", async () => {
    const user = userEvent.setup();
    const { router } = mount("/livro");
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

  it("enables Criar conta only when the passwords match", async () => {
    const user = userEvent.setup();
    mount("/criar-conta");
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

describe("the shell", () => {
  it("shows the destination with its header, the current link and the counts, and locks", async () => {
    const user = userEvent.setup();
    const services = createFakeServices({ seed: true });
    const session = new SessionStore();
    const account = await services.signIn(DEMO.email, DEMO.password);
    const open = await services.openProject(services.demoProjectId!, DEMO.projectPassword);
    session.update({ account, open, operatorId: "m1" });
    const router = createAppRouter({ session, history: createMemoryHistory({ initialEntries: ["/livro"] }) });
    render(<App router={router} services={services} session={session} preferences={memoryPreferences()} />);
    await screen.findByRole("heading", { level: 1, name: "Livro financeiro" });
    expect(screen.getByRole("link", { name: "Livro financeiro" }).getAttribute("aria-current")).toBe("page");
    expect(screen.getByRole("link", { name: "Importar e revisar, 2 itens pedem atenção" })).toBeTruthy();
    expect(screen.getByText("Sincronizado")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Bloquear o projeto" }));
    await screen.findByRole("heading", { name: "Casa está bloqueado" });
    expect(session.get().open).toBeNull();
    expect(screen.queryByRole("heading", { name: "Livro financeiro" })).toBeNull();
  });
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
