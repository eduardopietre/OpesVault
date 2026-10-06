/**
 * What the app tells the vault about its own records for a backup (docs/19 §13): a `document` record
 * points to an attachment (its blob) whose bytes are checked against the SHA-256 the record states.
 * Also the neutral file name (never the project's name) and the device preference that remembers the
 * last backup made here.
 */
import type { BackupReport, BlobRef } from "@opesvault/vault";
import type { BackupCheck } from "../services/types.ts";
import { DOCUMENT_KIND } from "./workspace.ts";

/** The attachments a record refers to: only `document` records do, through `blob_id`. */
export function documentBlobRefs(record: { readonly kind: string; readonly payload: unknown }): BlobRef[] {
  if (record.kind !== DOCUMENT_KIND) return [];
  const payload = record.payload as { blob_id?: unknown; sha256?: unknown } | null;
  if (typeof payload?.blob_id !== "string") return [];
  return [{ id: payload.blob_id, sha256: typeof payload.sha256 === "string" ? payload.sha256 : undefined }];
}

/** "opesvault-backup-2026-10-06.ovbackup": no name of the project in the file name. */
export function backupFileName(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `opesvault-backup-${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}.ovbackup`;
}

export const BACKUP_FILE_EXTENSION = ".ovbackup";

/** Preference key of the day of the last backup made on this device, per project. */
export function lastBackupKey(projectId: string): string {
  return `backup/ultimo/${projectId}`;
}

/** The report of a backup file as the screens show it (counts, not ids). */
export function checkOf(report: BackupReport): BackupCheck {
  return {
    version: report.version,
    createdAt: report.createdAt,
    projectName: report.projectName,
    fileBytes: report.fileBytes,
    records: report.records,
    byKind: report.byKind,
    documents: report.documents,
    documentBytes: report.documentBytes,
    missing: report.missing.length,
    dangling: report.dangling.length,
    hashMismatches: report.hashMismatches.length,
    orphans: report.orphans,
    kdf: { memoryKiB: report.kdf.memoryKiB, iterations: report.kdf.iterations, parallelism: report.kdf.parallelism },
  };
}
