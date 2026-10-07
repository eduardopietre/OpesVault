/**
 * "Aprovar alteração" (desktop `ApprovalDialog` in `ui/local_ai.py`): one change the assistant wants to make,
 * described by the domain exactly as it will happen. Aprovar runs it (the page applies it as one undo step);
 * Recusar, Esc and the corner "×" refuse, and the model is told. Nothing changes before Aprovar. A project open
 * for reading only cannot approve.
 */
import { Button, Dialog } from "@opesvault/ui";
import { ShieldCheck } from "lucide-react";
import { useWorkspace } from "../data/react.tsx";
import { READ_ONLY_TIP } from "../data/read_only.ts";

export interface AssistantApprovalProps {
  open: boolean;
  summary: string;
  details: readonly string[];
  /** The model that proposed it (`gemma4:12b`). */
  model: string;
  onApprove: () => void;
  onRefuse: () => void;
}

export function AssistantApproval({ open, summary, details, model, onApprove, onRefuse }: AssistantApprovalProps) {
  const readOnly = useWorkspace().readOnly;
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onRefuse();
      }}
      title="Aprovar alteração"
      size="md"
      footer={
        <>
          {/* Focus starts on Recusar: a key typed into the question box must never approve a change. */}
          <Button onClick={onRefuse} data-autofocus="">
            Recusar
          </Button>
          <Button
            variant="primary"
            onClick={onApprove}
            disabled={readOnly}
            title={readOnly ? READ_ONLY_TIP : undefined}
          >
            Aprovar
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <p className="text-body font-semibold text-text">{summary}</p>
        {details.length ? (
          <ul aria-label="O que muda" className="flex flex-col gap-1.5 rounded-lg bg-sunken px-3 py-2.5">
            {details.map((line, index) => (
              <li key={index} className="text-body break-words text-secondary">
                {line}
              </li>
            ))}
          </ul>
        ) : null}
        <p className="flex items-start gap-2 text-caption text-secondary">
          <ShieldCheck aria-hidden="true" className="mt-px size-4 shrink-0" />
          <span>
            Proposta pelo assistente (IA local, {model}). Nada muda se você recusar; ao aprovar, a alteração pode ser
            desfeita com Ctrl+Z.
            {readOnly ? ` ${READ_ONLY_TIP} Só é possível recusar.` : ""}
          </span>
        </p>
      </div>
    </Dialog>
  );
}
