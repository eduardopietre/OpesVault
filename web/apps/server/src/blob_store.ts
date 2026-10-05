/**
 * Encrypted attachments on disk: `<dataDir>/blobs/<projectId>/<blobId>`.
 *
 * Paths are built only from ids that passed `ID_PATTERN` (32 lowercase hex characters), never from
 * other user text. Writes go to a temporary file in the same directory, are flushed, then renamed
 * over the target, so a crash leaves either the old or the new blob.
 */
import { randomBytes } from "node:crypto";
import { mkdir, open, readFile, rename, rm, unlink } from "node:fs/promises";
import { join } from "node:path";
import { ID_PATTERN } from "@opesvault/vault/backend";

function safe(id: string): string {
  if (!ID_PATTERN.test(id)) throw new Error("unsafe id");
  return id;
}

export class BlobStore {
  readonly #root: string;

  constructor(dataDir: string) {
    this.#root = join(dataDir, "blobs");
  }

  #dir(projectId: string): string {
    return join(this.#root, safe(projectId));
  }

  async put(projectId: string, blobId: string, data: Uint8Array): Promise<void> {
    const dir = this.#dir(projectId);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const target = join(dir, safe(blobId));
    const temp = join(dir, `.${safe(blobId)}.${randomBytes(6).toString("hex")}.tmp`);
    const handle = await open(temp, "wx", 0o600);
    try {
      await handle.writeFile(data);
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await rename(temp, target);
    } catch (error) {
      await unlink(temp).catch(() => undefined);
      throw error;
    }
  }

  /** null if there is no such blob. */
  async get(projectId: string, blobId: string): Promise<Uint8Array | null> {
    try {
      return await readFile(join(this.#dir(projectId), safe(blobId)));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async delete(projectId: string, blobId: string): Promise<void> {
    await rm(join(this.#dir(projectId), safe(blobId)), { force: true });
  }

  async deleteProject(projectId: string): Promise<void> {
    await rm(this.#dir(projectId), { recursive: true, force: true });
  }
}
