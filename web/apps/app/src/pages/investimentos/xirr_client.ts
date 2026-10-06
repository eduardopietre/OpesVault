/**
 * Solves the internal rate of return in a Web Worker (`xirr.worker.ts`) so a long history never freezes the
 * screen. Where there is no worker (tests) or it fails, the same solver runs on the calling thread after a
 * pause, with the same result: the worker is only where the time is spent.
 */
import { Dec, investments, type IsoDate } from "@opesvault/domain";

export type Dated = readonly (readonly [IsoDate, Dec])[];
export type Solved = readonly [rate: Dec | null, reason: string];

interface Reply {
  id: number;
  rate?: string | null;
  reason?: string;
  error?: true;
}

let worker: Worker | null = null;
let broken = false;
let next = 1;
const waiting = new Map<number, (reply: Reply) => void>();

function start(): Worker | null {
  if (broken || typeof Worker === "undefined") return null;
  if (worker) return worker;
  try {
    const created = new Worker(new URL("./xirr.worker.ts", import.meta.url), { type: "module" });
    created.onmessage = (event: MessageEvent<Reply>) => waiting.get(event.data.id)?.(event.data);
    created.onerror = () => {
      broken = true;
      worker = null;
      for (const answer of waiting.values()) answer({ id: 0, error: true });
    };
    worker = created;
    return created;
  } catch {
    broken = true;
    return null;
  }
}

/** On the calling thread, after the current task, so the screen can paint first. */
function inline(dated: Dated): Promise<Solved> {
  return new Promise((resolve) => {
    setTimeout(() => resolve(investments.returns.xirrFromFlows(dated)), 0);
  });
}

export function solveXirr(dated: Dated): Promise<Solved> {
  const running = start();
  if (!running) return inline(dated);
  return new Promise<Solved>((resolve) => {
    const id = next++;
    waiting.set(id, (reply) => {
      waiting.delete(id);
      if (reply.error || reply.rate === undefined) {
        void inline(dated).then(resolve);
        return;
      }
      resolve([reply.rate === null ? null : Dec.parse(reply.rate), reply.reason ?? ""]);
    });
    running.postMessage({ id, dated: dated.map(([on, amount]) => [on, amount.toFixed()]) });
  });
}
