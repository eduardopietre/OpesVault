/** Puts the open project's workspace and its undo/redo into context for the pages and the shell. */
import { DomainError } from "@opesvault/domain/error";
import { notify } from "@opesvault/ui";
import { useEffect, useMemo, useSyncExternalStore, type ReactNode } from "react";
import { SHOW_CATALOG } from "../flags.ts";
import { useSession } from "../session.tsx";
import { UndoProvider, type UndoApi } from "../shell/undo.tsx";
import { WorkspaceProvider } from "./react.tsx";
import type { Workspace } from "./workspace.ts";

/** What the every-screen e2e reads (only in development and the e2e build, never in production). */
export interface OpesvaultTestHook {
  /** Undo steps, counting edits not yet sealed as one. */
  undoDepth(): number;
  redoDepth(): number;
  /** Changes of the project so far (a click that did not change it leaves it as it was). */
  version(): number;
}

declare global {
  interface Window {
    __opesvaultTest?: OpesvaultTestHook;
  }
}

const noVersion = () => 0;
const noSubscribe = () => () => undefined;

function undoApi(workspace: Workspace): UndoApi {
  const stack = workspace.undoStack;
  const undoLabel = stack.undoLabel();
  const redoLabel = stack.redoLabel();
  const run = (action: () => string | null, empty: string, past: string) => {
    try {
      const label = action();
      notify(label ? `${past} ${label}.` : empty);
    } catch (error) {
      if (error instanceof DomainError) notify(error.message, { tone: "negative" });
      else throw error;
    }
  };
  return {
    canUndo: !workspace.readOnly && stack.canUndo(),
    canRedo: !workspace.readOnly && stack.canRedo(),
    undoLabel: undoLabel ? `Desfazer ${undoLabel}` : "Desfazer",
    redoLabel: redoLabel ? `Refazer ${redoLabel}` : "Refazer",
    undo: () => run(() => workspace.undo(), "Nada a desfazer.", "Desfeito:"),
    redo: () => run(() => workspace.redo(), "Nada a refazer.", "Refeito:"),
  };
}

export function WorkspaceBridge({ children }: { children: ReactNode }) {
  const workspace = useSession().open?.workspace ?? null;
  const version = useSyncExternalStore(
    workspace?.subscribe ?? noSubscribe,
    workspace?.getVersion ?? noVersion,
    workspace?.getVersion ?? noVersion,
  );
  // eslint-disable-next-line react-hooks/exhaustive-deps -- recomputed on every ledger change
  const undo = useMemo(() => (workspace ? undoApi(workspace) : undefined), [workspace, version]);
  useEffect(() => {
    if (!SHOW_CATALOG || !workspace) return;
    window.__opesvaultTest = {
      undoDepth: () => workspace.undoStack.undoSteps.length + (workspace.undoStack.journal.length ? 1 : 0),
      redoDepth: () => workspace.undoStack.redoSteps.length,
      version: () => workspace.getVersion(),
    };
    return () => {
      delete window.__opesvaultTest;
    };
  }, [workspace]);
  return (
    <WorkspaceProvider workspace={workspace}>
      <UndoProvider {...(undo ? { value: undo } : {})}>{children}</UndoProvider>
    </WorkspaceProvider>
  );
}
