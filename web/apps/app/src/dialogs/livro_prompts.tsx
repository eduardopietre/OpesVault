/**
 * The small questions the Livro asks in a dialog (desktop `QInputDialog`s): the reason of a cancellation or a
 * reversal (kept in the history), the name of a merchant and the name of a saved filter. Each is one field
 * and one verb.
 */
import { DomainError } from "@opesvault/domain";
import { TextField } from "@opesvault/ui";
import { useState, type ReactNode } from "react";
import { Caption, FormDialog } from "./livro_form.tsx";

export interface TextPromptDialogProps {
  open: boolean;
  onClose: () => void;
  title: string;
  label: string;
  confirmLabel: string;
  description?: ReactNode;
  hint?: string;
  initial?: string;
  placeholder?: string;
  /** What to show when the field is empty (default: "Preencha o campo."). */
  emptyMessage?: string;
  /** Called with the trimmed text; may throw a `DomainError` to keep the dialog open. */
  onSubmit: (text: string) => void | Promise<void>;
}

export function TextPromptDialog({
  open,
  onClose,
  title,
  label,
  confirmLabel,
  description,
  hint,
  initial = "",
  placeholder,
  emptyMessage = "Preencha o campo.",
  onSubmit,
}: TextPromptDialogProps) {
  const [text, setText] = useState(initial);
  return (
    <FormDialog
      open={open}
      onClose={onClose}
      title={title}
      confirmLabel={confirmLabel}
      size="sm"
      onConfirm={() => {
        if (!text.trim()) throw new DomainError(emptyMessage);
        return onSubmit(text.trim());
      }}
    >
      <div className="flex flex-col gap-3">
        {description ? <Caption>{description}</Caption> : null}
        <TextField
          label={label}
          value={text}
          onChange={setText}
          hint={hint}
          placeholder={placeholder}
          autoComplete="off"
          required
        />
      </div>
    </FormDialog>
  );
}

/** "Motivo (fica no histórico)": cancel and reverse. */
export function ReasonDialog({
  open,
  onClose,
  title,
  confirmLabel,
  description,
  onSubmit,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  confirmLabel: string;
  description?: ReactNode;
  onSubmit: (reason: string) => void | Promise<void>;
}) {
  return (
    <TextPromptDialog
      open={open}
      onClose={onClose}
      title={title}
      label="Motivo"
      hint="Fica no histórico."
      confirmLabel={confirmLabel}
      emptyMessage="O motivo é obrigatório."
      {...(description ? { description } : {})}
      onSubmit={onSubmit}
    />
  );
}
