/**
 * The Planejado cell of Orçamento, edited in place: Enter or a double click on the row (or a click on the
 * value) opens a field in the cell; Enter saves, Esc cancels and leaving the field cancels too, so nothing is
 * saved by accident. The keys typed in the field stay in it (the table's own keys do not move the selection),
 * and the focus goes back to the table afterwards.
 */
import { DomainError, formatBrl, type Dec } from "@opesvault/domain";
import { cn, inputClass, notify } from "@opesvault/ui";
import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { editableMoney, readMoney } from "../../dialogs/form_readers.ts";

export interface PlannedCellProps {
  /** The category's name, for the field's accessible name. */
  name: string;
  planned: Dec;
  editing: boolean;
  /** Read-only project: the value is plain text. */
  locked: boolean;
  onStart: () => void;
  /** Saves the typed value; false keeps the field open (the domain refused it and said why). */
  onSave: (amount: Dec) => boolean;
  onCancel: () => void;
}

/** Back to the table the cell belongs to, so the arrows keep working after the edit. */
function focusTable(from: HTMLElement | null): void {
  const grid = from?.closest<HTMLElement>('[role="grid"], [role="listbox"]');
  grid?.focus({ preventScroll: true });
}

export function PlannedCell({ name, planned, editing, locked, onStart, onSave, onCancel }: PlannedCellProps) {
  if (editing && !locked) return <PlannedField name={name} planned={planned} onSave={onSave} onCancel={onCancel} />;
  if (locked) return <span className="money">{formatBrl(planned)}</span>;
  // A click on the value is a mouse shortcut, not a control of its own: inside a row (or a card, an option of a
  // list) a nested button would be a second stop for assistive technology. The keyboard way is Enter on the row.
  return (
    <span
      data-planned-cell=""
      className="money cursor-text rounded-sm underline decoration-separator-strong decoration-dotted underline-offset-4 hover:decoration-text"
      title="Clique para alterar aqui (Enter salva, Esc cancela)"
      onClick={(event) => {
        event.stopPropagation();
        onStart();
      }}
    >
      {formatBrl(planned)}
    </span>
  );
}

/** The field itself: mounted when the edit starts, so it starts from the planned value with the text selected. */
function PlannedField({
  name,
  planned,
  onSave,
  onCancel,
}: Pick<PlannedCellProps, "name" | "planned" | "onSave" | "onCancel">) {
  const [text, setText] = useState(() => (planned.isZero() ? "" : editableMoney(planned)));
  const input = useRef<HTMLInputElement>(null);
  const hint = useId();

  useEffect(() => {
    const field = input.current;
    field?.focus({ preventScroll: true });
    field?.select();
  }, []);

  const finish = (save: boolean) => {
    const field = input.current;
    if (!save) {
      onCancel();
      focusTable(field);
      return;
    }
    let amount: Dec;
    try {
      amount = readMoney(text);
    } catch (error) {
      if (!(error instanceof DomainError)) throw error;
      notify(error.message, { tone: "negative" });
      return;
    }
    if (amount.eq(planned)) {
      onCancel();
      focusTable(field);
      return;
    }
    if (onSave(amount)) focusTable(field);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    // The field keeps its keys: the table's arrows, Enter and the shortcuts of the page do not see them.
    event.stopPropagation();
    if (event.key === "Enter") {
      event.preventDefault();
      finish(true);
    } else if (event.key === "Escape") {
      event.preventDefault();
      finish(false);
    }
  };

  return (
    <>
      <input
        ref={input}
        type="text"
        inputMode="decimal"
        autoComplete="off"
        aria-label={`Planejado de ${name}`}
        aria-describedby={hint}
        className={cn(inputClass, "h-7 w-28 px-2 text-right tabular-nums")}
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={onKeyDown}
        onClick={(event) => event.stopPropagation()}
        onDoubleClick={(event) => event.stopPropagation()}
        onBlur={() => onCancel()}
      />
      <span id={hint} className="sr-only">
        Enter salva, Esc cancela.
      </span>
    </>
  );
}
