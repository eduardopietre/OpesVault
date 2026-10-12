/**
 * The read-only project (another tab or device holds the edit lease, docs/19 §9.2): one wording for every
 * disabled command and notice, and the hook that gives a command its state and tooltip.
 */
import type { MenuEntry } from "@opesvault/ui";
import { useWorkspace } from "./react.tsx";

export const READ_ONLY_TIP = "Outra aba ou aparelho está editando este projeto; aqui só leitura.";

/** Read-only state and the tooltip that explains a disabled command. */
export function useLock(): { locked: boolean; tip: string | undefined } {
  const locked = useWorkspace().readOnly;
  return { locked, tip: locked ? READ_ONLY_TIP : undefined };
}

/**
 * A menu (a header menu or a row's context menu) with every command disabled while the project is read-only,
 * submenus included, except the ids in `free` (commands that only read: open, see, export).
 */
export function lockEntries(items: readonly MenuEntry[], locked: boolean, free: readonly string[] = []): MenuEntry[] {
  if (!locked) return [...items];
  return items.map((item) => {
    if (item.kind === "separator" || item.kind === "label" || item.kind === "radio" || free.includes(item.id)) {
      return item;
    }
    if (item.kind === "submenu") return { ...item, items: lockEntries(item.items, locked, free) };
    return { ...item, disabled: true };
  });
}
