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

/** Progress of a backup operation (records, documents, restoring); `total` is 0 when not known. */
export interface BackupProgress {
  phase: "records" | "documents" | "checking" | "restoring";
  done: number;
  total: number;
}

export interface BackupFile {
  /** The sealed file: nothing in it is readable without the password. */
  blob: Blob;
  /** Neutral name, without the project's name. */
  fileName: string;
  /** ISO instant written in the file. */
  createdAt: string;
  records: number;
  documents: number;
  documentBytes: number;
  /** Documents the records cite but the server did not have. */
  missing: number;
}

/** What a backup file holds, after decrypting and checking all of it. */
export interface BackupCheck {
  /** Format version of the file. */
  version: number;
  createdAt: string;
  projectName: string;
  fileBytes: number;
  records: number;
  /** Records by kind. */
  byKind: Readonly<Record<string, number>>;
  documents: number;
  documentBytes: number;
  /** Documents the backup was made without. */
  missing: number;
  /** Records pointing to documents that are not in the file. */
  dangling: number;
  /** Documents whose bytes do not match their record. */
  hashMismatches: number;
  orphans: number;
  /** Argon2id parameters the file asks for (memory in KiB). */
  kdf: { memoryKiB: number; iterations: number; parallelism: number };
}

export interface RestoredProject {
  /** The new project (a different one from any existing project). */
  project: ProjectSummary;
  /** Of the new project; shown once. */
  recoveryKey: string;
  check: BackupCheck;
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

  // ── Configurações (docs/18 W11) ──────────────────────────────────────────────────────────────
  /** Renames the open project (the name is sealed in the browser; the server never reads it). */
  renameProject(name: string): Promise<ProjectSummary>;
  /** Needs the current password; every member uses the new one from then on. */
  changePassword(currentPassword: string, newPassword: string): Promise<void>;
  /** Needs the password; returns the new key, to show once. The previous key stops working. */
  regenerateRecoveryKey(password: string): Promise<string>;
  /** Opens a project with its recovery key and sets a new password (from the projects screen). */
  recoverProject(projectId: string, recoveryKey: string, newPassword: string): Promise<OpenProject>;
  /** Idle lock of this device, in minutes: applies at once to the open project and to the next ones. */
  setIdleLock(minutes: number): void;
  /** Backup of the whole open project, protected by the project's password (asked again). */
  exportBackup(password: string, onProgress?: (progress: BackupProgress) => void): Promise<BackupFile>;
  /** Decrypts and checks a backup file without restoring it. */
  verifyBackup(file: Blob, password: string, onProgress?: (progress: BackupProgress) => void): Promise<BackupCheck>;
  /** Restores a backup as a NEW project (never over an existing one), with the file's password. */
  restoreBackup(
    file: Blob,
    password: string,
    name: string,
    onProgress?: (progress: BackupProgress) => void,
  ): Promise<RestoredProject>;
  /** Tries to send what is waiting and says how many changes still are (they are lost if this device is forgotten). */
  pendingChanges(): Promise<number>;
  /** Locks, forgets the local copy (encrypted data, edit queue) of every project and ends the session. */
  forgetDevice(): Promise<void>;
}
