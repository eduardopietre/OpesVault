/**
 * Reclassificar lançamentos (desktop `pages/ledger/actions.py` `ReclassifyDialog`): moves the category of the
 * selected operations to another one, with a reason kept in each one's history. A split with more than one
 * category stays as it is.
 */
import { AccountType, DomainError, edits, type Id } from "@opesvault/domain";
import { Select, TextField, type SelectOption } from "@opesvault/ui";
import { useMemo, useState } from "react";
import { useWorkspace } from "../data/react.tsx";
import { categoryItems } from "./account_choices.ts";
import { Caption, FormDialog, useFormAct } from "./livro_form.tsx";
import { actionName } from "../data/action_names.ts";

export interface ReclassifyDialogProps {
  open: boolean;
  onClose: () => void;
  /** The operations to move. */
  operationIds: readonly Id[];
  onDone?: (result: edits.BulkResult) => void;
}

export function ReclassifyDialog({ open, onClose, operationIds, onDone }: ReclassifyDialogProps) {
  const ledger = useWorkspace().ledger;
  const act = useFormAct();
  const options = useMemo<SelectOption[]>(
    () => [
      ...categoryItems(ledger, AccountType.EXPENSE).map((o) => ({ ...o, label: `Despesa: ${o.label}` })),
      ...categoryItems(ledger, AccountType.INCOME).map((o) => ({ ...o, label: `Receita: ${o.label}` })),
    ],
    [ledger],
  );
  const [target, setTarget] = useState<string | null>(null);
  const [reason, setReason] = useState("");

  const confirm = () => {
    if (target === null) throw new DomainError("Escolha a categoria de destino.");
    if (!reason.trim()) throw new DomainError("O motivo é obrigatório.");
    const result = act(
      (l) => edits.reclassify(l, operationIds, target, reason.trim()),
      actionName("reclassificar", operationIds.length, "lançamento", "lançamentos"),
    );
    onDone?.(result);
  };

  return (
    <FormDialog
      open={open}
      onClose={onClose}
      title="Reclassificar lançamentos"
      confirmLabel="Reclassificar"
      onConfirm={confirm}
    >
      <div className="flex flex-col gap-4">
        <Caption>
          {operationIds.length} lançamento(s) selecionado(s). Rateios com mais de uma categoria ficam como estão.
        </Caption>
        <Select label="Nova categoria" options={options} value={target} onChange={setTarget} />
        <TextField
          label="Motivo"
          value={reason}
          onChange={setReason}
          hint="Obrigatório; fica no histórico."
          autoComplete="off"
          required
        />
      </div>
    </FormDialog>
  );
}
