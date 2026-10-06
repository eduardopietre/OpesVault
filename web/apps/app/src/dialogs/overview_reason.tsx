/**
 * The reason asked to close a month with pending items, or to reopen a closed one (desktop `ask_reason`):
 * required, and kept in the history. The error shows inside the dialog.
 */
import { Button, Dialog, TextField } from "@opesvault/ui";
import { useState, type ReactNode } from "react";

export interface OverviewReasonDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  /** What the user is deciding (the pending items, the consequence of reopening). */
  description?: ReactNode;
  label: string;
  confirmLabel: string;
  onConfirm: (reason: string) => void;
}

export function OverviewReasonDialog(props: OverviewReasonDialogProps) {
  const { open, onOpenChange, title, description, label, confirmLabel, onConfirm } = props;
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const change = (next: boolean) => {
    // Each opening starts with an empty field and no error.
    setReason("");
    setError(null);
    onOpenChange(next);
  };
  return (
    <Dialog
      open={open}
      onOpenChange={change}
      title={title}
      description={description}
      size="sm"
      onSubmit={() => {
        const text = reason.trim();
        if (!text) {
          setError("O motivo é obrigatório.");
          return;
        }
        onConfirm(text);
        change(false);
      }}
      footer={
        <>
          <Button onClick={() => change(false)}>Cancelar</Button>
          <Button type="submit" variant="primary">
            {confirmLabel}
          </Button>
        </>
      }
    >
      <TextField
        label={label}
        value={reason}
        onChange={(value) => {
          setReason(value);
          setError(null);
        }}
        error={error}
        maxLength={1000}
        data-autofocus=""
        autoComplete="off"
      />
    </Dialog>
  );
}
