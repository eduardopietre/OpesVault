/**
 * The import queue (desktop `ui/pages/imports/queue.py`): the files chosen or dropped are read one at a time, off
 * the main thread (`data/parser_client.ts`), and each result is stored in the project as one undo step. Two imports
 * never change the project at once. A protected PDF asks for its password, used once and never kept. Every file
 * that waits, is read or failed shows in `ReadingStrip` with the way to cancel it, so nothing happens out of sight.
 */
import { DomainError, importing, type Id } from "@opesvault/domain";
import { Button, notify, useMotionPreset } from "@opesvault/ui";
import { AnimatePresence, motion } from "motion/react";
import { FileText, LoaderCircle, TriangleAlert, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { READ_FAILED, ReadCancelled, parser } from "../../data/parser_client.ts";
import { useWorkspace } from "../../data/react.tsx";
import { ImportPasswordDialog } from "../../dialogs/import_password.tsx";
import type { ImportAi } from "./ai.tsx";
import { READ_ONLY_TIP } from "../../data/read_only.ts";

type Analysis = importing.pipeline.Analysis;
type ImportRequest = importing.pipeline.ImportRequest;
const { SourceError, SourceProblem, PROBLEM_MESSAGES, MAX_DOCUMENT_BYTES } = importing.source;

/** What the page reads: PDF, CSV and OFX (a `.txt` may be an OFX or a CSV export). */
export const DOCUMENT_SUFFIXES: readonly string[] = [".pdf", ".csv", ".ofx", ".txt"];
export const ACCEPT = DOCUMENT_SUFFIXES.join(",");

export type JobState = "waiting" | "reading" | "password" | "failed";

export interface ReadJob {
  id: number;
  name: string;
  size: number;
  state: JobState;
  /** Why it failed. */
  message: string | null;
}

/** The person did not give the password. */
class PasswordGaveUp extends Error {}

const isPassword = (problem: string): boolean =>
  problem === SourceProblem.PASSWORD_REQUIRED || problem === SourceProblem.WRONG_PASSWORD;

interface PasswordAsk {
  name: string;
  incorrect: boolean;
  submit: (password: string) => Promise<void>;
  giveUp: () => void;
}

/** What a failed reading says to the person (never anything from the document). */
function explain(error: unknown): string {
  if (error instanceof DomainError) return error.message;
  if (error instanceof importing.parserWorker.WorkerFailed) return READ_FAILED;
  return "Falha ao processar o arquivo.";
}

export interface ImportQueue {
  jobs: readonly ReadJob[];
  /** A file is being read, or a document is being read again with another layout. */
  busy: boolean;
  /** Files chosen or dropped; unsupported ones are refused with a notice. */
  addFiles: (files: readonly File[]) => void;
  /** Stops what is being read and what waits. */
  cancel: () => void;
  /** Takes one file off the queue (waiting) or off the list (failed). */
  dismiss: (id: number) => void;
  /** Reads a document of a batch again with the layout the user chose. */
  reparse: (batchId: Id, parserId: string) => Promise<void>;
  /** The dialog that asks for a PDF's password, to be rendered by the page. */
  passwordDialog: ReactNode;
}

export function useImportQueue({ ai, onImported }: { ai: ImportAi; onImported: (batchId: Id) => void }): ImportQueue {
  const workspace = useWorkspace();
  const [jobs, setJobs] = useState<readonly ReadJob[]>([]);
  const [reparsing, setReparsing] = useState(false);
  const [asking, setAsking] = useState<PasswordAsk | null>(null);
  const files = useRef(new Map<number, File>());
  const list = useRef<readonly ReadJob[]>([]);
  const running = useRef(false);
  const next = useRef(1);
  const alive = useRef(true);
  const waitingForAi = useRef<Id[]>([]);
  const latest = useRef({ ai, onImported });
  useEffect(() => {
    latest.current = { ai, onImported };
  });
  useEffect(() => {
    alive.current = true;
    return () => {
      // Leaving the page does not stop the reading: what was chosen is still imported (the project belongs to
      // the workspace, not to the page). Only the page's own state is no longer touched.
      alive.current = false;
    };
  }, []);

  /** The list of jobs lives in a ref too, so the loop that reads them always sees the latest. */
  const commit = useCallback((all: readonly ReadJob[]) => {
    list.current = all;
    if (alive.current) setJobs(all);
  }, []);
  const patch = useCallback(
    (id: number, change: Partial<ReadJob>) =>
      commit(list.current.map((job) => (job.id === id ? { ...job, ...change } : job))),
    [commit],
  );
  const drop = useCallback(
    (id: number) => {
      files.current.delete(id);
      commit(list.current.filter((job) => job.id !== id));
    },
    [commit],
  );

  /** Reads a document in the worker; a protected PDF asks the person, as many times as it takes. */
  const read = useCallback(
    async (request: Omit<ImportRequest, "password">, jobId: number | null = null): Promise<Analysis> => {
      try {
        return await parser.analyze({ ...request, password: null });
      } catch (error) {
        if (!(error instanceof SourceError) || !isPassword(error.problem)) throw error;
        const first = error.problem === SourceProblem.WRONG_PASSWORD;
        // Nobody is here to type it: the file is skipped rather than left hanging.
        if (!alive.current) throw new PasswordGaveUp();
        return new Promise<Analysis>((resolve, reject) => {
          let finished = false;
          if (jobId !== null) patch(jobId, { state: "password" });
          const end = () => {
            finished = true;
            setAsking(null);
            if (jobId !== null) patch(jobId, { state: "reading" });
          };
          setAsking({
            name: request.name,
            incorrect: first,
            giveUp: () => {
              if (finished) return;
              end();
              reject(new PasswordGaveUp());
            },
            // The password is used for this one reading and then forgotten.
            submit: async (password) => {
              try {
                const analysis = await parser.analyze({ ...request, password });
                end();
                resolve(analysis);
              } catch (failure) {
                if (failure instanceof SourceError && isPassword(failure.problem)) {
                  throw new DomainError("Senha incorreta. Tente de novo.");
                }
                end();
                reject(failure);
              }
            },
          });
        });
      }
    },
    [patch],
  );

  const process = useCallback(
    async (job: ReadJob) => {
      const file = files.current.get(job.id);
      if (!file) return drop(job.id);
      patch(job.id, { state: "reading" });
      try {
        if (file.size > MAX_DOCUMENT_BYTES) throw new DomainError(PROBLEM_MESSAGES[SourceProblem.TOO_LARGE]);
        let data: Uint8Array;
        try {
          data = new Uint8Array(await file.arrayBuffer());
        } catch {
          throw new DomainError("Não foi possível ler o arquivo.");
        }
        importing.pipeline.checkNotImported(workspace.session, data);
        latest.current.ai.warmUp();
        const request: Omit<ImportRequest, "password"> = { name: file.name, data };
        const analysis = await read(request, job.id);
        const batch = workspace.act(
          (_ledger, session) => importing.pipeline.importAnalyzed(session, request, analysis),
          "importar arquivo",
        );
        drop(job.id);
        waitingForAi.current.push(batch.id);
        latest.current.onImported(batch.id);
        const count = importing.pipeline.itemsOf(workspace.ledger, batch.id).length;
        if (batch.status === importing.importModel.BatchStatus.IN_REVIEW) {
          notify(`${file.name}: ${count} item(ns) para revisar.`);
        } else {
          notify(`${file.name}: ${batch.warnings[0] ?? "o arquivo foi guardado, mas precisa de um layout."}`, {
            tone: "warning",
          });
        }
      } catch (error) {
        if (error instanceof ReadCancelled) return drop(job.id);
        if (error instanceof PasswordGaveUp) {
          drop(job.id);
          notify(`${file.name}: senha não informada; o arquivo não foi importado.`);
          return;
        }
        patch(job.id, { state: "failed", message: explain(error) });
      }
    },
    [drop, patch, read, workspace],
  );

  const drain = useCallback(async () => {
    if (running.current) return;
    running.current = true;
    try {
      for (;;) {
        const waiting = list.current.find((job) => job.state === "waiting");
        if (!waiting) break;
        await process(waiting);
      }
    } finally {
      running.current = false;
    }
  }, [process]);

  const addFiles = useCallback(
    (chosen: readonly File[]) => {
      if (workspace.readOnly) {
        notify(READ_ONLY_TIP, { tone: "warning" });
        return;
      }
      const accepted = chosen.filter((file) =>
        DOCUMENT_SUFFIXES.some((suffix) => file.name.toLowerCase().endsWith(suffix)),
      );
      const refused = chosen.length - accepted.length;
      if (refused) {
        notify(
          refused === 1
            ? "1 arquivo ignorado: só PDF, CSV ou OFX."
            : `${refused} arquivos ignorados: só PDF, CSV ou OFX.`,
          { tone: "warning" },
        );
      }
      if (!accepted.length) return;
      const added: ReadJob[] = accepted.map((file) => {
        const id = next.current++;
        files.current.set(id, file);
        return { id, name: file.name, size: file.size, state: "waiting", message: null };
      });
      commit([...list.current, ...added]);
      void drain();
    },
    [commit, drain, workspace],
  );

  const cancel = useCallback(() => {
    for (const job of list.current) if (job.state === "waiting") files.current.delete(job.id);
    commit(list.current.filter((job) => job.state !== "waiting"));
    asking?.giveUp();
    parser.cancel();
    notify("Leitura cancelada.");
  }, [asking, commit]);

  const dismiss = useCallback((id: number) => drop(id), [drop]);

  // Once nothing is being read, the local AI looks at what was imported (desktop `_next_import`).
  const active = jobs.some((job) => job.state !== "failed") || reparsing;
  const running_ = ai.run.running;
  useEffect(() => {
    if (active || running_ || !waitingForAi.current.length) return;
    const waiting = waitingForAi.current.splice(0);
    latest.current.ai.start(waiting, true);
  }, [active, running_]);

  const reparse = useCallback(
    async (batchId: Id, parserId: string) => {
      const batch = importing.pipeline.batches(workspace.ledger).get(batchId);
      if (!batch || reparsing) return;
      setReparsing(true);
      try {
        importing.pipeline.checkReparsable(workspace.session, batchId);
        const data = await workspace.loadDocument(batch.document_id);
        const name = workspace.session.document(batch.document_id).meta.original_name;
        latest.current.ai.warmUp();
        const analysis = await read({ name, data, parser_id: parserId });
        if (analysis.kind === "problem") {
          notify(PROBLEM_MESSAGES[analysis.problem], { tone: "negative" });
          return;
        }
        const stored = workspace.act(
          (_ledger, session) => importing.pipeline.storeReparseAnalysis(session, batchId, analysis),
          "ler o arquivo de novo",
        );
        waitingForAi.current.push(stored.id);
        latest.current.onImported(stored.id);
        notify(`${name}: lido de novo com o layout ${parserId}.`);
      } catch (error) {
        if (error instanceof ReadCancelled) return;
        if (error instanceof PasswordGaveUp) {
          notify("Senha não informada; o documento continua sem layout.");
          return;
        }
        notify(explain(error), { tone: "negative" });
      } finally {
        if (alive.current) setReparsing(false);
      }
    },
    [read, reparsing, workspace],
  );

  const passwordDialog = asking ? (
    <ImportPasswordDialog
      open
      name={asking.name}
      incorrect={asking.incorrect}
      onClose={asking.giveUp}
      onSubmit={asking.submit}
    />
  ) : null;

  return { jobs, busy: active, addFiles, cancel, dismiss, reparse, passwordDialog };
}

// ── what is waiting, in view ────────────────────────

const STATE_TEXT: Record<JobState, string> = {
  waiting: "Na fila",
  reading: "Lendo…",
  password: "Aguardando a senha",
  failed: "Não importado",
};

function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1).replace(".", ",")} MB`;
}

export function ReadingStrip({ queue, readOnly }: { queue: ImportQueue; readOnly: boolean }) {
  const preset = useMotionPreset();
  const reading = queue.jobs.some((job) => job.state !== "failed");
  return (
    <AnimatePresence initial={false}>
      {queue.jobs.length ? (
        <motion.section
          key="strip"
          aria-label="Arquivos em leitura"
          initial={preset.fade.initial}
          animate={preset.fade.animate}
          exit={preset.fade.exit}
          transition={preset.fade.transition}
          className="flex flex-col gap-1 rounded-lg border border-separator bg-raised p-2"
        >
          <ul className="flex flex-col gap-1">
            <AnimatePresence initial={false}>
              {queue.jobs.map((job) => (
                <motion.li
                  key={job.id}
                  layout="position"
                  initial={preset.fade.initial}
                  animate={preset.fade.animate}
                  exit={preset.fade.exit}
                  transition={preset.fade.transition}
                  className="flex min-w-0 items-center gap-2 rounded-md px-2 py-1.5"
                >
                  <span aria-hidden="true" className="shrink-0 text-secondary">
                    {job.state === "failed" ? (
                      <TriangleAlert className="size-4 text-negative" />
                    ) : job.state === "waiting" ? (
                      <FileText className="size-4" />
                    ) : (
                      <LoaderCircle className="size-4 animate-spin motion-reduce:animate-none" />
                    )}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-body font-medium" title={job.name}>
                      {job.name}
                    </p>
                    <p
                      className={job.state === "failed" ? "text-caption text-negative" : "text-caption text-secondary"}
                      role={job.state === "failed" ? "alert" : undefined}
                    >
                      {STATE_TEXT[job.state]} · {size(job.size)}
                      {job.message ? ` · ${job.message}` : ""}
                    </p>
                  </div>
                  {job.state === "failed" ? (
                    <Button size="sm" variant="ghost" icon={<X />} onClick={() => queue.dismiss(job.id)}>
                      <span className="sr-only">Dispensar {job.name}</span>
                      <span aria-hidden="true">Dispensar</span>
                    </Button>
                  ) : job.state === "waiting" ? (
                    <Button size="sm" variant="ghost" onClick={() => queue.dismiss(job.id)} disabled={readOnly}>
                      <span className="sr-only">Tirar {job.name} da fila</span>
                      <span aria-hidden="true">Tirar da fila</span>
                    </Button>
                  ) : null}
                </motion.li>
              ))}
            </AnimatePresence>
          </ul>
          {reading ? (
            <div className="flex justify-end px-2 pb-1">
              <Button size="sm" onClick={queue.cancel}>
                Cancelar leitura
              </Button>
            </div>
          ) : null}
        </motion.section>
      ) : null}
    </AnimatePresence>
  );
}
