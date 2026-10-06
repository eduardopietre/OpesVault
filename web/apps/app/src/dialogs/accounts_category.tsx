/** Categoria (desktop `CategoryDialog`): a new income or expense category, optionally inside another. */
import { AccountSubtype, AccountType, DomainError, LedgerAccountSchema, type LedgerAccount } from "@opesvault/domain";
import { Select, TextField } from "@opesvault/ui";
import { useState } from "react";
import { useWorkspace } from "../data/react.tsx";
import { categoryItems } from "./account_choices.ts";
import { FormDialog, FormGrid, FullRow, NONE, useFormAct } from "./livro_form.tsx";

export interface CategoryDialogProps {
  open: boolean;
  onClose: () => void;
  onDone?: (category: LedgerAccount) => void;
}

const KINDS = [
  { id: AccountType.EXPENSE, label: "Despesa" },
  { id: AccountType.INCOME, label: "Receita" },
];

export function CategoryDialog({ open, onClose, onDone }: CategoryDialogProps) {
  const ledger = useWorkspace().ledger;
  const act = useFormAct();
  const [name, setName] = useState("");
  const [kind, setKind] = useState<string>(AccountType.EXPENSE);
  const [parent, setParent] = useState<string>(NONE);

  const confirm = () => {
    const title = name.trim();
    if (!title) throw new DomainError("Informe o nome.");
    const created = act((l) =>
      l.addAccount(
        LedgerAccountSchema.parse({
          name: title,
          type: kind as AccountType,
          subtype: AccountSubtype.CATEGORY,
          parent_id: parent === NONE ? null : parent,
        }),
      ),
    );
    onDone?.(created);
  };

  return (
    <FormDialog
      open={open}
      onClose={onClose}
      title="Nova categoria"
      confirmLabel="Criar categoria"
      size="sm"
      onConfirm={confirm}
    >
      <FormGrid columns={1}>
        <TextField
          label="Nome"
          value={name}
          onChange={setName}
          maxLength={120}
          autoComplete="off"
          data-autofocus=""
          required
        />
        <Select
          label="Tipo"
          options={KINDS}
          value={kind}
          onChange={(next) => {
            setKind(next);
            setParent(NONE);
          }}
        />
        <FullRow>
          <Select
            label="Dentro de"
            options={[{ id: NONE, label: "(nenhuma)" }, ...categoryItems(ledger, kind as AccountType)]}
            value={parent}
            onChange={setParent}
          />
        </FullRow>
      </FormGrid>
    </FormDialog>
  );
}
