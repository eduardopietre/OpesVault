/**
 * In-memory AppServices for development, the catalog and tests. Nothing leaves the tab and nothing is
 * encrypted: it only imitates the answers of the real services so every screen can be walked through.
 */
import { dom, demoSession, Ledger, newId, session as sessions, today } from "@opesvault/domain";
import { applyDemoExtras } from "../data/demo_extra.ts";
import {
  CryptoError,
  blobSource,
  formatRecoveryKey,
  generateRecoveryKey,
  parseRecoveryKey,
  toHex,
  type KdfParams,
} from "@opesvault/crypto";
import { serviceError } from "./real.ts";
import { readBackup, watchActivity, writeBackup, type BackupReport } from "@opesvault/vault";
import { backupFileName, checkOf, documentBlobRefs } from "../data/backup.ts";
import { browserExtractor } from "../data/pdf.ts";
import { DOCUMENT_KIND, Workspace } from "../data/workspace.ts";
import {
  ServiceError,
  type Account,
  type AppServices,
  type CreatedProject,
  type Member,
  type OpenProject,
  type ProjectSummary,
} from "./types.ts";

interface StoredAccount extends Account {
  password: string;
  projects: string[];
}

interface StoredProject extends ProjectSummary {
  password: string;
  /** The recovery key's 20 bytes, as hex. */
  recovery: string;
  attention: Record<string, number>;
  /** Built on first open (the demo imports a PDF, which takes a moment). */
  workspace: Workspace | null;
  build: () => Promise<Workspace>;
}

export const DEMO = {
  email: "demo@opesvault.app",
  password: "senha-de-demonstracao",
  projectName: "Casa",
  projectPassword: "senha-do-projeto",
  /** The demonstration project's recovery key (a made-up one, with a valid check group). */
  recoveryKey: formatRecoveryKey(Uint8Array.from({ length: 20 }, (_, i) => i + 1)),
} as const;

export interface FakeOptions {
  /** Simulated latency in ms (0 in tests). */
  latency?: number;
  /** Starts with the demo account and its project. */
  seed?: boolean;
  /** Source of randomness for ids and recovery keys (tests pass a fixed one). */
  random?: () => number;
  now?: () => Date;
  /** Argon2id parameters of the backup files (tests use lighter ones than the real 64 MiB). */
  kdf?: KdfParams;
}

/** A new project's ledger with the account's first name as its first member. */
function firstLedger(projectName: string, accountName: string): Ledger {
  const ledger = Ledger.new(projectName);
  const first = accountName.trim().split(/\s+/)[0];
  if (first) ledger.addMember(first);
  ledger.markClean(ledger.changeCount);
  return ledger;
}

/** The domain-neutral failure of a backup, in the words of the real services. */
function rethrowBackup(error: unknown): never {
  throw serviceError(error);
}

function delay(ms: number) {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}

/** Wrong or mistyped recovery key, as the real services say it. */
const badRecoveryKey = () =>
  new ServiceError("bad-recovery-key", "Chave de recuperação incorreta. Confira os grupos digitados.");
const badPassword = () => new ServiceError("bad-password", "Senha do projeto incorreta.");

export function createFakeServices(options: FakeOptions = {}): AppServices & { readonly demoProjectId: string | null } {
  const latency = options.latency ?? 0;
  const random = options.random ?? Math.random;
  const now = options.now ?? (() => new Date());
  const accounts = new Map<string, StoredAccount>();
  const projects = new Map<string, StoredProject>();
  let current: StoredAccount | null = null;
  let open: StoredProject | null = null;
  let locked: StoredProject | null = null;
  let sequence = 0;
  const syncListeners = new Set<(status: "synced" | "locked") => void>();
  let idleMs: number | null = null;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  const randomBytes = (length: number) => Uint8Array.from({ length }, () => Math.floor(random() * 256));
  const id = (prefix: string) => `${prefix}-${(++sequence).toString(36)}${Math.floor(random() * 1e6).toString(36)}`;

  const summary = (project: StoredProject): ProjectSummary => ({
    id: project.id,
    name: project.name,
    updatedAt: project.updatedAt,
    members: project.workspace ? membersOf(project).length : project.members,
  });
  const membersOf = (project: StoredProject): Member[] =>
    project.workspace
      ? [...project.workspace.ledger.members.values()].filter((m) => m.active).map((m) => ({ id: m.id, name: m.name }))
      : [];
  const ensure = async (project: StoredProject): Promise<Workspace> => (project.workspace ??= await project.build());
  const opened = (project: StoredProject, workspace: Workspace): OpenProject => ({
    project: summary(project),
    workspace,
    members: membersOf(project),
    attention: { ...project.attention },
    readOnly: false,
  });
  const requireAccount = () => {
    if (!current) throw new ServiceError("signed-out", "Entre na sua conta para continuar.");
    return current;
  };

  const requireOpen = (): StoredProject => {
    if (!open) throw new ServiceError("not-open", "Abra um projeto para fazer isso.");
    return open;
  };

  /** Locks the open project (by the idle time or by the lock button): same effect for the session. */
  const lockOpen = () => {
    if (open) locked = open;
    open = null;
    if (idleTimer !== null) clearTimeout(idleTimer);
    idleTimer = null;
    for (const listener of syncListeners) listener("locked");
  };
  const armIdle = () => {
    if (idleTimer !== null) clearTimeout(idleTimer);
    idleTimer = null;
    if (open && idleMs !== null) idleTimer = setTimeout(lockOpen, idleMs);
  };
  if (typeof window !== "undefined") watchActivity(window, armIdle);

  const docRecords = (workspace: Workspace) =>
    workspace.session.documents.map((d) => ({
      kind: DOCUMENT_KIND,
      id: d.meta.id,
      payload: { ...d.meta, blob_id: d.meta.id.replaceAll("-", "") },
    }));

  let demoProjectId: string | null = null;
  if (options.seed) {
    const account: StoredAccount = {
      id: id("acc"),
      name: "Ana Souza",
      email: DEMO.email,
      password: DEMO.password,
      projects: [],
    };
    const project: StoredProject = {
      id: id("prj"),
      name: DEMO.projectName,
      password: DEMO.projectPassword,
      recovery: toHex(parseRecoveryKey(DEMO.recoveryKey)),
      updatedAt: now().toISOString(),
      members: 2,
      attention: { "visao-geral": 3, importar: 2 },
      workspace: null,
      build: async () => {
        const session = await demoSession({ extractor: browserExtractor() });
        // More paths than the desktop's demonstration has (docs/18 W12); the domain's demo stays as it is.
        applyDemoExtras(session, today());
        // The demonstration has the local AI chosen, so its screens can be walked through (the requests
        // go to 127.0.0.1 only when someone asks; tests and the e2e build answer them themselves).
        dom.settings.updateSettings(session.ledger, { ai_enabled: true, ai_model: "gemma4:12b" });
        return new Workspace(session);
      },
    };
    account.projects.push(project.id);
    accounts.set(account.email, account);
    projects.set(project.id, project);
    demoProjectId = project.id;
  }

  return {
    demoProjectId,
    async signIn(email, password) {
      await delay(latency);
      const account = accounts.get(email.trim().toLowerCase());
      if (!account || account.password !== password) {
        throw new ServiceError("bad-credentials", "E-mail ou senha não conferem.");
      }
      current = account;
      return { id: account.id, name: account.name, email: account.email };
    },
    async signUp({ name, email, password }) {
      await delay(latency);
      const key = email.trim().toLowerCase();
      if (accounts.has(key))
        throw new ServiceError("email-taken", "Já existe uma conta com este e-mail. Entre com ela.");
      const account: StoredAccount = { id: id("acc"), name: name.trim(), email: key, password, projects: [] };
      accounts.set(key, account);
      current = account;
      return { id: account.id, name: account.name, email: account.email };
    },
    async signOut() {
      await delay(latency);
      current = null;
      open = null;
      locked = null;
    },
    async listProjects() {
      await delay(latency);
      const account = requireAccount();
      return account.projects
        .map((pid) => projects.get(pid))
        .filter((p): p is StoredProject => Boolean(p))
        .map(summary);
    },
    async createProject({ name, password }): Promise<CreatedProject> {
      await delay(latency);
      const account = requireAccount();
      const recovery = generateRecoveryKey(randomBytes);
      const project: StoredProject = {
        id: id("prj"),
        name: name.trim(),
        password,
        recovery: toHex(recovery.bytes),
        updatedAt: now().toISOString(),
        members: 1,
        attention: {},
        workspace: new Workspace(new sessions.Session(newId(), firstLedger(name.trim(), account.name))),
        build: () => Promise.reject(new Error("built at creation")),
      };
      projects.set(project.id, project);
      account.projects.push(project.id);
      return { project: summary(project), recoveryKey: recovery.text };
    },
    async openProject(projectId, password) {
      await delay(latency);
      const account = requireAccount();
      const project = projects.get(projectId);
      if (!project || !account.projects.includes(projectId)) {
        throw new ServiceError("not-found", "Este projeto não está mais disponível para a sua conta.");
      }
      // A wrong password never opens an empty project (docs/18 W1).
      if (project.password !== password) throw badPassword();
      const workspace = await ensure(project);
      open = project;
      locked = null;
      armIdle();
      return opened(project, workspace);
    },
    async lock() {
      await delay(latency);
      if (open) locked = open;
      open = null;
      if (idleTimer !== null) clearTimeout(idleTimer);
      idleTimer = null;
    },
    async unlock(password) {
      await delay(latency);
      if (!locked) throw new ServiceError("not-locked", "Nenhum projeto bloqueado.");
      if (locked.password !== password) throw badPassword();
      open = locked;
      locked = null;
      armIdle();
      return opened(open, await ensure(open));
    },
    async closeProject() {
      await delay(latency);
      open = null;
      locked = null;
    },
    watchSync(listener) {
      listener("synced");
      syncListeners.add(listener);
      return () => syncListeners.delete(listener);
    },

    async renameProject(name) {
      await delay(latency);
      const project = requireOpen();
      const trimmed = name.trim();
      if (!trimmed) throw new ServiceError("empty-name", "Dê um nome ao projeto.");
      project.name = trimmed;
      return summary(project);
    },
    async changePassword(currentPassword, newPassword) {
      await delay(latency);
      const project = requireOpen();
      if (!newPassword) throw new ServiceError("empty-password", "Digite a senha.");
      if (project.password !== currentPassword) throw badPassword();
      project.password = newPassword;
    },
    async regenerateRecoveryKey(password) {
      await delay(latency);
      const project = requireOpen();
      if (project.password !== password) throw badPassword();
      const fresh = generateRecoveryKey(randomBytes);
      project.recovery = toHex(fresh.bytes);
      return fresh.text;
    },
    async recoverProject(projectId, recoveryKey, newPassword) {
      await delay(latency);
      const account = requireAccount();
      const project = projects.get(projectId);
      if (!project || !account.projects.includes(projectId)) {
        throw new ServiceError("not-found", "Este projeto não está mais disponível para a sua conta.");
      }
      if (!newPassword) throw new ServiceError("empty-password", "Digite a senha.");
      let typed: string;
      try {
        typed = toHex(parseRecoveryKey(recoveryKey));
      } catch (error) {
        if (error instanceof CryptoError) throw badRecoveryKey();
        throw error;
      }
      if (typed !== project.recovery) throw badRecoveryKey();
      project.password = newPassword;
      const workspace = await ensure(project);
      open = project;
      locked = null;
      armIdle();
      return opened(project, workspace);
    },
    setIdleLock(minutes) {
      idleMs = minutes > 0 ? minutes * 60_000 : null;
      armIdle();
    },
    async exportBackup(password, onProgress) {
      await delay(latency);
      const project = requireOpen();
      if (project.password !== password) throw badPassword();
      const workspace = await ensure(project);
      const bytes = new Map(workspace.session.documents.map((d) => [d.meta.id.replaceAll("-", ""), d.data]));
      const parts: Uint8Array<ArrayBuffer>[] = [];
      const result = await writeBackup(
        {
          name: project.name,
          records: [
            ...workspace.ledger.toRecords().map((r) => ({ kind: r.kind, id: r.id, payload: r.payload })),
            ...docRecords(workspace),
          ],
          blob: (blobId) => Promise.resolve(bytes.get(blobId) ?? null),
        },
        password,
        (chunk) => void parts.push(chunk),
        {
          blobRefsOf: documentBlobRefs,
          now,
          ...(options.kdf ? { kdf: options.kdf } : {}),
          ...(onProgress ? { onProgress } : {}),
        },
      );
      return {
        blob: new Blob(parts, { type: "application/octet-stream" }),
        fileName: backupFileName(new Date(result.createdAt)),
        createdAt: result.createdAt,
        records: result.records,
        documents: result.documents,
        documentBytes: result.documentBytes,
        missing: result.missing.length,
      };
    },
    async verifyBackup(file, password, onProgress) {
      await delay(latency);
      const report = await readBackup(
        blobSource(file),
        password,
        { blobRefsOf: documentBlobRefs, ...(onProgress ? { onProgress } : {}) },
        {},
      ).catch(rethrowBackup);
      return checkOf(report);
    },
    async restoreBackup(file, password, name, onProgress) {
      await delay(latency);
      const account = requireAccount();
      const ledgerRecords: { id: string; kind: string; payload: Record<string, unknown> }[] = [];
      const docMeta = new Map<string, { id: string; sha256: string; original_name: string; size: number }>();
      const bytes = new Map<string, Uint8Array>();
      const report: BackupReport = await readBackup(
        blobSource(file),
        password,
        { blobRefsOf: documentBlobRefs, ...(onProgress ? { onProgress } : {}) },
        {
          record: (record) => {
            if (record.kind === DOCUMENT_KIND) {
              const d = record.payload as { id: string; sha256: string; original_name: string; size: number };
              docMeta.set(record.id, { id: d.id, sha256: d.sha256, original_name: d.original_name, size: d.size });
            } else {
              ledgerRecords.push({
                id: record.id,
                kind: record.kind,
                payload: record.payload as Record<string, unknown>,
              });
            }
          },
          blob: (blobId, data) => void bytes.set(blobId, data),
        },
      ).catch(rethrowBackup);
      const documents = [...docMeta.values()].map((meta) => ({
        meta,
        data: bytes.get(meta.id.replaceAll("-", "")) ?? new Uint8Array(0),
      }));
      const projectName = name.trim() || `${report.projectName} (restaurado)`;
      const recovery = generateRecoveryKey(randomBytes);
      const workspace = new Workspace(sessions.Session.fromRecords(newId(), ledgerRecords, documents));
      const project: StoredProject = {
        id: id("prj"),
        name: projectName,
        password,
        recovery: toHex(recovery.bytes),
        updatedAt: now().toISOString(),
        members: [...workspace.ledger.members.values()].filter((m) => m.active).length,
        attention: {},
        workspace,
        build: () => Promise.reject(new Error("built at restore")),
      };
      projects.set(project.id, project);
      account.projects.push(project.id);
      return { project: summary(project), recoveryKey: recovery.text, check: checkOf(report) };
    },
    async pendingChanges() {
      return 0;
    },
    async forgetDevice() {
      await delay(latency);
      current = null;
      open = null;
      locked = null;
      if (idleTimer !== null) clearTimeout(idleTimer);
      idleTimer = null;
    },
  };
}
