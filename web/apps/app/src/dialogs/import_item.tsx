/**
 * Corrigir item (desktop `ItemDialog` of the import review): description, amount and date of an extracted item,
 * with the reason of the correction. The old value, the new one, who corrected and why stay with the item
 * (docs/05 §4). A date or an amount left unknown stays unknown: it is never turned into zero or today.
 */
import { Dec, DomainError, importing } from "@opesvault/domain";
import { MoneyField, TextField } from "@opesvault/ui";
import { useState } from "react";
import {
  Caption,
  FormDialog,
  FormGrid,
  FullRow,
  OptionalDateField,
  optionalDateValue,
  readOptionalDate,
  useFormAct,
} from "./livro_form.tsx";
import { editableMoney, readMoney } from "./form_readers.ts";

type Item = importing.importModel.ExtractedItem;

export interface ImportItemDialogProps {
  open: boolean;
  onClose: () => void;
  item: Item;
  onDone?: (changedFields: number) => void;
}

export function ImportItemDialog({ open, onClose, item, onDone }: ImportItemDialogProps) {
  const act = useFormAct();
  const [description, setDescription] = useState(item.description);
  const [amount, setAmount] = useState(item.amount === null ? "" : editableMoney(item.amount));
  const [when, setWhen] = useState(optionalDateValue(item.occurred_on));
  const [reason, setReason] = useState("");

  const confirm = () => {
    const newAmount: Dec | null = readMoney(amount, { allowEmpty: true });
    if (newAmount !== null && newAmount.isNegative()) {
      throw new DomainError("Informe o valor sem sinal; o tipo indica a direção.");
    }
    const newDate = readOptionalDate(when, "A data");
    const newDescription = description.trim();
    if (!newDescription) throw new DomainError("Informe a descrição.");
    if (!reason.trim()) throw new DomainError("Informe o motivo da correção.");
    const because = reason.trim();
    const changes = act((ledger) => {
      let changed = 0;
      const fields: [string, unknown, unknown][] = [
        ["description", newDescription, item.description],
        ["amount", newAmount, item.amount],
        ["occurred_on", newDate, item.occurred_on],
      ];
      for (const [field, value, before] of fields) {
        const same = Dec.isDec(value) && Dec.isDec(before) ? value.eq(before) : value === before;
        if (same) continue;
        importing.pipeline.correctItem(ledger, item.id, field, value, because);
        changed += 1;
      }
      if (!changed) throw new DomainError("Nenhum campo foi alterado.");
      return changed;
    });
    onDone?.(changes);
  };

  return (
    <FormDialog open={open} onClose={onClose} title="Corrigir item" confirmLabel="Corrigir" onConfirm={confirm}>
      <FormGrid>
        <FullRow>
          <TextField
            label="Descrição"
            value={description}
            onChange={setDescription}
            autoComplete="off"
            data-autofocus=""
            required
          />
        </FullRow>
        <MoneyField label="Valor" value={amount} onChange={setAmount} hint="Sem sinal; o tipo indica a direção." />
        <OptionalDateField label="Data" value={when} onChange={setWhen} />
        <FullRow>
          <TextField
            label="Motivo"
            value={reason}
            onChange={setReason}
            placeholder="obrigatório; fica com o item"
            autoComplete="off"
            required
          />
        </FullRow>
        <FullRow>
          <Caption>O valor e a data antigos, o novo e o motivo ficam registrados no item.</Caption>
        </FullRow>
      </FormGrid>
    </FormDialog>
  );
}
