/**
 * The frame the Configurações dialogs share (desktop `ui/dialogs.py` `FormDialog`, for what goes through the
 * services instead of the ledger): fields, an inline error line, Cancel and the verb. A refused request (a
 * `ServiceError`, always Portuguese and saying what to do) stays next to the form; the dialog closes only when
 * the action went through. Nothing typed here is kept: each dialog clears its fields when it closes.
 */
import { Button, Dialog, notify } from "@opesvault/ui";
import { Copy } from "lucide-react";
import { useState, type ReactNode } from "react";
import { ServiceError } from "../services/types.ts";

export interface SettingsDialogProps {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: ReactNode;
  confirmLabel: string;
  /** Does the work; a `ServiceError` is shown inline and keeps the dialog open. */
  onConfirm: () => void | Promise<void>;
  confirmDisabled?: boolean;
  size?: "sm" | "md" | "lg";
  /** No Cancel (and no close button, no Esc): used while something must not be skipped. */
  required?: boolean;
  /** Replaces the "Cancelar" label (a result dialog closes with "Fechar"). */
  cancelLabel?: string;
  /** A result dialog has only the close button. */
  closeOnly?: boolean;
  /** Extra buttons before Cancel. */
  extraActions?: ReactNode;
  children?: ReactNode;
  /** Shown while the work runs (it replaces the buttons' meaning, the confirm button spins). */
  busyText?: string | null;
}

export function messageOfFailure(failure: unknown): string {
  return failure instanceof ServiceError ? failure.message : "Algo deu errado. Tente de novo.";
}

export function SettingsDialog({
  open,
  onClose,
  title,
  description,
  confirmLabel,
  onConfirm,
  confirmDisabled,
  size = "md",
  required,
  cancelLabel = "Cancelar",
  closeOnly,
  extraActions,
  children,
  busyText,
}: SettingsDialogProps) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setError(null);
    setBusy(true);
    try {
      await onConfirm();
    } catch (failure) {
      setError(messageOfFailure(failure));
    } finally {
      setBusy(false);
    }
  };
  const close = () => {
    if (busy) return;
    setError(null);
    onClose();
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) close();
      }}
      title={title}
      description={description}
      size={size}
      dismissable={!required}
      hideClose={required || closeOnly || false}
      onSubmit={() => void submit()}
      footer={
        <>
          {extraActions}
          {required || closeOnly ? null : (
            <Button onClick={close} disabled={busy}>
              {cancelLabel}
            </Button>
          )}
          <Button
            variant="primary"
            type={closeOnly ? "button" : "submit"}
            {...(closeOnly ? { onClick: close } : {})}
            busy={busy}
            disabled={confirmDisabled ?? false}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {children}
        {busy && busyText ? (
          <p role="status" className="rounded-md bg-window px-3 py-2 text-body text-secondary">
            {busyText}
          </p>
        ) : null}
        {error ? (
          <p role="alert" className="rounded-md bg-negative-soft px-3 py-2 text-body font-medium text-negative">
            <span className="sr-only">Erro: </span>
            {error}
          </p>
        ) : null}
      </div>
    </Dialog>
  );
}

/** Puts a recovery key on the clipboard and says to clean it afterwards. */
export function copyKey(text: string): void {
  void navigator.clipboard
    ?.writeText(text)
    .then(() => notify("Chave copiada. Cole num lugar seguro e limpe a área de transferência."))
    .catch(() => notify("Não foi possível copiar. Anote a chave.", { tone: "warning" }));
}

/**
 * A recovery key as the person writes it down: groups of four, once. "Copiar chave" puts it on the clipboard
 * (and says to clean it afterwards); nothing else keeps it.
 */
export function RecoveryKeyBox({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <output
        aria-label={label}
        className="grid grid-cols-3 gap-2 rounded-lg border border-separator bg-window p-4 font-mono text-headline tracking-wider"
      >
        {value.split("-").map((group, index) => (
          <span key={index} className="text-center">
            {group}
          </span>
        ))}
      </output>
      <div className="mt-2 flex justify-end">
        <Button size="sm" icon={<Copy className="size-3.5" />} onClick={() => copyKey(value)}>
          Copiar chave
        </Button>
      </div>
    </div>
  );
}
