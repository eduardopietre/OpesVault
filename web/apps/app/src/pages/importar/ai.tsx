/**
 * The local AI in the import (desktop `ui/pages/imports/ai.py`): category suggestions for items still without one
 * (docs/05 §5). The model is asked in the background with descriptions only; the answer fills only items still
 * without a category when it arrives, so a choice made meanwhile always wins. Nothing is approved. The plan reads
 * the ledger here, the question runs without touching it (`aiSuggestions.ask`) and the answer comes back here as
 * one undo step. Progress, cancelling and the client are shared with the other pages (`data/ai.ts`, `ai_review`).
 */
import { importing, type Id } from "@opesvault/domain";
import { decide, notify } from "@opesvault/ui";
import { useCallback, useEffect, useRef } from "react";
import { AI_OFF, failureText, useAiClient } from "../../data/ai.ts";
import { useWorkspace } from "../../data/react.tsx";
import { useAiRun } from "../../dialogs/ai_review.tsx";

type AiOutcome = importing.aiSuggestions.AiOutcome;

function isOutcome(result: unknown): result is AiOutcome {
  return typeof result === "object" && result !== null && "planned" in result;
}

export function useImportAi() {
  const workspace = useWorkspace();
  const client = useAiClient();
  const run = useAiRun();
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  /** The model loads while the document is read (a request nobody waits for). */
  const warmUp = useCallback(() => {
    if (client !== null) void client.warmUp().catch(() => undefined);
  }, [client]);

  /** Items the model could help with in this document: pending, without a category. */
  const pendingCount = (batchId: Id): number => importing.aiSuggestions.pendingCount(workspace.ledger, batchId);

  /**
   * Asks the model about these documents. The page stays usable meanwhile. `quiet` (after an import): problems go
   * to a notice instead of a dialog.
   */
  const start = useCallback(
    (batchIds: readonly Id[], quiet: boolean): void => {
      if (client === null || workspace.readOnly) return;
      const ledger = workspace.ledger;
      const known = importing.pipeline.batches(ledger);
      const requests = batchIds
        .filter((id) => known.has(id))
        .flatMap((id) => importing.aiSuggestions.planRequests(ledger, id));
      if (!requests.length) {
        if (!quiet) notify("IA local: nenhum item sem categoria neste documento.");
        return;
      }
      const total = requests.reduce((n, r) => n + r.descriptions.length, 0);
      run.start(
        client,
        (report, cancel) => importing.aiSuggestions.ask(client, requests, report, cancel),
        total,
        "descrição(ões)",
        (result) => {
          if (!alive.current) return;
          if (isOutcome(result)) {
            let count = 0;
            if (result.planned.length && !workspace.readOnly) {
              // one undo step for the whole answer
              count = workspace.act((l) => importing.aiSuggestions.applySuggestions(l, result.planned));
            }
            let message = `IA local: ${count} categoria(s) sugerida(s)`;
            if (result.cancelled) message += ", consulta cancelada";
            else if (result.failed) message += `; ${result.failed} item(ns) sem resposta válida`;
            notify(message + (count ? ". Revise antes de aprovar." : "."));
            return;
          }
          const reason = failureText(result);
          if (quiet) notify(`IA local: ${reason}`);
          else
            void decide({
              title: "IA local",
              text: `${reason} A revisão manual continua disponível.`,
              choices: [],
              cancelLabel: "Entendi",
            });
        },
      );
    },
    [client, run, workspace],
  );

  /** The button: asks about the open document and says plainly when the AI cannot help. */
  const suggest = (batchId: Id): void => {
    if (run.running) return;
    if (client === null) {
      notify(AI_OFF);
      return;
    }
    start([batchId], false);
  };

  return { client, run, warmUp, pendingCount, start, suggest };
}

export type ImportAi = ReturnType<typeof useImportAi>;
