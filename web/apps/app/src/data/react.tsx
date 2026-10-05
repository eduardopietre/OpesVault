/**
 * React access to the open project: `useWorkspace()` for actions, `useLedger()` for reads that re-run
 * after every change, and `useAct()` to run a user action with the domain's errors shown to the user.
 */
import { DomainError, type Ledger } from "@opesvault/domain";
import { notify } from "@opesvault/ui";
import { createContext, useCallback, useContext, useMemo, useSyncExternalStore, type ReactNode } from "react";
import type { Workspace } from "./workspace.ts";

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

/**
 * Runs a user action. A DomainError (a refused change, with a Portuguese message for the user) is shown
 * as a notice and returns `undefined`; anything else is a bug and is rethrown.
 */
export function useAct(): <T>(action: (ledger: Ledger) => T, done?: string) => T | undefined {
  const workspace = useWorkspace();
  return useCallback(
    <T,>(action: (ledger: Ledger) => T, done?: string) => {
      try {
        const result = workspace.act(action);
        if (done) notify(done);
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
