/**
 * Undo and redo (docs/16 §4 rule 6): Ctrl+Z and Ctrl+Shift+Z (or Ctrl+Y) undo what each user action did.
 * The domain's UndoStack arrives with W3; until then the context has nothing to undo and says so.
 */
import { notify } from "@opesvault/ui";
import { createContext, useContext, useMemo, type ReactNode } from "react";

export interface UndoApi {
  canUndo: boolean;
  canRedo: boolean;
  /** "Desfazer lançamento". */
  undoLabel: string;
  redoLabel: string;
  undo(): void;
  redo(): void;
}

const noop: UndoApi = {
  canUndo: false,
  canRedo: false,
  undoLabel: "Desfazer",
  redoLabel: "Refazer",
  undo: () => notify("Nada a desfazer."),
  redo: () => notify("Nada a refazer."),
};

const UndoContext = createContext<UndoApi>(noop);

export function UndoProvider({ value, children }: { value?: UndoApi; children: ReactNode }) {
  const api = useMemo(() => value ?? noop, [value]);
  return <UndoContext.Provider value={api}>{children}</UndoContext.Provider>;
}

export function useUndo(): UndoApi {
  return useContext(UndoContext);
}
