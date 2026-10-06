/** Configurações: backup (export, verify, restore as a new project), the reminder, this device and forgetting it. */
import { memoryPreferences } from "@opesvault/ui";
import { addDays, today } from "@opesvault/domain";
import { screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { lastBackupKey } from "../../src/data/backup.ts";
import { DEMO } from "../../src/services/fake.ts";
import {
  captureDownloads,
  closed,
  dialog,
  fileOf,
  goTab,
  openSettings,
  type,
  type User,
} from "./configuracoes_harness.tsx";

vi.mock("../../../../packages/ui/src/chart/echarts.ts", async () => await import("./fake_echarts.ts"));

let downloads: ReturnType<typeof captureDownloads>;
beforeEach(() => {
  downloads = captureDownloads();
});
afterEach(() => downloads.restore());

/** Opens the backup tab and makes a backup through the dialog. */
async function makeBackup(user: User, password: string = DEMO.projectPassword) {
  await goTab(user, "Backup e salvamento");
  await user.click(screen.getByRole("button", { name: "Fazer backup agora…" }));
  const box = await dialog("Fazer backup agora");
  await type(user, box, "Senha do projeto", password);
  await user.click(within(box).getByRole("button", { name: "Gerar backup" }));
  return box;
}

const latin1 = async (blob: Blob) => new TextDecoder("latin1").decode(await blob.arrayBuffer());

describe("Backup e salvamento: fazer backup", () => {
  it("asks for the password again, seals the whole project and offers the file", async () => {
    const { user, ledger, preferences, session } = await openSettings("/configuracoes?ref=backup");
    const status = screen.getByText("Nenhum backup feito neste aparelho");
    expect(status).toBeTruthy();

    await goTab(user, "Backup e salvamento");
    await user.click(screen.getByRole("button", { name: "Fazer backup agora…" }));
    const box = await dialog("Fazer backup agora");
    const confirm = within(box).getByRole("button", { name: "Gerar backup" }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    await type(user, box, "Senha do projeto", "errada");
    await user.click(confirm);
    expect(await within(box).findByText("Senha do projeto incorreta.")).toBeTruthy();
    expect(downloads.files).toHaveLength(0);

    await type(user, box, "Senha do projeto", DEMO.projectPassword);
    await user.click(confirm);
    const done = await dialog("Backup pronto");
    expect(downloads.files).toHaveLength(1);
    const file = downloads.files[0]!;
    expect(file.name).toMatch(/^opesvault-backup-\d{4}-\d{2}-\d{2}\.ovbackup$/);
    expect(file.name.toLowerCase()).not.toContain("casa");
    // sealed: the magic and nothing readable (not the project's name, a description, a kind)
    const text = await latin1(file.blob);
    expect(text.startsWith("OVBK")).toBe(true);
    const operation = [...ledger.operations.values()][0]!;
    for (const secret of ["Casa", operation.description, "operation", "members", "original_name"]) {
      expect(text).not.toContain(secret);
    }
    expect(within(done).getByText(file.name)).toBeTruthy();
    expect(within(done).getByText("Registros").nextElementSibling?.textContent).toBe(
      String(ledger.toRecords().length + session.get().open!.workspace.session.documents.length),
    );
    // "Baixar de novo" offers it again
    await user.click(within(done).getByRole("button", { name: "Baixar de novo" }));
    expect(downloads.files).toHaveLength(2);
    await user.click(within(done).getByRole("button", { name: "Fechar" }));
    await closed("Backup pronto");

    // the day is remembered on this device, per project, and the status changes
    expect(preferences.get(lastBackupKey(session.get().open!.project.id))).toBe(today());
    expect(screen.getByText(/Último backup feito neste aparelho: \d{2}\/\d{2}\/\d{4} \(hoje\)/)).toBeTruthy();
    expect(screen.getByText("Em dia")).toBeTruthy();
  });

  it("does not remember a backup that failed", async () => {
    const { user, preferences, session } = await openSettings();
    const box = await makeBackup(user, "errada");
    expect(await within(box).findByText("Senha do projeto incorreta.")).toBeTruthy();
    expect(preferences.get(lastBackupKey(session.get().open!.project.id))).toBeNull();
    await user.click(within(box).getByRole("button", { name: "Cancelar" }));
    await closed("Fazer backup agora");
  });
});

describe("Backup e salvamento: verificar arquivo", () => {
  async function exported(user: User) {
    await makeBackup(user);
    const done = await dialog("Backup pronto");
    await user.click(within(done).getByRole("button", { name: "Fechar" }));
    await closed("Backup pronto");
    return downloads.files[0]!;
  }

  async function openVerify(user: User, file: File, password: string) {
    await user.click(screen.getByRole("button", { name: "Verificar arquivo…" }));
    const box = await dialog("Verificar arquivo de backup");
    await user.upload(within(box).getByLabelText("Arquivo de backup") as HTMLInputElement, file);
    await type(user, box, "Senha do arquivo", password);
    await user.click(within(box).getByRole("button", { name: "Verificar" }));
    return box;
  }

  it("decrypts and checks the whole file without restoring anything", async () => {
    const { user, ledger, session, services } = await openSettings();
    const file = await exported(user);
    const projects = await services.listProjects();
    const box = await openVerify(user, await fileOf(file), DEMO.projectPassword);
    const result = await dialog("Arquivo verificado");
    expect(box).toBeTruthy();
    expect(within(result).getByText("Casa")).toBeTruthy();
    const documents = session.get().open!.workspace.session.documents.length;
    expect(within(result).getByText("Registros").nextElementSibling?.textContent).toBe(
      String(ledger.toRecords().length + documents),
    );
    expect(within(result).getByText(new RegExp(`^${documents} \\(`))).toBeTruthy();
    expect(within(result).getByText(/o arquivo está íntegro e completo/)).toBeTruthy();
    await user.click(within(result).getByRole("button", { name: "Fechar" }));
    await closed("Arquivo verificado");
    expect(await services.listProjects()).toEqual(projects); // nothing was created
  });

  it("says a wrong password, a damaged file and a file that is not a backup, each in its own words", async () => {
    const { user } = await openSettings();
    const file = await exported(user);
    const original = await fileOf(file);

    let box = await openVerify(user, original, "senha errada do arquivo");
    expect(await within(box).findByText(/Senha incorreta para este arquivo/)).toBeTruthy();
    await user.click(within(box).getByRole("button", { name: "Cancelar" }));
    await closed("Verificar arquivo de backup");

    const bytes = new Uint8Array(await original.arrayBuffer());
    bytes[bytes.length - 3] = bytes[bytes.length - 3]! ^ 1;
    box = await openVerify(user, new File([bytes], "alterado.ovbackup"), DEMO.projectPassword);
    expect(await within(box).findByText(/danificado, incompleto ou foi alterado/)).toBeTruthy();
    await user.click(within(box).getByRole("button", { name: "Cancelar" }));
    await closed("Verificar arquivo de backup");

    const cut = new File([bytes.slice(0, bytes.length - 100)], "cortado.ovbackup");
    box = await openVerify(user, cut, DEMO.projectPassword);
    expect(await within(box).findByText(/danificado, incompleto ou foi alterado/)).toBeTruthy();
    await user.click(within(box).getByRole("button", { name: "Cancelar" }));
    await closed("Verificar arquivo de backup");

    box = await openVerify(user, new File(["%PDF-1.7 isto é um pdf, não um backup do aplicativo"], "doc.pdf"), "x");
    expect(await within(box).findByText("Este arquivo não é um backup do OpesVault.")).toBeTruthy();
    await user.click(within(box).getByRole("button", { name: "Cancelar" }));
    await closed("Verificar arquivo de backup");

    const future = bytes.slice();
    future[4] = 7;
    box = await openVerify(user, new File([future], "futuro.ovbackup"), DEMO.projectPassword);
    expect(await within(box).findByText(/feito por uma versão mais nova do aplicativo/)).toBeTruthy();
  });
});

describe("Backup e salvamento: restaurar backup", () => {
  async function restoreDialog(user: User, file: File, password: string, name = "") {
    await user.click(screen.getByRole("button", { name: "Restaurar backup…" }));
    const box = await dialog("Restaurar backup");
    await user.upload(within(box).getByLabelText("Arquivo de backup") as HTMLInputElement, file);
    await type(user, box, "Senha do arquivo", password);
    if (name) await type(user, box, "Nome do projeto novo", name);
    await user.click(within(box).getByRole("button", { name: "Restaurar como projeto novo" }));
    return box;
  }

  async function backupFile(user: User) {
    await makeBackup(user);
    const done = await dialog("Backup pronto");
    await user.click(within(done).getByRole("button", { name: "Fechar" }));
    await closed("Backup pronto");
    return fileOf(downloads.files[0]!);
  }

  it("makes a NEW project with its own recovery key and leaves the open one alone", async () => {
    const { user, services, session, ledger } = await openSettings();
    const file = await backupFile(user);
    const original = session.get().open!;
    const before = JSON.stringify(ledger.toRecords());
    await restoreDialog(user, file, DEMO.projectPassword, "Cópia de Casa");
    const box = await dialog("Projeto restaurado");
    // the file is described and the new project's recovery key is shown once
    expect(within(box).getByText("Cópia de Casa")).toBeTruthy();
    expect(within(box).getByText(/o arquivo está íntegro e completo/)).toBeTruthy();
    const key = within(box).getByLabelText("Chave de recuperação do projeto restaurado");
    expect([...key.querySelectorAll("span")]).toHaveLength(9);
    // it cannot be left (or the new project opened) before "Já guardei"
    const open = within(box).getByRole("button", { name: "Abrir o projeto restaurado" }) as HTMLButtonElement;
    const stay = within(box).getByRole("button", { name: "Ficar aqui" }) as HTMLButtonElement;
    expect(open.disabled).toBe(true);
    expect(stay.disabled).toBe(true);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Projeto restaurado" })).toBeTruthy();
    await user.click(within(box).getByRole("checkbox", { name: /Já guardei a chave de recuperação/ }));
    expect(stay.disabled).toBe(false);
    await user.click(stay);
    await closed("Projeto restaurado");

    // two projects now; the open one is the same and untouched
    const projects = await services.listProjects();
    expect(projects).toHaveLength(2);
    expect(projects.map((p) => p.name).sort()).toEqual(["Casa", "Cópia de Casa"]);
    expect(session.get().open?.project.id).toBe(original.project.id);
    expect(JSON.stringify(ledger.toRecords())).toBe(before);
    expect(projects.find((p) => p.name === "Cópia de Casa")!.id).not.toBe(original.project.id);
  });

  it("opens the restored project, identical to the original, with the file's password", async () => {
    const { user, session, services, ledger } = await openSettings();
    const file = await backupFile(user);
    const originalId = session.get().open!.project.id;
    const originalDocs = session.get().open!.workspace.session.documents.map((d) => [d.meta.id, d.meta.sha256]);
    await restoreDialog(user, file, DEMO.projectPassword);
    const box = await dialog("Projeto restaurado");
    // the default name keeps the file's, marked as restored
    expect(within(box).getAllByText("Casa (restaurado)").length).toBeGreaterThan(0);
    await user.click(within(box).getByRole("checkbox", { name: /Já guardei a chave de recuperação/ }));
    await user.click(within(box).getByRole("button", { name: "Abrir o projeto restaurado" }));
    await closed("Projeto restaurado");
    await waitFor(() => expect(session.get().open?.project.name).toBe("Casa (restaurado)"));
    const restored = session.get().open!;
    expect(restored.project.id).not.toBe(originalId);
    expect(JSON.stringify(restored.workspace.ledger.toRecords())).toBe(JSON.stringify(ledger.toRecords()));
    expect(restored.workspace.session.documents.map((d) => [d.meta.id, d.meta.sha256])).toEqual(originalDocs);
    for (const d of restored.workspace.session.documents) {
      expect(d.data.length).toBe(d.meta.size);
    }
    await waitFor(() => expect(screen.getByRole("heading", { level: 1, name: "Visão geral" })).toBeTruthy());
    expect(await services.listProjects()).toHaveLength(2);
  });

  it("a wrong password or a damaged file creates nothing", async () => {
    const { user, services } = await openSettings();
    const file = await backupFile(user);
    let box = await restoreDialog(user, file, "senha errada do arquivo");
    expect(await within(box).findByText(/Senha incorreta para este arquivo/)).toBeTruthy();
    await user.click(within(box).getByRole("button", { name: "Cancelar" }));
    await closed("Restaurar backup");
    const bytes = new Uint8Array(await file.arrayBuffer());
    bytes[bytes.length - 2] = bytes[bytes.length - 2]! ^ 4;
    box = await restoreDialog(user, new File([bytes], "alterado.ovbackup"), DEMO.projectPassword);
    expect(await within(box).findByText(/danificado, incompleto ou foi alterado/)).toBeTruthy();
    expect(await services.listProjects()).toHaveLength(1);
  });
});

describe("the reminder of an old backup", () => {
  const daysAgo = (n: number) => addDays(today(), -n);

  /** The notices panel shows a few; the backup one is informative, so it comes last. */
  async function showAllNotices(user: User) {
    const all = screen.queryByRole("button", { name: /^Mostrar todos/ });
    if (all) await user.click(all);
  }

  /** Opens the Visão geral of the demonstration project with the last backup of this device `days` ago. */
  async function overviewWithBackup(days: number | null, empty = false) {
    const mounted = await openSettings("/configuracoes", { empty });
    const id = mounted.session.get().open!.project.id;
    if (days !== null) mounted.preferences.set(lastBackupKey(id), daysAgo(days));
    await mounted.router.navigate({ to: "/visao-geral" });
    await screen.findByRole("heading", { level: 1, name: "Visão geral" });
    return mounted;
  }

  it("appears in the Visão geral after 30 days and leads to the Backup section", async () => {
    const { user, session } = await overviewWithBackup(45);
    await showAllNotices(user);
    const notice = (await screen.findByText("Último backup há 45 dias")).closest("li") as HTMLElement;
    expect(
      within(notice).getByText(
        /de \d{2}\/\d{2}\/\d{4}; faça um novo em Configurações e confira-o com “Verificar arquivo…”/,
      ),
    ).toBeTruthy();
    await user.click(within(notice).getByRole("button", { name: /^Abrir Configurações: Último backup/ }));
    await screen.findByRole("heading", { level: 1, name: "Configurações" });
    await waitFor(() =>
      expect(screen.getByRole("tab", { name: "Backup e salvamento" }).getAttribute("aria-selected")).toBe("true"),
    );
    expect(session.get().open).not.toBeNull();
  });

  it("stays quiet within 30 days", async () => {
    const { user } = await overviewWithBackup(10);
    await showAllNotices(user);
    await waitFor(() => expect(screen.queryByText("Último backup há 10 dias")).toBeNull());
    expect(screen.queryByText("Faça um backup do cofre")).toBeNull();
  });

  it("nudges a project with data that was never backed up here, but not an empty project", async () => {
    const { user } = await overviewWithBackup(null);
    await showAllNotices(user);
    expect(await screen.findByText("Faça um backup do cofre")).toBeTruthy();
    expect(screen.getByText(/nenhum backup foi feito neste aparelho; faça um em Configurações/)).toBeTruthy();
    document.body.innerHTML = "";
    await overviewWithBackup(null, true);
    expect(screen.queryByText("Faça um backup do cofre")).toBeNull();
  });

  it("goes away once a backup is made", async () => {
    const { user, router } = await openSettings();
    const done = await makeBackup(user);
    await dialog("Backup pronto");
    expect(done).toBeTruthy();
    await router.navigate({ to: "/visao-geral" });
    await screen.findByRole("heading", { level: 1, name: "Visão geral" });
    expect(screen.queryByText("Faça um backup do cofre")).toBeNull();
  });
});

describe("Privacidade deste aparelho", () => {
  const storage = (persisted: boolean) => {
    const state = { persisted };
    Object.defineProperty(navigator, "storage", {
      configurable: true,
      value: {
        persisted: () => Promise.resolve(state.persisted),
        persist: vi.fn(() => {
          state.persisted = true;
          return Promise.resolve(true);
        }),
        estimate: () => Promise.resolve({ usage: 5_242_880, quota: 10_737_418_240 }),
      },
    });
    return state;
  };
  afterEach(() => Object.defineProperty(navigator, "storage", { configurable: true, value: undefined }));

  it("tells what this browser keeps, how much room it uses and whether it is protected", async () => {
    storage(false);
    const { user, preferences } = await openSettings("/configuracoes?ref=privacidade", {
      preferences: memoryPreferences({ "aparencia/tema": "dark", "ia/porta": "11500" }),
    });
    void preferences;
    const panel = await goTab(user, "Privacidade deste aparelho");
    for (const title of [
      "Cópia cifrada do projeto (IndexedDB)",
      "Preferências deste aparelho",
      "Rótulo desta aba",
      "Sessão da conta",
    ]) {
      expect(within(panel).getByText(title)).toBeTruthy();
    }
    expect(await within(panel).findByText("Não protegido")).toBeTruthy();
    expect(within(panel).getByText(/Este site usa 5 MiB de 10 GiB disponíveis/)).toBeTruthy();
    expect(within(panel).getByText("2 preferências guardadas neste aparelho agora.")).toBeTruthy();
    await user.click(within(panel).getByRole("button", { name: "Pedir proteção" }));
    expect(await within(panel).findByText("Protegido")).toBeTruthy();
    expect(within(panel).queryByRole("button", { name: "Pedir proteção" })).toBeNull();
  });

  it("says so when the browser does not report the storage", async () => {
    const { user } = await openSettings();
    const panel = await goTab(user, "Privacidade deste aparelho");
    expect(await within(panel).findByText("Sem informação")).toBeTruthy();
    expect(within(panel).queryByRole("button", { name: "Pedir proteção" })).toBeNull();
  });

  it("forgets this device after confirming: locks, clears the preferences and signs out", async () => {
    const preferences = memoryPreferences({ "aparencia/tema": "dark", "secoes/x": "0" });
    const { user, services, session, router } = await openSettings("/configuracoes?ref=privacidade", { preferences });
    vi.spyOn(services, "pendingChanges").mockResolvedValue(2);
    const forget = vi.spyOn(services, "forgetDevice");
    await goTab(user, "Privacidade deste aparelho");
    await user.click(screen.getByRole("button", { name: "Esquecer este aparelho…" }));
    const ask = await screen.findByRole("alertdialog", { name: "Esquecer este aparelho?" });
    expect(within(ask).getByText(/Há 2 alterações ainda não enviadas ao servidor: elas serão perdidas/)).toBeTruthy();
    // cancelling changes nothing
    await user.click(within(ask).getByRole("button", { name: "Cancelar" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(forget).not.toHaveBeenCalled();
    expect(preferences.get("aparencia/tema")).toBe("dark");
    expect(session.get().account).not.toBeNull();

    await user.click(screen.getByRole("button", { name: "Esquecer este aparelho…" }));
    const again = await screen.findByRole("alertdialog", { name: "Esquecer este aparelho?" });
    await user.click(within(again).getByRole("button", { name: "Esquecer este aparelho" }));
    await waitFor(() => expect(session.get().account).toBeNull());
    expect(forget).toHaveBeenCalledTimes(1);
    expect(session.get().open).toBeNull();
    expect(preferences.get("aparencia/tema")).toBeNull();
    expect(preferences.get("secoes/x")).toBeNull();
    await waitFor(() => expect(router.state.location.pathname).toBe("/boas-vindas"));
    // the services forgot the session: the projects are not listed any more
    await expect(services.listProjects()).rejects.toMatchObject({ code: "signed-out" });
  });

  it("says nothing about pending changes when there are none", async () => {
    const { user } = await openSettings();
    await goTab(user, "Privacidade deste aparelho");
    await user.click(screen.getByRole("button", { name: "Esquecer este aparelho…" }));
    const ask = await screen.findByRole("alertdialog", { name: "Esquecer este aparelho?" });
    expect(within(ask).queryByText(/ainda não enviad/)).toBeNull();
    await user.click(within(ask).getByRole("button", { name: "Cancelar" }));
  });
});
