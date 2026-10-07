/**
 * Opening a project on a device that never had it (progress and cancel), and the warning shown when the browser may
 * erase changes not yet sent (docs/19 §8).
 */
import "fake-indexeddb/auto";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { AccountType, type IsoDate } from "@opesvault/domain";
import { MemoryServer, VaultCache } from "@opesvault/vault";
import { memoryPreferences } from "@opesvault/ui";
import { createMemoryHistory } from "@tanstack/react-router";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App.tsx";
import { createAppRouter } from "../src/router.tsx";
import { openProgressText } from "../src/screens/projects.tsx";
import { DEMO, createFakeServices } from "../src/services/fake.ts";
import { createRealServices } from "../src/services/real.ts";
import type { OpenOptions, OpenProgress, SyncDetail } from "../src/services/types.ts";
import { SessionStore, sessionActions } from "../src/session.tsx";
import { storageWarningText } from "../src/shell/StorageWarning.tsx";

const KDF = { algorithm: "argon2id", memoryKiB: 8192, iterations: 1, parallelism: 1 } as const;

function device(server: MemoryServer, holder: string) {
  const factory = new IDBFactory();
  return createRealServices({
    backend: server.client(),
    openCache: () => VaultCache.open({ factory, keyRange: IDBKeyRange }),
    holder,
    kdf: KDF,
    idleLockMs: null,
    vaultOptions: { pushDelayMs: 0, pollMs: 50 },
  });
}

async function until(condition: () => boolean, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** A project with a few operations, created on device A; device B (same account) has never opened it. */
async function sharedProject() {
  const server = new MemoryServer();
  const a = device(server, "tab-a");
  await a.signUp({ name: "Ana Souza", email: "ana@example.com", password: "senha da conta" });
  const created = await a.createProject({ name: "Casa", password: "senha do projeto" });
  const ws = (await a.openProject(created.project.id, "senha do projeto")).workspace;
  const bank = ws.act((l) =>
    l.addAccount({
      id: crypto.randomUUID(),
      name: "Banco",
      type: "asset",
      subtype: "checking",
      currency: "BRL",
      institution: null,
      masked_number: null,
      holders: [],
      parent_id: null,
      archived: false,
    }),
  );
  const food = ws.ledger.categories(AccountType.EXPENSE).find((c) => c.name === "Alimentação")!.id;
  for (let day = 1; day <= 5; day++) {
    ws.act((l) => l.recordExpense(bank.id, food, "10.00", `2026-01-0${day}` as IsoDate, `Mercado ${day}`));
  }
  await ws.settled();
  await a.closeProject();
  const b = device(server, "tab-b");
  await b.signIn("ana@example.com", "senha da conta");
  return { server, a, b, projectId: created.project.id };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("opening a project this device never had", () => {
  it("reports the download and the decryption", async () => {
    const { b, projectId } = await sharedProject();
    const heard: OpenProgress[] = [];
    const open = await b.openProject(projectId, "senha do projeto", { onProgress: (p) => heard.push(p) });
    expect(open.workspace.ledger.operations.size).toBe(5);
    expect(heard.some((p) => p.phase === "download")).toBe(true);
    const last = heard.filter((p) => p.phase === "open").at(-1)!;
    expect(last.done).toBe(last.total);
    await b.closeProject();
  }, 30_000);

  it("can be cancelled; the project stays closed and opens later", async () => {
    const { b, projectId } = await sharedProject();
    const controller = new AbortController();
    const opening = b.openProject(projectId, "senha do projeto", {
      signal: controller.signal,
      onProgress: (p) => p.phase === "download" && controller.abort(),
    });
    await expect(opening).rejects.toMatchObject({ code: "cancelled" });
    await expect(b.renameProject("Outro")).rejects.toMatchObject({ code: "not-open" });
    const open = await b.openProject(projectId, "senha do projeto");
    expect(open.workspace.ledger.operations.size).toBe(5);
    await b.closeProject();
  }, 30_000);

  it("the dialog shows the progress after a moment and Cancelar stops it", async () => {
    const user = userEvent.setup();
    const fake = createFakeServices({ seed: true });
    let seen: OpenOptions | undefined;
    const services = {
      ...fake,
      openProject: (_id: string, _password: string, options?: OpenOptions) => {
        seen = options;
        options?.onProgress?.({ phase: "download", done: 40_000, total: null, fraction: 0.4 });
        return new Promise<never>((_, reject) =>
          options?.signal?.addEventListener("abort", () =>
            reject(Object.assign(new Error("cancelada"), { code: "cancelled" })),
          ),
        );
      },
    };
    const session = new SessionStore();
    const router = createAppRouter({ session, history: createMemoryHistory({ initialEntries: ["/entrar"] }) });
    render(<App router={router} services={services} session={session} preferences={memoryPreferences()} />);
    await act(() => sessionActions(services, session).signIn(DEMO.email, DEMO.password));
    await act(() => router.navigate({ to: "/projetos" }));
    await user.click(await screen.findByText("Casa"));
    await user.type(screen.getByLabelText("Senha do projeto"), DEMO.projectPassword);
    await user.click(screen.getByRole("button", { name: "Abrir projeto" }));
    expect(await screen.findByText("Baixando o projeto: 40.000 registros (40%)")).toBeTruthy();
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("40");
    await user.click(screen.getByRole("button", { name: "Cancelar" }));
    expect(seen?.signal?.aborted).toBe(true);
    await waitFor(() => expect(screen.queryByText(/Baixando o projeto/)).toBeNull());
    expect(session.get().open).toBeNull();
  });

  it("says what is happening in each phase", () => {
    expect(openProgressText({ phase: "download", done: 40_000, total: null, fraction: 0.4 })).toBe(
      "Baixando o projeto: 40.000 registros (40%)",
    );
    expect(openProgressText({ phase: "download", done: 1, total: null, fraction: null })).toBe(
      "Baixando o projeto: 1 registro",
    );
    expect(openProgressText({ phase: "open", done: 40_000, total: 100_000, fraction: 0.4 })).toBe(
      "Abrindo o projeto: 40.000 de 100.000 registros",
    );
  });
});

describe("when the browser may erase this device's data", () => {
  it("the services report changes waiting while persistence is denied", async () => {
    vi.stubGlobal("navigator", {
      ...globalThis.navigator,
      storage: { persisted: () => Promise.resolve(false), persist: () => Promise.resolve(false) },
    });
    const { server, a, projectId } = await sharedProject();
    const details: SyncDetail[] = [];
    a.watchSync((_status, detail) => detail && details.push(detail));
    const ws = (await a.openProject(projectId, "senha do projeto")).workspace;
    await until(() => details.some((d) => d.storageAtRisk));
    server.offline = true;
    const bank = [...ws.ledger.accounts.values()].find((acc) => acc.name === "Banco")!;
    const food = ws.ledger.categories(AccountType.EXPENSE).find((c) => c.name === "Alimentação")!.id;
    ws.act((l) => l.recordExpense(bank.id, food, "1.00", "2026-01-09" as IsoDate, "Sem rede"));
    await until(() => (details.at(-1)?.pending ?? 0) > 0);
    expect(details.at(-1)).toMatchObject({ storageAtRisk: true });
    server.offline = false;
    await a.closeProject();
  }, 30_000);

  it("the shell warns while there are changes not yet sent", async () => {
    const services = createFakeServices({ seed: true });
    const session = new SessionStore();
    const account = await services.signIn(DEMO.email, DEMO.password);
    const open = await services.openProject(services.demoProjectId!, DEMO.projectPassword);
    session.update({ account, open, operatorId: open.members[0]?.id ?? null, storageAtRisk: true, pending: 0 });
    const router = createAppRouter({ session, history: createMemoryHistory({ initialEntries: ["/livro"] }) });
    render(<App router={router} services={services} session={session} preferences={memoryPreferences()} />);
    await screen.findByRole("heading", { level: 1, name: "Livro financeiro" });
    expect(screen.queryByText(/O navegador pode apagar/)).toBeNull();
    act(() => session.update({ pending: 3 }));
    expect(await screen.findByText(storageWarningText(3))).toBeTruthy();
    expect(storageWarningText(3)).toBe(
      "O navegador pode apagar os dados deste aparelho. Há 3 alterações ainda não enviadas; conecte-se para enviá-las.",
    );
    expect(storageWarningText(1)).toContain("Há 1 alteração ainda não enviada;");
    act(() => session.update({ pending: 0 }));
    await waitFor(() => expect(screen.queryByText(/O navegador pode apagar/)).toBeNull());
  });
});
