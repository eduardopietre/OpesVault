/**
 * Opening the project's records off the main thread (docs/18 W12): reading the encrypted copy in IndexedDB
 * and decrypting it is most of what opening a project with tens of thousands of entries costs. Each worker
 * gets the two non-extractable record keys (it can use them, never read them) and a slice of the work, and
 * is ended by `open_pool.ts` as soon as it answers. It never sees a password.
 */
import { openRecordWith, type PlainRecord, type RecordKeyShare } from "@opesvault/crypto";
import { VaultCache, type OpenedEntry, type SealedItem } from "@opesvault/vault";

export type OpenRequest =
  | { readonly type: "open"; readonly share: RecordKeyShare; readonly items: readonly SealedItem[] }
  | {
      readonly type: "cached";
      readonly share: RecordKeyShare;
      readonly cacheName: string;
      readonly projectId: string;
      readonly from: string;
      readonly to: string | null;
    };

/**
 * The answers travel as JSON text, not as objects: the browser's structured clone of tens of thousands of nested
 * records costs the main thread about twice what parsing the same text does.
 */
export type OpenReply = { readonly json: string } | { readonly failed: true };

const BATCH = 256;

async function openAll(share: RecordKeyShare, items: readonly SealedItem[]): Promise<(PlainRecord | null)[]> {
  const out: (PlainRecord | null)[] = [];
  for (let i = 0; i < items.length; i += BATCH) {
    const batch = items.slice(i, i + BATCH);
    const opened = await Promise.all(
      batch.map((item) => openRecordWith(share, item.id, item.ciphertext).catch(() => null)),
    );
    out.push(...opened);
  }
  return out;
}

async function handle(request: OpenRequest): Promise<OpenReply> {
  if (request.type === "open") return { json: JSON.stringify(await openAll(request.share, request.items)) };
  const cache = await VaultCache.open({ name: request.cacheName });
  try {
    const rows = await cache.listRecordsBetween(request.projectId, request.from, request.to);
    const sealed = rows.flatMap((r) => (r.ciphertext === null ? [] : [{ id: r.id, ciphertext: r.ciphertext }]));
    const opened = await openAll(request.share, sealed);
    const byId = new Map(sealed.map((item, k) => [item.id, opened[k] ?? null]));
    const entries = rows.map((r): OpenedEntry => {
      if (r.ciphertext === null) return [r.id, r.revision, "tombstone"];
      const record = byId.get(r.id) ?? null;
      return record === null ? [r.id, r.revision, "damaged"] : [r.id, r.revision, "open", record];
    });
    return { json: JSON.stringify(entries) };
  } finally {
    cache.close();
  }
}

self.onmessage = (event: MessageEvent<OpenRequest>) => {
  handle(event.data).then(
    (reply) => postMessage(reply),
    () => postMessage({ failed: true } satisfies OpenReply),
  );
};
