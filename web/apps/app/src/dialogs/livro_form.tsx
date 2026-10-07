/**
 * The frame every form dialog shares (desktop `ui/dialogs.py` `FormDialog`): fields, an inline error line and
 * Cancel / <verb> buttons. A refused change (a `DomainError`) is shown next to the form, so the person fixes
 * it without losing context; the dialog closes only when the action went through. Plus the readers that turn
 * what was typed into domain values that belong to these forms (optional dates, the competence month); the
 * plain readers are in `form_readers.ts`.
 */
import {
  DomainError,
  today,
  type IsoDate,
  type Ledger,
  type YearMonth,
  type session as sessions,
  ymAdd,
  ymEq,
  ymOf,
  ymParse,
  ymStr,
} from "@opesvault/domain";
import { Button, Checkbox, DateField, Dialog, type SelectOption } from "@opesvault/ui";
import { useCallback, useState, type ReactNode } from "react";
import { useWorkspace } from "../data/react.tsx";
import { READ_ONLY_TIP } from "../data/read_only.ts";
import { dateText, readDate } from "./form_readers.ts";
import { memberItems } from "./account_choices.ts";
import { monthLabel } from "../data/text.ts";

type Session = sessions.Session;

export interface FormDialogProps {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: ReactNode;
  confirmLabel?: string;
  /** A dialog that only lists and edits in place closes with one button, no "Cancelar". */
  closeOnly?: boolean;
  size?: "sm" | "md" | "lg";
  children: ReactNode;
  /** Validates and applies. Throw a `DomainError` to show it inline and keep the dialog open. */
  onConfirm?: () => void | Promise<void>;
  confirmDisabled?: boolean;
  /** Extra buttons before Cancel (the postings editor's "Corrigir partidas…" shortcut and the like). */
  extraActions?: ReactNode;
}

export function FormDialog({
  open,
  onClose,
  title,
  description,
  confirmLabel = "Salvar",
  closeOnly,
  size = "md",
  children,
  onConfirm,
  confirmDisabled,
  extraActions,
}: FormDialogProps) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const readOnly = useWorkspace().readOnly;
  const submit = async () => {
    if (closeOnly || !onConfirm) {
      onClose();
      return;
    }
    setError(null);
    setBusy(true);
    try {
      await onConfirm();
      onClose();
    } catch (cause) {
      if (cause instanceof DomainError) setError(cause.message);
      else throw cause;
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title={title}
      description={description}
      size={size}
      onSubmit={() => void submit()}
      footer={
        <>
          {extraActions}
          {closeOnly ? null : <Button onClick={onClose}>Cancelar</Button>}
          <Button
            variant="primary"
            type="submit"
            busy={busy}
            disabled={(!closeOnly && (readOnly || confirmDisabled)) || false}
            title={!closeOnly && readOnly ? READ_ONLY_TIP : undefined}
          >
            {closeOnly ? "Fechar" : confirmLabel}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {children}
        {error ? (
          <p role="alert" className="rounded-md bg-negative-soft px-3 py-2 text-body font-medium text-negative">
            <span className="sr-only">Erro no formulário: </span>
            {error}
          </p>
        ) : null}
      </div>
    </Dialog>
  );
}

/**
 * Runs the dialog's change as one user action (one undo step, one sync). A refused change is rethrown for
 * `FormDialog` to show inline, instead of a notice that would hide behind the dialog.
 */
export function useFormAct(): <T>(action: (ledger: Ledger, session: Session) => T, label?: string) => T {
  const workspace = useWorkspace();
  return useCallback(
    <T,>(action: (ledger: Ledger, session: Session) => T, label?: string) => workspace.act(action, label),
    [workspace],
  );
}

/** A responsive grid of fields: one column on phones, two from the dialog's own width. */
export function FormGrid({ children, columns = 2 }: { children: ReactNode; columns?: 1 | 2 }) {
  return (
    <div className={columns === 2 ? "grid grid-cols-1 gap-x-4 gap-y-3 tablet:grid-cols-2" : "flex flex-col gap-3"}>
      {children}
    </div>
  );
}

/** The whole row of a form grid. */
export function FullRow({ children }: { children: ReactNode }) {
  return <div className="min-w-0 tablet:col-span-2">{children}</div>;
}

export function Caption({ children }: { children: ReactNode }) {
  return <p className="text-caption text-secondary">{children}</p>;
}

// ── readers ─────────────────────────────────────

// ── choices ─────────────────────────────────────

/** Value of a Select that stands for "none" (the project, no member, the month of the date…). */
export const NONE = "__none";

/** "Mês da data" and the months around `around` (two years each way), plus `value` when outside. */
export function competenceOptions(value: YearMonth | null, around: IsoDate): SelectOption[] {
  const center = ymOf(around);
  const months: YearMonth[] = [];
  for (let offset = -24; offset <= 24; offset++) months.push(ymAdd(center, offset));
  if (value !== null && !months.some((m) => ymEq(m, value))) {
    months.push(value);
    months.sort((a, b) => a.year * 12 + a.month - (b.year * 12 + b.month));
  }
  return [{ id: NONE, label: "Mês da data" }, ...months.map((m) => ({ id: ymStr(m), label: monthLabel(m) }))];
}

export function competenceFromChoice(id: string): YearMonth | null {
  return id === NONE ? null : ymParse(id);
}

export function competenceChoice(value: YearMonth | null): string {
  return value === null ? NONE : ymStr(value);
}

/** Members people can pick: the active ones, and `keep` even if it was deactivated. */
export function memberOptions(ledger: Ledger, keep: string | null = null, none = "(projeto)"): SelectOption[] {
  return [{ id: NONE, label: none }, ...memberItems(ledger, keep)];
}

export function memberFromChoice(id: string): string | null {
  return id === NONE ? null : id;
}

/** A date that may stay unknown (docs/04 §5): unchecked means null, never today. */
export interface OptionalDateValue {
  known: boolean;
  text: string;
}

export function optionalDateValue(date: IsoDate | null): OptionalDateValue {
  return { known: date !== null, text: dateText(date) };
}

export function readOptionalDate(value: OptionalDateValue, name: string): IsoDate | null {
  return value.known ? readDate(value.text, name) : null;
}

export function OptionalDateField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: OptionalDateValue;
  onChange: (value: OptionalDateValue) => void;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <DateField
        label={label}
        value={value.text}
        disabled={!value.known}
        onChange={(text) => onChange({ ...value, text })}
        placeholder={value.known ? "dd/mm/aaaa" : "não informada"}
      />
      <Checkbox
        label={
          <span className="text-caption">
            <span className="sr-only">{label}: </span>informada
          </span>
        }
        checked={value.known}
        onCheckedChange={(known) => onChange({ known, text: known && !value.text ? dateText(today()) : value.text })}
      />
    </div>
  );
}
