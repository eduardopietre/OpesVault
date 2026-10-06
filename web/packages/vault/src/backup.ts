/**
 * Backup of a whole project and restoring it (docs/19 §13), over the format of `@opesvault/crypto`
 * (`BackupWriter` / `BackupReader`). Everything happens in the browser: the password never leaves it, the
 * server never sees the file, and nothing is written to disk in plain text (the caller receives sealed
 * chunks and the file read back is decrypted one chunk at a time).
 *
 * The vault does not know the domain: which records refer to attachments is told by `blobRefsOf` (the app
 * says "a `document` record points to blob `payload.blob_id` whose SHA-256 is `payload.sha256`").
 *
 * - `exportBackup`: checks the project password, then writes every record and every referenced attachment.
 * - `verifyBackup`: decrypts the whole file and checks it (chunks, counts, references, hashes) without
 *   touching any project.
 * - `restoreBackup`: verifies first, then creates a NEW project (new key, new recovery key, same password as
 *   the file) and fills it. It never writes into an existing project.
 */
import {
  BackupError,
  BackupReader,
  BackupWriter,
  type BackupItem,
  type Bytes,
  type ByteSource,
  type KdfParams,
  type PlainRecord,
  type RandomSource,
} from "@opesvault/crypto";
import { BackendError, type SyncBackend } from "./backend.ts";
import type { VaultCache } from "./cache.ts";
import { ProjectVault, VaultError, type ProjectVaultOptions } from "./project_vault.ts";

/** An attachment a record points to: its blob id and, when the record says so, the SHA-256 of its bytes. */
export interface BlobRef {
  readonly id: string;
  readonly sha256?: string | undefined;
}

/** Which attachments a record refers to (none for most records). */
export type BlobRefs = (record: PlainRecord) => readonly BlobRef[];

export interface BackupProgress {
  readonly phase: "records" | "documents" | "checking" | "restoring";
  readonly done: number;
  readonly total: number;
}

export interface BackupExportOptions {
  readonly blobRefsOf?: BlobRefs;
  readonly kdf?: KdfParams;
  readonly chunkBytes?: number;
  readonly random?: RandomSource;
  readonly now?: () => Date;
  readonly onProgress?: (progress: BackupProgress) => void;
}

export interface BackupSummary {
  /** ISO instant written in the file. */
  readonly createdAt: string;
  readonly records: number;
  readonly documents: number;
  readonly documentBytes: number;
  /** Attachments that records refer to but that could not be read (not on the server). */
  readonly missing: readonly string[];
  readonly fileBytes: number;
}

/** What a backup is made of: the records, the way to read an attachment, and the project's name. */
export interface BackupContent {
  readonly name: string;
  readonly records: Iterable<PlainRecord>;
  /** The attachment's bytes, or null when it does not exist (a reference that was already dangling). */
  blob(id: string): Promise<Uint8Array | null>;
}

/** Writes a backup of `content`, protected by `password`; the sealed chunks go to `emit` in order. */
export async function writeBackup(
  content: BackupContent,
  password: string,
  emit: (chunk: Bytes) => void | Promise<void>,
  options: BackupExportOptions = {},
): Promise<BackupSummary> {
  const refsOf = options.blobRefsOf ?? (() => []);
  const createdAt = (options.now?.() ?? new Date()).toISOString();
  const records = [...content.records];
  const blobIds = new Set<string>();
  for (const record of records) for (const ref of refsOf(record)) blobIds.add(ref.id);
  const writer = await BackupWriter.create(
    password,
    emit,
    { createdAt, projectName: content.name },
    {
      ...(options.kdf ? { kdf: options.kdf } : {}),
      ...(options.chunkBytes ? { chunkBytes: options.chunkBytes } : {}),
      ...(options.random ? { random: options.random } : {}),
    },
  );
  let done = 0;
  for (const record of records) {
    await writer.writeRecord(record);
    done += 1;
    if (done % 500 === 0) options.onProgress?.({ phase: "records", done, total: records.length });
  }
  options.onProgress?.({ phase: "records", done: records.length, total: records.length });
  const missing: string[] = [];
  let documents = 0;
  let documentBytes = 0;
  for (const id of blobIds) {
    const data = await content.blob(id);
    if (data === null) {
      missing.push(id);
      continue;
    }
    await writer.writeBlob(id, data);
    documents += 1;
    documentBytes += data.length;
    options.onProgress?.({ phase: "documents", done: documents + missing.length, total: blobIds.size });
  }
  await writer.finish(missing);
  return { createdAt, records: records.length, documents, documentBytes, missing, fileBytes: writer.emittedBytes };
}

/**
 * Backs up the open project. Asks for the password again: it is checked against the envelope and is the one
 * that protects the file. An attachment the server does not have becomes `missing`; any other failure to
 * read one (offline, locked) stops the backup, since it would be incomplete for a reason the person can fix.
 */
export async function exportBackup(
  vault: ProjectVault,
  password: string,
  emit: (chunk: Bytes) => void | Promise<void>,
  options: BackupExportOptions = {},
): Promise<BackupSummary> {
  if (!vault.unlocked) throw new VaultError("locked");
  await vault.checkPassword(password);
  return writeBackup(
    {
      name: vault.getSnapshot().name ?? "Projeto",
      records: vault.records.values(),
      blob: async (id) => {
        try {
          return await vault.getBlob(id);
        } catch (error) {
          if (error instanceof BackendError && error.code === "not_found") return null;
          throw error;
        }
      },
    },
    password,
    emit,
    options,
  );
}

export interface BackupReport {
  readonly version: number;
  readonly kdf: KdfParams;
  readonly chunkBytes: number;
  readonly fileBytes: number;
  readonly createdAt: string;
  readonly projectName: string;
  readonly records: number;
  /** Records by kind (the file's own count, for the person to recognise the project). */
  readonly byKind: Readonly<Record<string, number>>;
  readonly documents: number;
  readonly documentBytes: number;
  /** Attachments the backup was made without (they were already missing then). */
  readonly missing: readonly string[];
  /** Attachments a record points to that are neither in the file nor listed as missing. */
  readonly dangling: readonly string[];
  /** Attachments whose bytes do not match the SHA-256 their record states. */
  readonly hashMismatches: readonly string[];
  /** Attachments no record points to. */
  readonly orphans: number;
}

export interface ScanHandlers {
  record?(record: PlainRecord): Promise<void> | void;
  blob?(id: string, data: Bytes): Promise<void> | void;
}

async function sha256Hex(data: Bytes): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", data));
  let out = "";
  for (const byte of digest) out += byte.toString(16).padStart(2, "0");
  return out;
}

async function scan(
  reader: BackupReader,
  source: ByteSource,
  refsOf: BlobRefs,
  handlers: ScanHandlers,
  onProgress?: (progress: BackupProgress) => void,
): Promise<BackupReport> {
  let meta: Extract<BackupItem, { type: "meta" }>["meta"] | null = null;
  let totals: Extract<BackupItem, { type: "end" }>["totals"] | null = null;
  const byKind: Record<string, number> = {};
  const wanted = new Map<string, string | undefined>();
  const seen = new Set<string>();
  const mismatches: string[] = [];
  let records = 0;
  let orphans = 0;
  let documentBytes = 0;
  for (let item = await reader.next(); item !== null; item = await reader.next()) {
    switch (item.type) {
      case "meta":
        meta = item.meta;
        break;
      case "record":
        records += 1;
        byKind[item.record.kind] = (byKind[item.record.kind] ?? 0) + 1;
        for (const ref of refsOf(item.record)) wanted.set(ref.id, ref.sha256 ?? wanted.get(ref.id));
        await handlers.record?.(item.record);
        if (records % 1000 === 0) onProgress?.({ phase: "checking", done: records, total: 0 });
        break;
      case "blob": {
        if (seen.has(item.id)) throw new BackupError("invalid_content");
        seen.add(item.id);
        documentBytes += item.data.length;
        if (!wanted.has(item.id)) orphans += 1;
        const expected = wanted.get(item.id);
        if (expected !== undefined && (await sha256Hex(item.data)) !== expected.toLowerCase()) mismatches.push(item.id);
        await handlers.blob?.(item.id, item.data);
        break;
      }
      case "end":
        totals = item.totals;
        break;
    }
  }
  if (meta === null || totals === null) throw new BackupError("invalid_content");
  const missing = totals.missing;
  const dangling = [...wanted.keys()].filter((id) => !seen.has(id) && !missing.includes(id));
  return {
    version: reader.info.version,
    kdf: reader.info.kdf,
    chunkBytes: reader.info.chunkBytes,
    fileBytes: source.size,
    createdAt: meta.createdAt,
    projectName: meta.projectName,
    records,
    byKind,
    documents: seen.size,
    documentBytes,
    missing,
    dangling,
    hashMismatches: mismatches,
    orphans,
  };
}

export interface BackupVerifyOptions {
  readonly blobRefsOf?: BlobRefs;
  readonly onProgress?: (progress: BackupProgress) => void;
}

/**
 * Decrypts and checks the whole file without restoring it. Throws `BackupError` (wrong password, altered,
 * cut, other version…); a file that is intact but whose records point to missing attachments is reported in
 * `dangling` / `missing` / `hashMismatches`, not thrown.
 */
export async function verifyBackup(
  source: ByteSource,
  password: string,
  options: BackupVerifyOptions = {},
): Promise<BackupReport> {
  const reader = await BackupReader.open(source, password);
  return scan(reader, source, options.blobRefsOf ?? (() => []), {}, options.onProgress);
}

/** Reads the whole file, handing every record and attachment to `handlers`, and returns the report. */
export async function readBackup(
  source: ByteSource,
  password: string,
  options: BackupVerifyOptions,
  handlers: ScanHandlers,
): Promise<BackupReport> {
  const reader = await BackupReader.open(source, password);
  return scan(reader, source, options.blobRefsOf ?? (() => []), handlers, options.onProgress);
}

export interface BackupRestoreOptions extends BackupVerifyOptions {
  readonly source: ByteSource;
  /** The password of the file; the restored project uses it too (change it in Configurações if wanted). */
  readonly password: string;
  readonly backend: SyncBackend;
  readonly cache: VaultCache;
  /** Name of the new project; the file's own name followed by "(restaurado)" by default. */
  readonly name?: string;
  /** Tests only: cheaper key derivation for the new project's envelope. */
  readonly kdf?: KdfParams;
  readonly random?: RandomSource;
  readonly vaultOptions?: Partial<Omit<ProjectVaultOptions, "backend" | "cache" | "projectId">>;
}

export interface BackupRestored {
  readonly projectId: string;
  readonly name: string;
  /** For the new project; shown once. */
  readonly recoveryKey: string;
  readonly report: BackupReport;
}

const BATCH = 250;

/**
 * Restores into a NEW project. The file is checked completely first, so a bad file creates nothing; if
 * something fails after the project exists on the server, it is deleted again. The returned project is
 * locked (its changes are on the server): open it with the password like any other.
 */
export async function restoreBackup(options: BackupRestoreOptions): Promise<BackupRestored> {
  const refsOf = options.blobRefsOf ?? (() => []);
  const reader = await BackupReader.open(options.source, options.password);
  const report = await scan(reader, options.source, refsOf, {}, options.onProgress);
  reader.rewind();
  const name = options.name?.trim() || `${report.projectName} (restaurado)`;
  const { vault, recoveryKey } = await ProjectVault.create({
    backend: options.backend,
    cache: options.cache,
    name,
    password: options.password,
    ...(options.kdf ? { kdf: options.kdf } : {}),
    ...(options.random ? { random: options.random } : {}),
    ...options.vaultOptions,
  });
  try {
    let batch: PlainRecord[] = [];
    let restored = 0;
    const flush = async () => {
      if (batch.length === 0) return;
      await vault.stage(batch);
      restored += batch.length;
      batch = [];
      options.onProgress?.({ phase: "restoring", done: restored, total: report.records });
    };
    await scan(reader, options.source, refsOf, {
      record: async (record) => {
        batch.push(record);
        if (batch.length >= BATCH) await flush();
      },
      blob: async (id, data) => {
        await flush();
        await vault.putBlob(data, id);
      },
    });
    await flush();
    for (let round = 0; round < 20 && vault.getSnapshot().pending > 0; round++) await vault.syncNow();
    const snapshot = vault.getSnapshot();
    if (snapshot.pending > 0 || snapshot.conflicts.length > 0) throw new VaultError("offline");
    await vault.lock();
  } catch (error) {
    await vault.lock().catch(() => undefined);
    await options.backend.deleteProject(vault.projectId).catch(() => undefined);
    await options.cache.forgetProject(vault.projectId).catch(() => undefined);
    throw error;
  }
  return { projectId: vault.projectId, name, recoveryKey, report };
}
