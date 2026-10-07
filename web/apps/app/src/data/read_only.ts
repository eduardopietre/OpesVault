/**
 * The read-only project (another tab or device holds the edit lease, docs/19 §9.2): one wording for every
 * disabled command and notice, and the hook that gives a command its state and tooltip.
 */
import { useWorkspace } from "./react.tsx";

export const READ_ONLY_TIP = "Outra aba ou aparelho está editando este projeto; aqui só leitura.";

/** Read-only state and the tooltip that explains a disabled command. */
export function useLock(): { locked: boolean; tip: string | undefined } {
  const locked = useWorkspace().readOnly;
  return { locked, tip: locked ? READ_ONLY_TIP : undefined };
}
