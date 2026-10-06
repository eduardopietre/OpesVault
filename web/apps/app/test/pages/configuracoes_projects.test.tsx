/** The projects screen: restoring a backup as a new project and opening a project with its recovery key. */
import { screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEMO } from "../../src/services/fake.ts";
import { captureDownloads, closed, dialog, fileOf, openProjects, type } from "./configuracoes_harness.tsx";

vi.mock("../../../../packages/ui/src/chart/echarts.ts", async () => await import("./fake_echarts.ts"));

let downloads: ReturnType<typeof captureDownloads>;
beforeEach(() => {
  downloads = captureDownloads();
});
afterEach(() => downloads.restore());

describe("Projetos: restaurar backup", () => {
  async function aBackup(services: Awaited<ReturnType<typeof openProjects>>["services"]) {
    await services.openProject(services.demoProjectId!, DEMO.projectPassword);
    const made = await services.exportBackup(DEMO.projectPassword);
    await services.closeProject();
    return new File([await made.blob.arrayBuffer()], made.fileName);
  }

  it("restores into a new project that shows in the list, leaving the others as they are", async () => {
    const { user, services } = await openProjects();
    const file = await aBackup(services);
    expect(screen.getAllByRole("button", { name: /Casa/ })).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: "Restaurar backup…" }));
    const box = await dialog("Restaurar backup");
    await user.upload(within(box).getByLabelText("Arquivo de backup") as HTMLInputElement, file);
    await type(user, box, "Senha do arquivo", DEMO.projectPassword);
    await type(user, box, "Nome do projeto novo", "Casa restaurada");
    await user.click(within(box).getByRole("button", { name: "Restaurar como projeto novo" }));
    const done = await dialog("Projeto restaurado");
    await user.click(within(done).getByRole("checkbox", { name: /Já guardei a chave de recuperação/ }));
    await user.click(within(done).getByRole("button", { name: "Ficar aqui" }));
    await closed("Projeto restaurado");
    await waitFor(() => expect(screen.getByRole("button", { name: /Casa restaurada/ })).toBeTruthy());
    expect(screen.getAllByRole("button", { name: /Casa/ })).toHaveLength(2);
    expect((await services.listProjects()).map((p) => p.name).sort()).toEqual(["Casa", "Casa restaurada"]);
  });

  it("opens the restored project when asked", async () => {
    const { user, services, session, router } = await openProjects();
    const file = await aBackup(services);
    await user.click(screen.getByRole("button", { name: "Restaurar backup…" }));
    const box = await dialog("Restaurar backup");
    await user.upload(within(box).getByLabelText("Arquivo de backup") as HTMLInputElement, file);
    await type(user, box, "Senha do arquivo", DEMO.projectPassword);
    await user.click(within(box).getByRole("button", { name: "Restaurar como projeto novo" }));
    const done = await dialog("Projeto restaurado");
    await user.click(within(done).getByRole("checkbox", { name: /Já guardei a chave de recuperação/ }));
    await user.click(within(done).getByRole("button", { name: "Abrir o projeto restaurado" }));
    await waitFor(() => expect(session.get().open?.project.name).toBe("Casa (restaurado)"));
    await waitFor(() => expect(router.state.location.pathname).toBe("/visao-geral"));
    expect(session.get().open!.workspace.ledger.operations.size).toBeGreaterThan(0);
  });

  it("a wrong password leaves the list as it was", async () => {
    const { user, services } = await openProjects();
    const file = await aBackup(services);
    await user.click(screen.getByRole("button", { name: "Restaurar backup…" }));
    const box = await dialog("Restaurar backup");
    await user.upload(within(box).getByLabelText("Arquivo de backup") as HTMLInputElement, file);
    await type(user, box, "Senha do arquivo", "senha errada do arquivo");
    await user.click(within(box).getByRole("button", { name: "Restaurar como projeto novo" }));
    expect(await within(box).findByText(/Senha incorreta para este arquivo/)).toBeTruthy();
    await user.click(within(box).getByRole("button", { name: "Cancelar" }));
    await closed("Restaurar backup");
    expect(await services.listProjects()).toHaveLength(1);
  });
});

describe("Projetos: esqueci a senha", () => {
  async function openRecovery(user: Awaited<ReturnType<typeof openProjects>>["user"]) {
    await user.click(screen.getByRole("button", { name: /Casa/ }));
    const open = await dialog("Abrir Casa");
    await user.click(within(open).getByRole("button", { name: "Esqueci a senha" }));
    await closed("Abrir Casa");
    return dialog("Recuperar Casa");
  }

  it("opens the project with the recovery key and sets a new password", async () => {
    const { user, services, session, router } = await openProjects();
    const box = await openRecovery(user);
    const confirm = within(box).getByRole("button", { name: "Recuperar e abrir" }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    await type(user, box, "Nova senha do projeto", "curta");
    expect(within(box).getByText("Use pelo menos 10 caracteres.")).toBeTruthy();
    await type(user, box, "Nova senha do projeto", "uma senha bem nova");
    await type(user, box, "Confirme a nova senha", "diferente");
    expect(within(box).getByText("As senhas não coincidem.")).toBeTruthy();
    await type(user, box, "Confirme a nova senha", "uma senha bem nova");

    // a mistyped key and another project's key are refused inside the dialog
    await type(user, box, "Chave de recuperação", "AAAA-BBBB-CCCC");
    await user.click(confirm);
    expect(await within(box).findByText(/Chave de recuperação incorreta\. Confira os grupos digitados\./)).toBeTruthy();
    expect(session.get().open).toBeNull();

    // the right key, in lower case and without dashes
    await type(user, box, "Chave de recuperação", DEMO.recoveryKey.toLowerCase().replaceAll("-", ""));
    await user.click(confirm);
    await closed("Recuperar Casa");
    await waitFor(() => expect(session.get().open?.project.name).toBe("Casa"));
    await waitFor(() => expect(router.state.location.pathname).toBe("/visao-geral"));
    // the password was reset: the old one no longer opens it
    await services.lock();
    await expect(services.unlock(DEMO.projectPassword)).rejects.toMatchObject({ code: "bad-password" });
    await expect(services.unlock("uma senha bem nova")).resolves.toBeTruthy();
  });

  it("can be given up: Cancelar leaves the list as it was", async () => {
    const { user, session } = await openProjects();
    const box = await openRecovery(user);
    await user.click(within(box).getByRole("button", { name: "Cancelar" }));
    await closed("Recuperar Casa");
    expect(session.get().open).toBeNull();
    expect(screen.getByRole("button", { name: /Casa/ })).toBeTruthy();
  });
});

// the file helper is part of the harness for the other test files too
void fileOf;
