/**
 * What the screens need from the outside world (accounts, projects, lock), as one small interface. The real
 * implementation comes with the vault and the SyncBackend (W1/W2); the fake one (fake.ts) makes every flow
 * clickable now and backs the tests. Screens never see a key: they hand over a password and get a session.
 */

import type { Workspace } from "../data/workspace.ts";

/** Sync state of the open project, reported by the services (the vault's status). */
export type ProjectSyncStatus = "synced" | "pending" | "syncing" | "offline" | "conflict" | "readOnly" | "locked";

export interface Account {
  id: string;
  name: string;
  email: string;
}

export interface ProjectSummary {
  id: string;
  name: string;
  /** ISO instant of the last change synced. */
  updatedAt: string;
  members: number;
}

export interface Member {
  id: string;
  name: string;
}

export interface OpenProject {
  project: ProjectSummary;
  /** The project's ledger, undo and sync (data/workspace.ts). */
  workspace: Workspace;
  /** Integrantes: the operator chosen in the top bar is recorded in the history. */
  members: readonly Member[];
  /** Counts that need attention, by page id (overview, imports). */
  attention: Readonly<Record<string, number>>;
  /** True when another tab or device holds the edit lease. */
  readOnly: boolean;
}

export interface CreatedProject {
  project: ProjectSummary;
  /** Shown once, in readable groups; never sent to the server in clear (docs/18 §3.2). */
  recoveryKey: string;
}

/** A failure meant for the user: the message is Portuguese and says what to do. */
export class ServiceError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "ServiceError";
    this.code = code;
  }
}

export interface AppServices {
  signIn(email: string, password: string): Promise<Account>;
  signUp(input: { name: string; email: string; password: string }): Promise<Account>;
  signOut(): Promise<void>;
  listProjects(): Promise<ProjectSummary[]>;
  createProject(input: { name: string; password: string }): Promise<CreatedProject>;
  openProject(id: string, password: string): Promise<OpenProject>;
  /** Wipes the key and the open data from the tab. */
  lock(): Promise<void>;
  /** Opens the locked project again with its password. */
  unlock(password: string): Promise<OpenProject>;
  /** Leaves the open project (back to the list). */
  closeProject(): Promise<void>;
  /**
   * Follows the open project's sync state (also an idle lock decided by the vault). Returns the
   * unsubscribe function. The fake services report "synced" once.
   */
  watchSync(listener: (status: ProjectSyncStatus) => void): () => void;
}
