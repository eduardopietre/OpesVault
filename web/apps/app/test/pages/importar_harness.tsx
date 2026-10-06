/**
 * Mounts Importar e revisar with the demonstration project (or an empty one) and an in-process stand-in for the
 * parser worker: the same protocol (`serveParser` / `ParserWorkerClient`, messages cloned like `postMessage`
 * does), run in this thread because happy-dom has no Worker.
 */
import { dom, importing } from "@opesvault/domain";
import { screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, vi } from "vitest";
import { setAiTransport } from "../../src/data/ai.ts";
import { takeDroppedFiles } from "../../src/data/dropped_files.ts";
import { browserExtractor } from "../../src/data/pdf.ts";
import { setParserPortFactory, type ParserPort } from "../../src/data/parser_client.ts";
import { FakeOllama } from "./fake_ollama.ts";
import { openAt, type OpenOptions } from "./sharing_docs_harness.tsx";

export type { User } from "./sharing_docs_harness.tsx";

export interface FakeWorker {
  /** Messages the page sent to the worker (their `data` is the document: never a password check here). */
  received: Record<string, unknown>[];
  terminated: number;
  started: number;
  /** When set, the worker never answers (a hang). */
  hang: boolean;
  /** When set, the worker answers garbage. */
  garbage: boolean;
}

/** An in-process worker: the page's port talks to `serveParser` through cloned messages. */
export function installFakeWorker(timeoutMs = 120_000): FakeWorker {
  const state: FakeWorker = { received: [], terminated: 0, started: 0, hang: false, garbage: false };
  setParserPortFactory(() => {
    state.started += 1;
    const toWorker: ((event: { data: unknown }) => void)[] = [];
    const toPage: ((event: { data: unknown }) => void)[] = [];
    const workerSide = {
      postMessage: (message: unknown) => {
        if (state.hang) return;
        const reply = state.garbage
          ? { id: (message as { id: number }).id, kind: "analysis", analysis: { nope: 1 } }
          : message;
        queueMicrotask(() => toPage.forEach((listener) => listener({ data: structuredClone(reply) })));
      },
      addEventListener: (_type: "message", listener: (event: { data: unknown }) => void) => {
        toWorker.push(listener);
      },
    };
    importing.parserWorker.serveParser(workerSide, browserExtractor());
    const port: ParserPort = {
      postMessage: (message: unknown) => {
        state.received.push(message as Record<string, unknown>);
        queueMicrotask(() => toWorker.forEach((listener) => listener({ data: structuredClone(message) })));
      },
      // like a Worker: "message" gets the answers; "error" would only fire if the worker died
      addEventListener: (type: string, listener: (event: { data: unknown }) => void) => {
        if (type === "message") toPage.push(listener);
      },
      terminate: () => {
        state.terminated += 1;
      },
    };
    return port;
  }, timeoutMs);
  return state;
}

afterEach(() => {
  setParserPortFactory(null);
  setAiTransport(null);
  takeDroppedFiles();
  vi.restoreAllMocks();
});

/**
 * Opens the page. The local AI is off unless `ai` is set (it would change categories and add an undo step after
 * each import); a fake Ollama is always in place, so a test never talks to a real one.
 */
export async function openImport(
  options: OpenOptions & { path?: string; heading?: string; ai?: boolean; timeoutMs?: number } = {},
) {
  const worker = installFakeWorker(options.timeoutMs);
  const ollama = new FakeOllama();
  setAiTransport(ollama.transport);
  const opened = await openAt(options.path ?? "/importar", options.heading ?? "Importar e revisar", {
    ...(options.empty !== undefined ? { empty: options.empty } : {}),
    prepare: (workspace) => {
      if (!options.ai) workspace.act((ledger) => dom.settings.updateSettings(ledger, { ai_enabled: false }));
      options.prepare?.(workspace);
    },
  });
  return { ...opened, worker, ollama };
}

export type Opened = Awaited<ReturnType<typeof openImport>>;

export const file = (bytes: Uint8Array, name: string) => new File([bytes as BlobPart], name);

/** The hidden file input behind "Importar arquivos…". */
export const picker = () => screen.getByLabelText("Escolher os arquivos para importar") as HTMLInputElement;

/** The tables by name: a card list ("listbox") when the room is narrow. */
export const tableOf = (name: string) =>
  screen.queryByRole("grid", { name }) ?? screen.queryByRole("listbox", { name });

export async function itemsTable(): Promise<HTMLElement> {
  return waitFor(() => {
    const found = tableOf("Itens extraídos");
    expect(found).toBeTruthy();
    return found as HTMLElement;
  });
}

/** The row (or card) of a table that holds `text`. */
export const rowWith = (table: HTMLElement, text: string | RegExp) => {
  const found = [...table.querySelectorAll<HTMLElement>("[data-row-id]")].find((row) =>
    typeof text === "string" ? row.textContent?.includes(text) : text.test(row.textContent ?? ""),
  );
  if (!found) throw new Error(`no row with ${String(text)}`);
  return found;
};

export const batches = (o: Opened) => [...importing.pipeline.batches(o.ledger).values()];
export const itemsOf = (o: Opened, batchId: string) => importing.pipeline.itemsOf(o.ledger, batchId);

export { within, waitFor, screen };

/** Chooses files in the picker and waits until `count` more documents are in the project. */
export async function importFiles(o: Opened, files: File[], count = files.length) {
  const before = batches(o).length;
  await o.user.upload(picker(), files);
  await waitFor(() => expect(batches(o).length).toBe(before + count), { timeout: 20_000 });
}

/** The most recent batch of the project. */
export const lastBatch = (o: Opened) =>
  [...batches(o)].sort((a, b) => (a.created_at < b.created_at ? -1 : 1)).at(-1) as importing.importModel.ImportBatch;

/** Selects an item of the open review by its description. */
export async function pickItem(o: Opened, description: string | RegExp) {
  const table = await itemsTable();
  const row = rowWith(table, description);
  await o.user.click(within(row).getByText(description));
  await waitFor(() => expect(row.getAttribute("aria-selected")).toBe("true"));
  return row.getAttribute("data-row-id") as string;
}
