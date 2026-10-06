/**
 * The local AI on screen (desktop `ui/local_ai.py`): one progress row and one review dialog for every page
 * that asks the model. What the model proposes for data already in the book goes through `AiReviewDialog`,
 * where each change is checked, unchecked or edited before anything is written; `useAiRun` asks in the
 * background with progress and "Cancelar" while the page stays usable, and drops an answer that arrives after
 * the page is gone.
 */
import { DomainError, ai } from "@opesvault/domain";
import { Button, Checkbox, TextField } from "@opesvault/ui";
import { useCallback, useEffect, useRef, useState } from "react";
import { rememberModel } from "../data/ai.ts";
import { Caption, FormDialog } from "./livro_form.tsx";

// ── the review ──────────────────────────────────

export interface AiReviewDialogProps {
  open: boolean;
  onClose: () => void;
  title: string;
  intro: string;
  headers: readonly string[];
  rows: readonly (readonly string[])[];
  /** The column (of `headers`) the person may retype, such as a suggested name. */
  editable?: number;
  confirmLabel?: string;
  /** The checked lines: (row, text of the editable column or ""). Changes the book; throw a `DomainError` to keep the dialog open. */
  onApply: (chosen: readonly (readonly [number, string])[]) => void;
}

export function AiReviewDialog({
  open,
  onClose,
  title,
  intro,
  headers,
  rows,
  editable,
  confirmLabel = "Aplicar marcadas",
  onApply,
}: AiReviewDialogProps) {
  const [checked, setChecked] = useState<boolean[]>(() => rows.map(() => true));
  const [edited, setEdited] = useState<string[]>(() =>
    rows.map((cells) => (editable !== undefined ? (cells[editable] ?? "") : "")),
  );
  const chosen = (): [number, string][] =>
    rows.flatMap((_, row) =>
      checked[row]
        ? [
            [row, editable !== undefined ? (edited[row] ?? "").split(/\s+/).filter(Boolean).join(" ") : ""] as [
              number,
              string,
            ],
          ]
        : [],
    );
  const count = checked.filter(Boolean).length;

  const confirm = () => {
    const picked = chosen();
    if (!picked.length) throw new DomainError("Marque ao menos uma sugestão, ou feche sem aplicar.");
    if (editable !== undefined && picked.some(([, value]) => !value))
      throw new DomainError("Um nome marcado ficou vazio.");
    onApply(picked);
  };

  return (
    <FormDialog open={open} onClose={onClose} title={title} confirmLabel={confirmLabel} onConfirm={confirm} size="lg">
      <div className="flex flex-col gap-3">
        <p className="text-body text-secondary">{intro}</p>
        <div
          role="region"
          aria-label="Sugestões da IA local"
          tabIndex={0}
          className="max-h-[50dvh] overflow-auto rounded-lg border border-separator"
        >
          <table className="w-full min-w-[34rem] border-collapse text-body">
            <thead className="sticky top-0 bg-raised">
              <tr className="border-b border-separator text-left text-caption font-semibold text-secondary">
                {headers.map((header) => (
                  <th key={header} scope="col" className="px-3 py-2">
                    {header}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((cells, row) => (
                <tr key={row} className="border-b border-separator/60 align-middle last:border-b-0">
                  {cells.map((cell, column) => (
                    <td key={column} className="px-3 py-1.5">
                      {column === 0 ? (
                        <Checkbox
                          label={cell}
                          checked={checked[row] ?? false}
                          onCheckedChange={(value) =>
                            setChecked((current) => current.map((c, i) => (i === row ? value : c)))
                          }
                        />
                      ) : column === editable ? (
                        <TextField
                          label={`Nome sugerido para ${cells[0] ?? ""}`}
                          hideLabel
                          value={edited[row] ?? ""}
                          onChange={(text) => setEdited((current) => current.map((e, i) => (i === row ? text : e)))}
                          autoComplete="off"
                          title="Ajuste o nome antes de aplicar"
                        />
                      ) : (
                        <span>{cell}</span>
                      )}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" onClick={() => setChecked(rows.map(() => true))}>
            Marcar todas
          </Button>
          <Button size="sm" onClick={() => setChecked(rows.map(() => false))}>
            Desmarcar todas
          </Button>
          <span className="ml-auto" aria-live="polite">
            <Caption>
              {count} de {rows.length} marcada(s)
            </Caption>
          </span>
        </div>
      </div>
    </FormDialog>
  );
}

// ── the run ─────────────────────────────────────

interface RunState {
  label: string;
  total: number;
  handled: number;
  cancelling: boolean;
}

export interface AiRunApi {
  running: boolean;
  state: RunState | null;
  /**
   * Runs `work(report, cancel)` in the background after checking the model: Ollama off or the model missing
   * fail at once, saying what to do. `done` gets the work's result or the `AiUnavailable`. False if busy.
   * `total` 0 shows a busy bar and `unit` alone ("pensando…").
   */
  start: <T>(
    client: ai.ollama.OllamaClient,
    work: (report: (handled: number, total: number) => void, cancel: AbortSignal) => Promise<T>,
    total: number,
    unit: string,
    done: (result: T | unknown) => void,
  ) => boolean;
  cancel: () => void;
}

export function useAiRun(): AiRunApi {
  const [state, setState] = useState<RunState | null>(null);
  const controller = useRef<AbortController | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      controller.current?.abort();
    };
  }, []);

  const cancel = useCallback(() => {
    if (controller.current === null) return;
    controller.current.abort();
    setState((current) => (current ? { ...current, cancelling: true } : current));
  }, []);

  const start: AiRunApi["start"] = (client, work, total, unit, done) => {
    if (controller.current !== null) return false;
    const mine = new AbortController();
    controller.current = mine;
    rememberModel(client);
    const prefix = `IA local (${client.model})`;
    const label = (handled: number, of: number) =>
      of > 0 ? `${prefix}: ${handled} de ${of} ${unit}` : `${prefix}: ${unit}`;
    setState({ label: label(0, total), total, handled: 0, cancelling: false });
    void (async () => {
      let result: unknown;
      try {
        await client.checkModel(); // fails fast, saying what to install, before any batch
        result = await work((handled, of) => {
          if (!alive.current || mine.signal.aborted) return;
          setState({ label: label(handled, of), total: of, handled, cancelling: false });
        }, mine.signal);
      } catch (error) {
        if (!(error instanceof ai.ollama.AiUnavailable)) throw error; // expected: Ollama off, model missing, odd answers
        result = error;
      }
      controller.current = null;
      if (!alive.current) return; // the page is gone: the answer is no longer wanted
      setState(null);
      done(result);
    })();
    return true;
  };

  return { running: state !== null, state, start, cancel };
}

/** "IA local (modelo): 3 de 40 descrições", a progress bar and Cancelar, while the model works. */
export function AiRunRow({ run }: { run: AiRunApi }) {
  const state = run.state;
  if (state === null) return null;
  const percent = state.total > 0 ? Math.round((100 * state.handled) / state.total) : null;
  return (
    <div
      role="status"
      aria-live="polite"
      className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-separator bg-raised px-3 py-2"
    >
      <span className="text-caption text-secondary">
        {state.cancelling ? "Cancelando ao fim do lote atual…" : state.label}
      </span>
      <div
        role="progressbar"
        aria-label="Progresso da IA local"
        aria-valuemin={0}
        aria-valuemax={100}
        {...(percent !== null ? { "aria-valuenow": percent } : {})}
        className="relative h-1.5 min-w-24 flex-1 overflow-hidden rounded-full bg-sunken"
      >
        <div
          className={
            percent === null
              ? "ov-skeleton absolute inset-0"
              : "h-full rounded-full bg-accent-fill transition-[width] duration-[var(--ov-duration-base)]"
          }
          style={percent !== null ? { width: `${percent}%` } : undefined}
        />
      </div>
      <Button size="sm" variant="ghost" onClick={run.cancel} title="Para ao fim do lote atual">
        Cancelar
      </Button>
    </div>
  );
}
