/**
 * The questions the review asks before it acts (desktop `ask_reason`): a reason for rejecting, for keeping an
 * item apart, for a partial approval or for accepting a total that does not match. Each one is a dialog that
 * answers with the text, or with null when the person gave up; the reason stays in the history.
 */
import { useCallback, useState, type ReactNode } from "react";
import { ReasonDialog } from "../../dialogs/livro_prompts.tsx";

export interface ReasonQuestion {
  title: string;
  confirmLabel: string;
  description?: ReactNode;
}

/** `ask(question)` resolves with the trimmed reason, or null; render `dialog` once in the page. */
export function useReasonPrompt(): { ask: (question: ReasonQuestion) => Promise<string | null>; dialog: ReactNode } {
  const [pending, setPending] = useState<(ReasonQuestion & { resolve: (reason: string | null) => void }) | null>(null);
  const ask = useCallback(
    (question: ReasonQuestion) => new Promise<string | null>((resolve) => setPending({ ...question, resolve })),
    [],
  );
  const dialog = pending ? (
    <ReasonDialog
      open
      title={pending.title}
      confirmLabel={pending.confirmLabel}
      {...(pending.description ? { description: pending.description } : {})}
      onClose={() => {
        pending.resolve(null); // no effect after an answer: the first one wins
        setPending(null);
      }}
      onSubmit={(reason) => {
        pending.resolve(reason);
        setPending(null);
      }}
    />
  ) : null;
  return { ask, dialog };
}
