/**
 * In-memory AppServices for development, the catalog and tests. Nothing leaves the tab and nothing is
 * encrypted: it only imitates the answers of the real services so every screen can be walked through.
 */
import { Ledger } from "@opesvault/domain";
import { demoLedger } from "../data/demo.ts";
import { Workspace } from "../data/workspace.ts";
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
  attention: Record<string, number>;
  workspace: Workspace;
}

export const DEMO = {
  email: "demo@opesvault.app",
  password: "senha-de-demonstracao",
  projectName: "Casa",
  projectPassword: "senha-do-projeto",
} as const;

export interface FakeOptions {
  /** Simulated latency in ms (0 in tests). */
  latency?: number;
  /** Starts with the demo account and its project. */
  seed?: boolean;
  /** Source of randomness for ids and recovery keys (tests pass a fixed one). */
  random?: () => number;
  now?: () => Date;
}

/** A new project's ledger with the account's first name as its first member. */
function firstLedger(projectName: string, accountName: string): Ledger {
  const ledger = Ledger.new(projectName);
  const first = accountName.trim().split(/\s+/)[0];
  if (first) ledger.addMember(first);
  ledger.markClean(ledger.changeCount);
  return ledger;
}

function delay(ms: number) {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

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
  const id = (prefix: string) => `${prefix}-${(++sequence).toString(36)}${Math.floor(random() * 1e6).toString(36)}`;

  const summary = (project: StoredProject): ProjectSummary => ({
    id: project.id,
    name: project.name,
    updatedAt: project.updatedAt,
    members: membersOf(project).length,
  });
  const membersOf = (project: StoredProject): Member[] =>
    [...project.workspace.ledger.members.values()].filter((m) => m.active).map((m) => ({ id: m.id, name: m.name }));
  const opened = (project: StoredProject): OpenProject => ({
    project: summary(project),
    workspace: project.workspace,
    members: membersOf(project),
    attention: { ...project.attention },
    readOnly: false,
  });
  const requireAccount = () => {
    if (!current) throw new ServiceError("signed-out", "Entre na sua conta para continuar.");
    return current;
  };

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
      updatedAt: now().toISOString(),
      members: 2,
      attention: { "visao-geral": 3, importar: 2 },
      workspace: new Workspace(demoLedger(DEMO.projectName)),
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
      const project: StoredProject = {
        id: id("prj"),
        name: name.trim(),
        password,
        updatedAt: now().toISOString(),
        members: 1,
        attention: {},
        workspace: new Workspace(firstLedger(name.trim(), account.name)),
      };
      projects.set(project.id, project);
      account.projects.push(project.id);
      const groups = Array.from({ length: 8 }, () =>
        Array.from({ length: 4 }, () => ALPHABET[Math.floor(random() * ALPHABET.length)]).join(""),
      );
      return { project: summary(project), recoveryKey: groups.join("-") };
    },
    async openProject(projectId, password) {
      await delay(latency);
      const account = requireAccount();
      const project = projects.get(projectId);
      if (!project || !account.projects.includes(projectId)) {
        throw new ServiceError("not-found", "Este projeto não está mais disponível para a sua conta.");
      }
      // A wrong password never opens an empty project (docs/18 W1).
      if (project.password !== password) throw new ServiceError("bad-password", "Senha do projeto incorreta.");
      open = project;
      locked = null;
      return opened(project);
    },
    async lock() {
      await delay(latency);
      if (open) locked = open;
      open = null;
    },
    async unlock(password) {
      await delay(latency);
      if (!locked) throw new ServiceError("not-locked", "Nenhum projeto bloqueado.");
      if (locked.password !== password) throw new ServiceError("bad-password", "Senha do projeto incorreta.");
      open = locked;
      locked = null;
      return opened(open);
    },
    async closeProject() {
      await delay(latency);
      open = null;
      locked = null;
    },
    watchSync(listener) {
      listener("synced");
      return () => undefined;
    },
  };
}
