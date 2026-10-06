/**
 * Reading documents from the page (desktop `ImportJob` on a `QThreadPool`): the bytes go to `parser.worker.ts`
 * and what comes back is validated by the domain's `ParserWorkerClient` before the page stores anything
 * (docs/05 §3, CLAUDE.md "reading never on the UI thread"). A worker that fails, hangs past the timeout or
 * answers garbage costs one document. Cancelling ends the worker; the next document starts a new one.
 *
 * Tests give the service an in-process port (`setParserPortFactory`): the same protocol, no Worker needed.
 */
import { DomainError, importing } from "@opesvault/domain";

type Analysis = importing.pipeline.Analysis;
type ImportRequest = importing.pipeline.ImportRequest;

/** What the client needs from a worker; a real `Worker` fits, and so does a test double. */
export interface ParserPort extends importing.parserWorker.ClientPort {
  terminate?(): void;
}

/** Two minutes: a long statement of a slow machine, not a hung parser. */
export const READ_TIMEOUT_MS = 120_000;

export const READ_FAILED =
  "Não foi possível ler o arquivo: a leitura falhou ou demorou demais. Ele não foi importado; tente de novo.";

/** The user stopped the reading. */
export class ReadCancelled extends DomainError {
  constructor() {
    super("Leitura cancelada.");
    this.name = "ReadCancelled";
  }
}

let factory: (() => ParserPort) | null = null;
let timeoutMs = READ_TIMEOUT_MS;

/** Replaces the worker (tests); null puts the real one back. */
export function setParserPortFactory(next: (() => ParserPort) | null, timeout = READ_TIMEOUT_MS): void {
  parser.cancel();
  factory = next;
  timeoutMs = timeout;
}

function startWorker(): ParserPort {
  if (factory) return factory();
  if (typeof Worker === "undefined") throw new importing.parserWorker.WorkerFailed();
  return new Worker(new URL("./parser.worker.ts", import.meta.url), { type: "module" }) as unknown as ParserPort;
}

class ParserService {
  #port: ParserPort | null = null;
  #client: importing.parserWorker.ParserWorkerClient | null = null;
  readonly #pending = new Set<(error: Error) => void>();

  /** `pipeline.analyzeDocument` in the worker. Throws `SourceError` (password), `WorkerFailed` or `ReadCancelled`. */
  async analyze(request: ImportRequest): Promise<Analysis> {
    const client = this.#ensure();
    return new Promise<Analysis>((resolve, reject) => {
      const stop = (error: Error) => {
        this.#pending.delete(stop);
        reject(error);
      };
      this.#pending.add(stop);
      client.analyze(request).then(
        (analysis) => {
          this.#pending.delete(stop);
          resolve(analysis);
        },
        (error: unknown) => {
          this.#pending.delete(stop);
          // A worker that timed out may still be busy: it is ended, and the next document gets a fresh one.
          if (error instanceof importing.parserWorker.WorkerFailed && this.#client === client) this.#end();
          reject(error as Error); // the client only rejects with errors of its own: WorkerFailed or SourceError
        },
      );
    });
  }

  /** Stops what is being read: the waiting call fails with `ReadCancelled` and the worker is ended. */
  cancel(): void {
    const waiting = [...this.#pending];
    this.#pending.clear();
    this.#end();
    for (const stop of waiting) stop(new ReadCancelled());
  }

  get busy(): boolean {
    return this.#pending.size > 0;
  }

  #ensure(): importing.parserWorker.ParserWorkerClient {
    if (this.#client) return this.#client;
    const port = startWorker();
    // A Worker that cannot start (or dies) says so with an "error" event; a test double may not.
    (port as unknown as Partial<Pick<EventTarget, "addEventListener">>).addEventListener?.("error", () => {
      const waiting = [...this.#pending];
      this.#pending.clear();
      this.#end();
      for (const stop of waiting) stop(new importing.parserWorker.WorkerFailed());
    });
    this.#port = port;
    this.#client = new importing.parserWorker.ParserWorkerClient(port, timeoutMs);
    return this.#client;
  }

  #end(): void {
    this.#port?.terminate?.();
    this.#port = null;
    this.#client = null;
  }
}

export const parser = new ParserService();
