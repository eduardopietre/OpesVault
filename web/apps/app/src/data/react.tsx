/**
 * React access to the open project: `useWorkspace()` for actions, `useLedger()` for reads that re-run
 * after every change, and `useAct()` to run a user action with the domain's errors shown to the user.
 */
import type { Ledger, session as sessions } from "@opesvault/domain";
import { DomainError } from "@opesvault/domain/error";

type Session = sessions.Session;
import { notify, type ToastOptions } from "@opesvault/ui";
import { createContext, useCallback, useContext, useMemo, useSyncExternalStore, type ReactNode } from "react";
import type { UndoStep, Workspace } from "./workspace.ts";

const WorkspaceContext = createContext<Workspace | null>(null);

export function WorkspaceProvider({ workspace, children }: { workspace: Workspace | null; children: ReactNode }) {
  return <WorkspaceContext.Provider value={workspace}>{children}</WorkspaceContext.Provider>;
}

/** The open project's workspace; pages only render while a project is open. */
export function useWorkspace(): Workspace {
  const workspace = useContext(WorkspaceContext);
  if (!workspace) throw new Error("No project is open");
  return workspace;
}

export function useOptionalWorkspace(): Workspace | null {
  return useContext(WorkspaceContext);
}

/** The ledger version: changes after every action, undo, redo or remote change. */
export function useLedgerVersion(): number {
  const workspace = useWorkspace();
  return useSyncExternalStore(workspace.subscribe, workspace.getVersion, workspace.getVersion);
}

/**
 * A value computed from the ledger, recomputed when the ledger changes or `key` changes. `key` names
 * everything else `select` reads (a month as "2026-10", an id, or a string joining several), so the
 * hook needs no dependency list. The domain caches heavy queries by `changeCount` too.
 */
export function useLedger<T>(select: (ledger: Ledger) => T, key: string | number | boolean | null = null): T {
  const workspace = useWorkspace();
  const version = useLedgerVersion();
  // eslint-disable-next-line react-hooks/exhaustive-deps -- `select` depends only on the ledger and `key`
  return useMemo(() => select(workspace.ledger), [workspace, version, key]);
}

/** What the notice's Desfazer says when the action is no longer the last one (only the last can be undone). */
export const NOT_LAST =
  "Outra alteração foi feita depois desta. Use Desfazer no topo da tela, que desfaz uma ação de cada vez.";

/** Undoes `step` if it is still the last action, with the notice Ctrl+Z gives ("Desfeito: arquivar meta."). */
function undoStep(workspace: Workspace, step: UndoStep): void {
  const stack = workspace.undoStack;
  if (stack.undoSteps.at(-1) !== step || stack.journal.length) {
    notify(NOT_LAST, { tone: "warning" });
    return;
  }
  try {
    const label = workspace.undo();
    notify(label ? `Desfeito: ${label}.` : "Nada a desfazer.");
  } catch (error) {
    if (error instanceof DomainError) notify(error.message, { tone: "negative" });
    else throw error;
  }
}

/**
 * The notice after a user action, with "Desfazer" for that action when it changed the project (and nothing
 * changed it since). Every notice that reports a change uses this, so undoing never needs Ctrl+Z (docs/16 §4).
 */
export function notifyDone(workspace: Workspace, message: string, options: Omit<ToastOptions, "action"> = {}): void {
  const step = workspace.freshStep();
  notify(message, step ? { ...options, action: { label: "Desfazer", run: () => undoStep(workspace, step) } } : options);
}

/** `notifyDone` for the open project: call it right after the action, with what the action did. */
export function useNotifyDone(): (message: string, options?: Omit<ToastOptions, "action">) => void {
  const workspace = useWorkspace();
  return useCallback(
    (message: string, options?: Omit<ToastOptions, "action">) => notifyDone(workspace, message, options),
    [workspace],
  );
}

/** How a user action is reported: `done` is the notice after it; `label` names it in the undo history. */
export interface ActOptions {
  done?: string | undefined;
  label?: string | undefined;
}

/**
 * Runs a user action. A DomainError (a refused change, with a Portuguese message for the user) is shown
 * as a notice and returns `undefined`; anything else is a bug and is rethrown. The second argument is the
 * notice after it, or `{ done, label }` with the name of the action for "Desfazer: …".
 */
export function useAct(): <T>(
  action: (ledger: Ledger, session: Session) => T,
  options?: string | ActOptions,
) => T | undefined {
  const workspace = useWorkspace();
  return useCallback(
    <T,>(action: (ledger: Ledger, session: Session) => T, options?: string | ActOptions) => {
      const { done, label } = typeof options === "string" ? { done: options, label: undefined } : (options ?? {});
      try {
        const result = workspace.act(action, label);
        if (done) notifyDone(workspace, done);
        return result;
      } catch (error) {
        if (error instanceof DomainError) {
          notify(error.message, { tone: "negative" });
          return undefined;
        }
        throw error;
      }
    },
    [workspace],
  );
}
