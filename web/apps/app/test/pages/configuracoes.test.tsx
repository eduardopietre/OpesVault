/** Configurações: the sections, the project, the local AI, security, links and the read-only state. */
import { dom } from "@opesvault/domain";
import { screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AI_PORT_KEY, setAiTransport } from "../../src/data/ai.ts";
import { DEMO } from "../../src/services/fake.ts";
import { FakeOllama } from "./fake_ollama.ts";
import { openSettings, type } from "./configuracoes_harness.tsx";
import { addressSettles } from "../navigations.ts";
import { undoOnce, closed, dialog, goTab } from "../dom.ts";

afterEach(() => setAiTransport(null));

describe("Configurações page", () => {
  it("shows the five sections, says where each kind of setting lives and starts on the project", async () => {
    await openSettings();
    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual([
      "Projeto",
      "IA local",
      "Segurança",
      "Backup e salvamento",
      "Privacidade deste aparelho",
    ]);
    expect(screen.getByRole("tab", { name: "Projeto" }).getAttribute("aria-selected")).toBe("true");
    expect(
      screen.getByText(/O projeto vale para todos e sincroniza; as preferências valem só neste aparelho/),
    ).toBeTruthy();
    // every block names its scope in words
    const panel = screen.getByRole("tabpanel");
    expect(within(panel).getAllByText("Vale para todo o projeto").length).toBeGreaterThan(0);
  });

  it("opens the section a link points to (ia, seguranca, backup, privacidade, projeto)", async () => {
    for (const [ref, tab] of [
      ["ia", "IA local"],
      ["seguranca", "Segurança"],
      ["backup", "Backup e salvamento"],
      ["privacidade", "Privacidade deste aparelho"],
      ["projeto", "Projeto"],
    ] as const) {
      const { router } = await openSettings(`/configuracoes?ref=${ref}`);
      await waitFor(() => expect(screen.getByRole("tab", { name: tab }).getAttribute("aria-selected")).toBe("true"));
      // the ref is consumed: the URL is clean again
      await addressSettles(router, {});
      document.body.innerHTML = "";
    }
  });

  it("ignores a ref it does not know", async () => {
    await openSettings("/configuracoes?ref=nada");
    expect(screen.getByRole("tab", { name: "Projeto" }).getAttribute("aria-selected")).toBe("true");
  });
});

describe("Projeto", () => {
  it("renames the project (the top bar follows) and refuses an empty name", async () => {
    const { user, session } = await openSettings();
    const field = screen.getByLabelText("Nome do projeto");
    expect((field as HTMLInputElement).value).toBe("Casa");
    expect((screen.getByRole("button", { name: "Renomear" }) as HTMLButtonElement).disabled).toBe(true);
    await type(user, screen.getByRole("tabpanel"), "Nome do projeto", "Casa da Praia");
    await user.click(screen.getByRole("button", { name: "Renomear" }));
    await waitFor(() => expect(session.get().open?.project.name).toBe("Casa da Praia"));
    expect(await screen.findByText("Projeto renomeado.")).toBeTruthy();
    expect(screen.getAllByText("Casa da Praia").length).toBeGreaterThan(0); // the top bar follows
    await type(user, screen.getByRole("tabpanel"), "Nome do projeto", "   ");
    await user.click(screen.getByRole("button", { name: "Renomear" }));
    expect(await screen.findByText("Dê um nome ao projeto.")).toBeTruthy();
    expect(session.get().open?.project.name).toBe("Casa da Praia");
  });

  it("lists the members and leads to their tab in Contas e cartões", async () => {
    const { user, ledger, router } = await openSettings();
    const list = screen.getByRole("list", { name: "Integrantes do projeto" });
    for (const member of ledger.members.values()) expect(within(list).getByText(member.name)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Gerir integrantes em Contas e cartões" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/contas"));
    await waitFor(() =>
      expect(screen.getByRole("tab", { name: "Integrantes" }).getAttribute("aria-selected")).toBe("true"),
    );
  });
});

describe("IA local", () => {
  it("turns the AI on and off for the project, one undo step each", async () => {
    const { user, workspace, ledger } = await openSettings();
    await goTab(user, "IA local");
    // the demonstration project already has it on, with a model
    expect(dom.settings.getSettings(ledger).ai_enabled).toBe(true);
    const toggle = screen.getByRole("switch", { name: "Usar o Ollama local para sugestões" });
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    await user.click(toggle);
    expect(dom.settings.getSettings(ledger).ai_enabled).toBe(false);
    expect(await screen.findByText("IA local desligada para o projeto.")).toBeTruthy();
    expect(screen.queryByLabelText("Modelo")).toBeNull();
    await undoOnce(workspace);
    expect(dom.settings.getSettings(ledger).ai_enabled).toBe(true);
    await waitFor(() => expect(screen.getByLabelText("Modelo")).toBeTruthy());
    expect(
      screen.getByRole("switch", { name: "Usar o Ollama local para sugestões" }).getAttribute("aria-checked"),
    ).toBe("true");
  });

  it("changes the model with one undo step, only when it is committed", async () => {
    const { user, workspace, ledger } = await openSettings();
    await goTab(user, "IA local");
    const before = ledger.changeCount;
    const field = screen.getByLabelText("Modelo") as HTMLInputElement;
    expect(field.value).toBe("gemma4:12b");
    await user.clear(field);
    await user.type(field, "llama3.2:3b");
    // typing alone writes nothing into the project
    expect(ledger.changeCount).toBe(before);
    await user.keyboard("{Enter}");
    expect(dom.settings.getSettings(ledger).ai_model).toBe("llama3.2:3b");
    expect(await screen.findByText("Modelo da IA alterado.")).toBeTruthy();
    await undoOnce(workspace);
    expect(dom.settings.getSettings(ledger).ai_model).toBe("gemma4:12b");
    await waitFor(() => expect((screen.getByLabelText("Modelo") as HTMLInputElement).value).toBe("gemma4:12b"));
  });

  it("keeps the port on this device, at once, and refuses one that is not valid", async () => {
    const { user, preferences, ledger } = await openSettings();
    await goTab(user, "IA local");
    const before = ledger.changeCount;
    const port = screen.getByLabelText("Porta do Ollama") as HTMLInputElement;
    expect(port.value).toBe("11434");
    await user.clear(port);
    await user.type(port, "11500");
    await user.tab();
    expect(preferences.get(AI_PORT_KEY)).toBe("11500");
    expect(ledger.changeCount).toBe(before); // a device preference is not project data
    await user.clear(port);
    await user.type(port, "80");
    await user.tab();
    expect(await screen.findByText("Use uma porta entre 1024 e 65535.")).toBeTruthy();
    expect(preferences.get(AI_PORT_KEY)).toBe("11500");
    await user.clear(port);
    await user.type(port, "11434");
    await user.tab();
    expect(preferences.get(AI_PORT_KEY)).toBeNull(); // the default is not stored
  });

  it("checks Ollama: version, installed models and where the model runs", async () => {
    const fake = new FakeOllama();
    const urls: string[] = [];
    setAiTransport((url, init) => {
      urls.push(url);
      return fake.transport(url, init);
    });
    const { user, preferences } = await openSettings();
    preferences.set(AI_PORT_KEY, "11500");
    await goTab(user, "IA local");
    await user.clear(screen.getByLabelText("Porta do Ollama"));
    await user.type(screen.getByLabelText("Porta do Ollama"), "11500");
    await user.click(screen.getByRole("button", { name: "Verificar Ollama" }));
    const status = await screen.findByText(/Ollama 0\.35\.1 respondeu: 1 modelo\(s\) instalado\(s\)\./);
    expect(status.textContent).not.toContain("GPU"); // the fake does not say where the model runs
    expect(urls.every((url) => url.startsWith("http://127.0.0.1:11500/"))).toBe(true);
    // the installed ones can be chosen
    await user.click(screen.getByRole("combobox", { name: "Modelo instalado" }));
    await user.click(await screen.findByRole("option", { name: "gemma4:12b" }));
    expect((screen.getByLabelText("Modelo") as HTMLInputElement).value).toBe("gemma4:12b");
  });

  it("says in words how much of the model fits in the GPU", async () => {
    const GB = 1_000_000_000;
    for (const [vram, words] of [
      [8 * GB, "O modelo roda inteiro na GPU."],
      [0, "O modelo roda só na CPU"],
      [4 * GB, "Só 50% do modelo coube na GPU"],
    ] as const) {
      const base = new FakeOllama();
      setAiTransport((url, init) => {
        if (init.method === "GET" && url.endsWith("/api/ps")) {
          const body = { models: [{ name: "gemma4:12b", size: 8 * GB, size_vram: vram }] };
          return Promise.resolve({ status: 200, text: () => Promise.resolve(JSON.stringify(body)) });
        }
        return base.transport(url, init);
      });
      const { user } = await openSettings();
      await goTab(user, "IA local");
      await user.click(screen.getByRole("button", { name: "Verificar Ollama" }));
      expect((await screen.findByText(/Ollama 0\.35\.1 respondeu/)).textContent).toContain(words);
      document.body.innerHTML = "";
    }
  });

  it("says when the model is not installed and how to install it", async () => {
    setAiTransport(new FakeOllama().transport);
    const { user } = await openSettings();
    await goTab(user, "IA local");
    await type(user, screen.getByRole("tabpanel"), "Modelo", "outro:7b");
    await user.keyboard("{Enter}");
    await user.click(screen.getByRole("button", { name: "Verificar Ollama" }));
    expect(
      await screen.findByText(/o modelo outro:7b não está instalado\. Instale com “ollama pull outro:7b”/),
    ).toBeTruthy();
  });

  it("explains OLLAMA_ORIGINS with this app's exact origin and opens the guide when Ollama is unreachable", async () => {
    setAiTransport(() => Promise.reject(new TypeError("Failed to fetch")));
    const { user } = await openSettings();
    await goTab(user, "IA local");
    const guide = screen.getByRole("button", { name: /Liberar este endereço no Ollama/ });
    expect(guide.getAttribute("aria-expanded")).toBe("false");
    await user.click(screen.getByRole("button", { name: "Verificar Ollama" }));
    expect(
      await screen.findByText(/Ollama indisponível\. Abra o Ollama e confira se ele aceita este endereço/),
    ).toBeTruthy();
    await waitFor(() => expect(guide.getAttribute("aria-expanded")).toBe("true"));
    const origin = location.origin;
    expect(screen.getAllByText(origin).length).toBeGreaterThan(0);
    expect(screen.getByText(`setx OLLAMA_ORIGINS "${origin}"`)).toBeTruthy();
    expect(screen.getByText(`launchctl setenv OLLAMA_ORIGINS "${origin}"`)).toBeTruthy();
    expect(screen.getByText(/Environment="OLLAMA_ORIGINS=/)).toBeTruthy();
    // the commands can be copied
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    await user.click(screen.getByRole("button", { name: "Copiar o comando para Windows (PowerShell)" }));
    expect(writeText).toHaveBeenCalledWith(`setx OLLAMA_ORIGINS "${origin}"`);
    await user.click(screen.getByRole("button", { name: "Copiar o endereço" }));
    expect(writeText).toHaveBeenLastCalledWith(origin);
  });
});

describe("Segurança", () => {
  it("changes the project password: wrong current, mismatch, same as the current, then success", async () => {
    const { user, services } = await openSettings();
    await goTab(user, "Segurança");
    await user.click(screen.getByRole("button", { name: "Trocar senha…" }));
    const box = await dialog("Trocar a senha do projeto");
    const confirm = within(box).getByRole("button", { name: "Trocar senha" }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    await type(user, box, "Senha atual", "errada");
    await type(user, box, "Nova senha", "curta");
    expect(within(box).getByText("Use pelo menos 10 caracteres.")).toBeTruthy();
    await type(user, box, "Nova senha", "uma senha bem nova");
    await type(user, box, "Confirme a nova senha", "outra coisa");
    expect(within(box).getByText("As senhas não coincidem.")).toBeTruthy();
    expect(confirm.disabled).toBe(true);
    await type(user, box, "Confirme a nova senha", "uma senha bem nova");
    expect(confirm.disabled).toBe(false);
    await user.click(confirm);
    expect(await within(box).findByText("Senha do projeto incorreta.")).toBeTruthy();
    // same as the current: refused before asking anything
    await type(user, box, "Senha atual", DEMO.projectPassword);
    await type(user, box, "Nova senha", DEMO.projectPassword);
    await type(user, box, "Confirme a nova senha", DEMO.projectPassword);
    expect(within(box).getByText("A nova senha precisa ser diferente da atual.")).toBeTruthy();
    expect(confirm.disabled).toBe(true);
    await type(user, box, "Nova senha", "uma senha bem nova");
    await type(user, box, "Confirme a nova senha", "uma senha bem nova");
    await user.click(confirm);
    await closed("Trocar a senha do projeto");
    expect(await screen.findByText(/Senha do projeto trocada/)).toBeTruthy();
    // the new one opens the project and the old one does not
    await services.lock();
    await expect(services.unlock(DEMO.projectPassword)).rejects.toMatchObject({ code: "bad-password" });
    await expect(services.unlock("uma senha bem nova")).resolves.toBeTruthy();
  });

  it("regenerates the recovery key: shown once, cannot be skipped, and the old key stops working", async () => {
    const { user, services } = await openSettings();
    await goTab(user, "Segurança");
    await user.click(screen.getByRole("button", { name: "Gerar nova chave…" }));
    const ask = await dialog("Gerar nova chave de recuperação");
    await type(user, ask, "Senha do projeto", "errada");
    await user.click(within(ask).getByRole("button", { name: "Gerar nova chave" }));
    expect(await within(ask).findByText("Senha do projeto incorreta.")).toBeTruthy();
    await type(user, ask, "Senha do projeto", DEMO.projectPassword);
    await user.click(within(ask).getByRole("button", { name: "Gerar nova chave" }));
    const shown = await dialog("Guarde a nova chave de recuperação");
    const key = within(shown).getByRole("status", { name: "Nova chave de recuperação" }).textContent ?? "";
    // nine groups of four characters; not the demonstration key
    const groups = [...within(shown).getByLabelText("Nova chave de recuperação").querySelectorAll("span")].map(
      (span) => span.textContent,
    );
    expect(groups).toHaveLength(9);
    expect(groups.join("-")).not.toBe(DEMO.recoveryKey);
    expect(key.replace(/\s/g, "")).toBe(groups.join(""));
    // it cannot be closed before "Já guardei"
    const done = within(shown).getByRole("button", { name: "Concluir" }) as HTMLButtonElement;
    expect(done.disabled).toBe(true);
    expect(within(shown).queryByRole("button", { name: "Cancelar" })).toBeNull();
    expect(within(shown).queryByRole("button", { name: "Fechar" })).toBeNull();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Guarde a nova chave de recuperação" })).toBeTruthy();
    await user.click(within(shown).getByRole("checkbox", { name: /Já guardei a nova chave/ }));
    expect(done.disabled).toBe(false);
    await user.click(done);
    await closed("Guarde a nova chave de recuperação");
    // the old key no longer opens the project; the new one does
    await expect(
      services.recoverProject(services.demoProjectId!, DEMO.recoveryKey, "outra senha longa"),
    ).rejects.toMatchObject({
      code: "bad-recovery-key",
    });
    await expect(
      services.recoverProject(services.demoProjectId!, groups.join("-").toLowerCase(), "outra senha longa"),
    ).resolves.toBeTruthy();
  });

  it("sets the idle lock for this device at once and passes it to the services", async () => {
    const { user, preferences, services } = await openSettings();
    const setIdle = vi.spyOn(services, "setIdleLock");
    await goTab(user, "Segurança");
    expect(screen.getByRole("combobox", { name: "Bloquear após" }).textContent).toContain("15 minutos");
    await user.click(screen.getByRole("combobox", { name: "Bloquear após" }));
    await user.click(await screen.findByRole("option", { name: "5 minutos" }));
    expect(preferences.get("seguranca/bloqueio")).toBe("5");
    expect(setIdle).toHaveBeenCalledWith(5);
    expect(await screen.findByText(/bloqueia após 5 minutos sem uso neste aparelho/)).toBeTruthy();
    // there is no "off": the key stays in the tab while the project is open
    await user.click(screen.getByRole("combobox", { name: "Bloquear após" }));
    expect(screen.queryByRole("option", { name: /Desligado/ })).toBeNull();
    await user.keyboard("{Escape}");
  });

  it("locks the project now", async () => {
    const { user, session } = await openSettings();
    await goTab(user, "Segurança");
    await user.click(screen.getByRole("button", { name: "Bloquear agora" }));
    await waitFor(() => expect(session.get().locked).toBe(true));
    expect(session.get().open).toBeNull();
  });
});

describe("a project open for reading only", () => {
  it("disables what edits the project and keeps the security actions", async () => {
    const { user, ledger } = await openSettings("/configuracoes", {
      project: "blank",
      readOnly: true,
      openReadOnly: true,
    });
    const before = ledger.changeCount;
    expect((screen.getByLabelText("Nome do projeto") as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Renomear" }) as HTMLButtonElement).disabled).toBe(true);
    await goTab(user, "IA local");
    expect(
      (screen.getByRole("switch", { name: "Usar o Ollama local para sugestões" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    // the port is this device's, so it stays editable
    expect((screen.getByLabelText("Porta do Ollama") as HTMLInputElement).disabled).toBe(false);
    await goTab(user, "Segurança");
    expect((screen.getByRole("button", { name: "Trocar senha…" }) as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByRole("button", { name: "Bloquear agora" }) as HTMLButtonElement).disabled).toBe(false);
    expect(ledger.changeCount).toBe(before);
  });

  it("opens an empty project with every section in a state (TA-31)", async () => {
    const { user } = await openSettings("/configuracoes", { project: "blank" });
    expect(screen.getByText("Nenhum integrante cadastrado ainda.")).toBeTruthy();
    for (const tab of ["IA local", "Segurança", "Backup e salvamento", "Privacidade deste aparelho"]) {
      const panel = await goTab(user, tab);
      expect(within(panel).getAllByRole("heading", { level: 2 }).length).toBeGreaterThan(0);
    }
  });
});
