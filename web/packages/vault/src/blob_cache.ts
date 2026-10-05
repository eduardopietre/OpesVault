/**
 * Decrypted attachments kept in memory while the project is unlocked, least recently used first
 * out. Never written anywhere; `clear()` (on lock) overwrites the bytes it holds.
 */
import { wipe } from "@opesvault/crypto";

export class BlobCache {
  readonly #maxBytes: number;
  readonly #entries = new Map<string, Uint8Array>();
  #bytes = 0;

  constructor(maxBytes: number) {
    this.#maxBytes = maxBytes;
  }

  get size(): number {
    return this.#bytes;
  }

  get(id: string): Uint8Array | undefined {
    const value = this.#entries.get(id);
    if (value !== undefined) {
      this.#entries.delete(id);
      this.#entries.set(id, value);
    }
    return value;
  }

  put(id: string, data: Uint8Array): void {
    this.delete(id);
    if (data.length > this.#maxBytes) return;
    this.#entries.set(id, data);
    this.#bytes += data.length;
    for (const [oldest, value] of this.#entries) {
      if (this.#bytes <= this.#maxBytes) break;
      this.#entries.delete(oldest);
      this.#bytes -= value.length;
      wipe(value);
    }
  }

  delete(id: string): void {
    const value = this.#entries.get(id);
    if (value === undefined) return;
    this.#entries.delete(id);
    this.#bytes -= value.length;
    wipe(value);
  }

  clear(): void {
    for (const value of this.#entries.values()) wipe(value);
    this.#entries.clear();
    this.#bytes = 0;
  }
}
