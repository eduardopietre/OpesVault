/**
 * AppServices over the self-hosted server and the encrypted vault (docs/18 §3, docs/19).
 *
 * Passwords are used here and dropped: the account password becomes the login secret, the project
 * password opens the envelope inside the vault. The project's records are decrypted in the vault and
 * become the domain Ledger in a Workspace; every change goes back to the vault encrypted.
 */
import { HttpBackend } from "@opesvault/backend-http";
import { formatDateBr, type IsoDate } from "@opesvault/domain";
import { BackupError, blobSource, type KdfParams } from "@opesvault/crypto";
import {
  BackendError,
  ProjectVault,
  exportBackup as vaultExportBackup,
  restoreBackup as vaultRestoreBackup,
  verifyBackup as vaultVerifyBackup,
  watchActivity,
  type ProjectVaultOptions,
  type RecordOpener,
  type SyncBackend,
  VaultCache,
  VaultError,
  requestPersistentStorage,
  signIn as vaultSignIn,
  signUp as vaultSignUp,
} from "@opesvault/vault";
import { backupFileName, checkOf, documentBlobRefs } from "../data/backup.ts";
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
  /** Opens the records of a big project on Web Workers (data/open_pool.ts); without it, on this thread. */
  readonly recordOpener?: RecordOpener | undefined;
}

const BACKUP_MESSAGES: Record<BackupError["code"], string> = {
  not_a_backup: "Este arquivo não é um backup do OpesVault.",
  unsupported_version:
    "Este backup foi feito por uma versão mais nova do aplicativo. Atualize o aplicativo e tente de novo.",
  invalid_params: "O cabeçalho do backup pede valores que este aplicativo não aceita.",
  wrong_password:
    "Senha incorreta para este arquivo. É a senha que o projeto tinha quando o backup foi feito, ou o cabeçalho foi alterado.",
  empty_password: "Digite a senha.",
  corrupted: "O arquivo está danificado, incompleto ou foi alterado. Nada dele foi usado.",
  invalid_content: "O conteúdo do arquivo não confere com o formato de backup. Nada dele foi usado.",
};

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
      case "conflict":
        return new ServiceError(
          "conflict",
          "A senha ou a chave de recuperação foi trocada em outro aparelho agora há pouco. Tente de novo.",
        );
      case "read_only":
      case "no_lease":
        return new ServiceError("read-only", "Outra aba ou aparelho está editando este projeto.");
      case "offline":
        return new ServiceError("offline", "Sem conexão com o servidor. Tente de novo quando a conexão voltar.");
      default:
        return new ServiceError(error.code, "Não foi possível concluir. Tente de novo.");
    }
  }
  if (error instanceof BackupError) return new ServiceError(`backup-${error.code}`, BACKUP_MESSAGES[error.code]);
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
  let idleMs: number | null = options.idleLockMs === undefined ? 15 * 60_000 : options.idleLockMs;
  let unwatchActivity: (() => void) | null = null;

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

  const requireOpen = (): { vault: ProjectVault; summary: ProjectSummary } => {
    if (!vault || !vault.unlocked || !summary) {
      throw new ServiceError("not-open", "Abra um projeto para fazer isso.");
    }
    return { vault, summary };
  };

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
          ...(options.recordOpener ? { recordOpener: options.recordOpener } : {}),
          idleLockMs: idleMs,
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
    unwatchActivity?.();
    unwatchActivity = typeof window === "undefined" ? null : watchActivity(window, () => v.touch());
    vault = v;
    workspace = ws;
    summary = { ...projectSummary, name };
    report();
    return openedOf(ws, summary);
  };

  const detach = async (close: boolean) => {
    unsubscribeVault?.();
    unsubscribeVault = null;
    unwatchActivity?.();
    unwatchActivity = null;
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
    async restoreAccount() {
      try {
        const session = await backend.currentSession();
        if (session === null) return null;
        account = { id: session.accountId, name: nameFromEmail(session.email), email: session.email };
        return account;
      } catch {
        // Offline or the server is away: the person signs in when it is back.
        return null;
      }
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
          idleLockMs: idleMs,
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

    async renameProject(name) {
      return guard(async () => {
        const open = requireOpen();
        const trimmed = name.trim();
        if (!trimmed) throw new ServiceError("empty-name", "Dê um nome ao projeto.");
        await open.vault.rename(trimmed);
        summary = { ...open.summary, name: trimmed };
        return summary;
      });
    },
    async changePassword(currentPassword, newPassword) {
      return guard(async () => requireOpen().vault.changePassword(currentPassword, newPassword));
    },
    async regenerateRecoveryKey(password) {
      return guard(async () => requireOpen().vault.regenerateRecoveryKey(password));
    },
    async recoverProject(projectId, recoveryKey, newPassword) {
      return guard(async () => {
        await detach(true);
        const v = await makeVault(projectId);
        await v.unlockWithRecovery(recoveryKey, newPassword);
        const listed = (await backend.listProjects()).find((p) => p.projectId === projectId);
        const members = await backend.listMembers(projectId).catch(() => []);
        const base = listed
          ? summaryOf(listed, null, members.length)
          : { id: projectId, name: "Projeto", updatedAt: new Date().toISOString(), members: members.length };
        return attach(v, base);
      });
    },
    setIdleLock(minutes) {
      idleMs = minutes > 0 ? minutes * 60_000 : null;
      vault?.setIdleLock(idleMs);
    },
    async exportBackup(password, onProgress) {
      return guard(async () => {
        const { vault: v } = requireOpen();
        const parts: Uint8Array<ArrayBuffer>[] = [];
        const result = await vaultExportBackup(v, password, (chunk) => void parts.push(chunk), {
          blobRefsOf: documentBlobRefs,
          ...(options.kdf ? { kdf: options.kdf } : {}),
          ...(onProgress ? { onProgress } : {}),
        });
        return {
          blob: new Blob(parts, { type: "application/octet-stream" }),
          fileName: backupFileName(new Date(result.createdAt)),
          createdAt: result.createdAt,
          records: result.records,
          documents: result.documents,
          documentBytes: result.documentBytes,
          missing: result.missing.length,
        };
      });
    },
    async verifyBackup(file, password, onProgress) {
      return guard(async () =>
        checkOf(
          await vaultVerifyBackup(blobSource(file), password, {
            blobRefsOf: documentBlobRefs,
            ...(onProgress ? { onProgress } : {}),
          }),
        ),
      );
    },
    async restoreBackup(file, password, name, onProgress) {
      return guard(async () => {
        const restored = await vaultRestoreBackup({
          source: blobSource(file),
          password,
          backend,
          cache: await theCache(),
          ...(name.trim() ? { name } : {}),
          blobRefsOf: documentBlobRefs,
          ...(options.kdf ? { kdf: options.kdf } : {}),
          ...(onProgress ? { onProgress } : {}),
          vaultOptions: {
            ...(options.holder ? { holder: options.holder } : {}),
            ...options.vaultOptions,
          },
        });
        const project: ProjectSummary = {
          id: restored.projectId,
          name: restored.name,
          updatedAt: new Date().toISOString(),
          members: 1,
        };
        return { project, recoveryKey: restored.recoveryKey, check: checkOf(restored.report) };
      });
    },
    async pendingChanges() {
      if (!vault || !vault.unlocked) return 0;
      await vault.syncNow().catch(() => undefined);
      return vault.getSnapshot().pending;
    },
    async forgetDevice() {
      return guard(async () => {
        await detach(true);
        await (await theCache()).forgetAll();
        await backend.signOut().catch(() => undefined);
        account = null;
      });
    },
  };
}
