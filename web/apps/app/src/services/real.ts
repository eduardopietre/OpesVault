/**
 * AppServices over the self-hosted server and the encrypted vault (docs/18 §3, docs/19).
 *
 * Passwords are used here and dropped: the account password becomes the login secret, the project
 * password opens the envelope inside the vault. The project's records are decrypted in the vault and
 * become the domain Ledger in a Workspace; every change goes back to the vault encrypted.
 */
import { HttpBackend } from "@opesvault/backend-http";
import { formatDateBr, type IsoDate } from "@opesvault/domain";
import type { KdfParams } from "@opesvault/crypto";
import {
  BackendError,
  ProjectVault,
  type ProjectVaultOptions,
  type SyncBackend,
  VaultCache,
  VaultError,
  requestPersistentStorage,
  signIn as vaultSignIn,
  signUp as vaultSignUp,
} from "@opesvault/vault";
import { Workspace } from "../data/workspace.ts";
import {
  ServiceError,
  type Account,
  type AppServices,
  type CreatedProject,
  type OpenProject,
  type ProjectSummary,
  type ProjectSyncStatus,
} from "./types.ts";

export interface RealServicesOptions {
  readonly backend?: SyncBackend;
  /** Opens the IndexedDB cache; tests pass one over fake-indexeddb. */
  readonly openCache?: () => Promise<VaultCache>;
  /** This tab's lease label, kept for the life of the tab (preferences). */
  readonly holder?: string;
  /** Lock after this long without activity. */
  readonly idleLockMs?: number | null;
  /** Tests only: cheaper key derivation and vault timing. */
  readonly kdf?: KdfParams;
  readonly vaultOptions?: Partial<Pick<ProjectVaultOptions, "timers" | "pushDelayMs" | "retryMs" | "pollMs">>;
}

/** The user-facing message for a failure of the vault or the server. */
export function serviceError(error: unknown): ServiceError {
  if (error instanceof ServiceError) return error;
  if (error instanceof VaultError) {
    switch (error.code) {
      case "wrong_password":
        return new ServiceError("bad-password", "Senha do projeto incorreta.");
      case "wrong_recovery_key":
      case "invalid_recovery_key":
        return new ServiceError("bad-recovery-key", "Chave de recuperação incorreta. Confira os grupos digitados.");
      case "empty_password":
        return new ServiceError("empty-password", "Digite a senha.");
      case "read_only":
      case "no_lease":
        return new ServiceError("read-only", "Outra aba ou aparelho está editando este projeto.");
      case "offline":
        return new ServiceError("offline", "Sem conexão com o servidor. Tente de novo quando a conexão voltar.");
      default:
        return new ServiceError(error.code, "Não foi possível concluir. Tente de novo.");
    }
  }
  if (error instanceof BackendError) {
    switch (error.code) {
      case "unauthorized":
        return new ServiceError("bad-credentials", "E-mail ou senha não conferem.");
      case "conflict":
        return new ServiceError("email-taken", "Já existe uma conta com este e-mail. Entre com ela.");
      case "not_found":
      case "forbidden":
        return new ServiceError("not-found", "Este projeto não está mais disponível para a sua conta.");
      case "rate_limited":
        return new ServiceError("rate-limited", "Muitas tentativas. Aguarde um pouco e tente de novo.");
      case "offline":
        return new ServiceError("offline", "Sem conexão com o servidor. Tente de novo quando a conexão voltar.");
      default:
        return new ServiceError(error.code, "O servidor não conseguiu concluir. Tente de novo.");
    }
  }
  if (error instanceof TypeError) {
    return new ServiceError("offline", "Sem conexão com o servidor. Tente de novo quando a conexão voltar.");
  }
  return new ServiceError("unexpected", "Algo deu errado. Tente de novo.");
}

async function guard<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    throw serviceError(error);
  }
}

function nameFromEmail(email: string): string {
  const local = email.split("@")[0] ?? email;
  return local.charAt(0).toUpperCase() + local.slice(1);
}

export function createRealServices(options: RealServicesOptions = {}): AppServices {
  const backend = options.backend ?? new HttpBackend();
  const openCache = options.openCache ?? (() => VaultCache.open());
  let cache: Promise<VaultCache> | null = null;
  const theCache = () => (cache ??= openCache());

  let account: Account | null = null;
  let vault: ProjectVault | null = null;
  let workspace: Workspace | null = null;
  let summary: ProjectSummary | null = null;
  let unsubscribeVault: (() => void) | null = null;
  const syncListeners = new Set<(status: ProjectSyncStatus) => void>();

  const report = () => {
    const status: ProjectSyncStatus = vault ? vault.getSnapshot().status : "locked";
    for (const listener of syncListeners) listener(status);
  };

  const summaryOf = (
    p: { projectId: string; createdAt: string; role: string },
    name: string | null,
    members: number,
  ): ProjectSummary => ({
    id: p.projectId,
    name: name ?? `Projeto de ${formatDateBr(p.createdAt.slice(0, 10) as IsoDate)}`,
    updatedAt: p.createdAt,
    members,
  });

  const makeVault = (projectId: string) =>
    theCache().then(
      (c) =>
        new ProjectVault({
          backend,
          cache: c,
          projectId,
          ...(options.holder ? { holder: options.holder } : {}),
          ...(options.kdf ? { kdf: options.kdf } : {}),
          ...options.vaultOptions,
          idleLockMs: options.idleLockMs ?? 15 * 60_000,
        }),
    );

  const openedOf = (ws: Workspace, project: ProjectSummary): OpenProject => ({
    project,
    workspace: ws,
    members: [...ws.ledger.members.values()].filter((m) => m.active).map((m) => ({ id: m.id, name: m.name })),
    attention: {},
    readOnly: ws.readOnly,
  });

  /** Wires an unlocked vault to a workspace and reports its state. */
  const attach = async (v: ProjectVault, projectSummary: ProjectSummary): Promise<OpenProject> => {
    const snapshot = v.getSnapshot();
    const readOnly = snapshot.status === "readOnly";
    const name = snapshot.name ?? projectSummary.name;
    const ws = Workspace.fromRecords(v.records.values(), name, { sink: v, readOnly });
    unsubscribeVault?.();
    const offVault = v.subscribe(() => {
      const s = v.getSnapshot();
      ws.setReadOnly(s.status === "readOnly");
      report();
    });
    const offRemote = v.onRemoteChange(() => ws.reload(v.records.values(), v.getSnapshot().status === "readOnly"));
    unsubscribeVault = () => {
      offVault();
      offRemote();
    };
    vault = v;
    workspace = ws;
    summary = { ...projectSummary, name };
    report();
    return openedOf(ws, summary);
  };

  const detach = async (close: boolean) => {
    unsubscribeVault?.();
    unsubscribeVault = null;
    await workspace?.settled();
    if (vault) await vault.lock();
    workspace = null;
    if (close) {
      vault = null;
      summary = null;
    }
    report();
  };

  return {
    async signIn(email, password) {
      return guard(async () => {
        const session = await vaultSignIn(backend, email, password, options.kdf);
        account = { id: session.accountId, name: nameFromEmail(session.email), email: session.email };
        void requestPersistentStorage();
        return account;
      });
    },
    async signUp({ name, email, password }) {
      return guard(async () => {
        const session = await vaultSignUp(backend, email, password, options.kdf);
        account = { id: session.accountId, name: name.trim() || nameFromEmail(session.email), email: session.email };
        void requestPersistentStorage();
        return account;
      });
    },
    async signOut() {
      await detach(true);
      await guard(() => backend.signOut());
      account = null;
    },
    async listProjects() {
      return guard(async () => {
        const projects = await backend.listProjects();
        return Promise.all(
          projects.map(async (p) => {
            const members = await backend.listMembers(p.projectId).catch(() => []);
            const known = summary?.id === p.projectId ? summary.name : null;
            return summaryOf(p, known, members.length);
          }),
        );
      });
    },
    async createProject({ name, password }): Promise<CreatedProject> {
      return guard(async () => {
        await detach(true);
        const { vault: created, recoveryKey } = await ProjectVault.create({
          backend,
          cache: await theCache(),
          name: name.trim(),
          password,
          ...(options.holder ? { holder: options.holder } : {}),
          ...(options.kdf ? { kdf: options.kdf } : {}),
          ...options.vaultOptions,
          idleLockMs: options.idleLockMs ?? 15 * 60_000,
        });
        const project: ProjectSummary = {
          id: created.projectId,
          name: name.trim(),
          updatedAt: new Date().toISOString(),
          members: 1,
        };
        // The new project stays unlocked: opening it right after needs no second key derivation.
        const opened = await attach(created, project);
        const first = account?.name.trim().split(/\s+/)[0];
        if (first) {
          opened.workspace.act((ledger) => ledger.addMember(first));
          opened.workspace.undoStack.clear();
        }
        return { project, recoveryKey };
      });
    },
    async openProject(projectId, password) {
      return guard(async () => {
        if (vault?.projectId === projectId && vault.unlocked && workspace && summary) {
          return openedOf(workspace, summary);
        }
        await detach(true);
        const v = await makeVault(projectId);
        await v.unlock(password);
        const listed = (await backend.listProjects()).find((p) => p.projectId === projectId);
        const members = await backend.listMembers(projectId).catch(() => []);
        const base = listed
          ? summaryOf(listed, null, members.length)
          : { id: projectId, name: "Projeto", updatedAt: new Date().toISOString(), members: members.length };
        return attach(v, base);
      });
    },
    async lock() {
      await detach(false);
    },
    async unlock(password) {
      return guard(async () => {
        if (!vault || !summary) throw new ServiceError("not-locked", "Nenhum projeto bloqueado.");
        await vault.unlock(password);
        return attach(vault, summary);
      });
    },
    async closeProject() {
      await detach(true);
    },
    watchSync(listener) {
      syncListeners.add(listener);
      return () => syncListeners.delete(listener);
    },
  };
}
