/**
 * The vault's `RecordOpener` over Web Workers (see vault_open.worker.ts). Workers live for one call: they
 * are started for the work, get the record keys with it and are ended when they answer, so no key outlives
 * the opening. With no Worker (tests, old browsers) there is no opener and the vault opens on its own thread.
 */
import type { PlainRecord, RecordKeyShare } from "@opesvault/crypto";
import type { OpenedEntry, RecordOpener, SealedItem } from "@opesvault/vault";
import type { OpenReply, OpenRequest } from "./vault_open.worker.ts";

/** One worker per spare core, at most this many (each holds its slice of the project in memory). */
const MAX_WORKERS = 4;

export function workerCount(): number {
  const cores = typeof navigator === "undefined" ? 2 : navigator.hardwareConcurrency || 2;
  return Math.max(1, Math.min(MAX_WORKERS, cores - 1));
}

/** Runs one request per worker and collects the answers; every worker is ended at the end. */
async function runOnWorkers<T>(requests: readonly OpenRequest[]): Promise<T[]> {
  const workers = requests.map(
    () => new Worker(new URL("./vault_open.worker.ts", import.meta.url), { type: "module" }),
  );
  try {
    return await Promise.all(
      workers.map(
        (worker, index) =>
          new Promise<T>((resolve, reject) => {
            worker.onmessage = (event: MessageEvent<OpenReply>) => {
              if ("failed" in event.data) reject(new Error("worker failed"));
              else resolve(JSON.parse(event.data.json) as T);
            };
            worker.onerror = () => reject(new Error("worker failed"));
            worker.postMessage(requests[index]);
          }),
      ),
    );
  } finally {
    for (const worker of workers) worker.terminate();
  }
}

/** Ids are 32 hex characters: the slices cut at hex digits, the last one runs to the end of the project. */
function slices(n: number): { from: string; to: string | null }[] {
  const digits = "0123456789abcdef";
  return Array.from({ length: n }, (_, i) => ({
    from: i === 0 ? "" : digits[Math.floor((i * 16) / n)]!,
    to: i === n - 1 ? null : digits[Math.floor(((i + 1) * 16) / n)]!,
  }));
}

export function createWorkerOpener(): RecordOpener | undefined {
  if (typeof Worker === "undefined") return undefined;
  return {
    async open(share: RecordKeyShare, items: readonly SealedItem[]): Promise<(PlainRecord | null)[]> {
      const n = workerCount();
      const size = Math.ceil(items.length / n);
      const requests: OpenRequest[] = Array.from({ length: n }, (_, i) => ({
        type: "open",
        share,
        items: items.slice(i * size, (i + 1) * size),
      }));
      return (await runOnWorkers<(PlainRecord | null)[]>(requests)).flat();
    },
    async openCached(share: RecordKeyShare, cacheName: string, projectId: string): Promise<OpenedEntry[]> {
      const requests: OpenRequest[] = slices(workerCount()).map(({ from, to }) => ({
        type: "cached",
        share,
        cacheName,
        projectId,
        from,
        to,
      }));
      return (await runOnWorkers<OpenedEntry[]>(requests)).flat();
    },
  };
}
