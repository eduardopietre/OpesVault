/**
 * Categoria (desktop `CategoryDialog`): a new income or expense category, optionally inside another; renaming
 * one; and choosing the category another merges into (the page confirms the merge with what it moves).
 */
import {
  AccountSubtype,
  AccountType,
  DomainError,
  LedgerAccountSchema,
  dom,
  type Id,
  type LedgerAccount,
  ymBr,
} from "@opesvault/domain";
import { Select, TextField } from "@opesvault/ui";
import { useMemo, useState } from "react";
import { useWorkspace } from "../data/react.tsx";
import { mergeTargets } from "../pages/contas/rows.ts";
import { categoryItems } from "./account_choices.ts";
import { Caption, FormDialog, FormGrid, FullRow, NONE, useFormAct } from "./livro_form.tsx";

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

export interface RenameCategoryDialogProps {
  open: boolean;
  onClose: () => void;
  category: LedgerAccount;
  onDone?: (category: LedgerAccount) => void;
}

/** Renomear categoria: the new name of one category; its entries, budgets and rules follow it (they keep its id). */
export function RenameCategoryDialog({ open, onClose, category, onDone }: RenameCategoryDialogProps) {
  const act = useFormAct();
  const [name, setName] = useState(category.name);

  const confirm = () => {
    const renamed = act((l) => dom.categories.renameCategory(l, category.id, name), "renomear categoria");
    onDone?.(renamed);
  };

  return (
    <FormDialog
      open={open}
      onClose={onClose}
      title="Renomear categoria"
      description={`Lançamentos, orçamentos e regras de “${category.name}” continuam ligados a ela com o novo nome.`}
      confirmLabel="Renomear"
      size="sm"
      onConfirm={confirm}
    >
      <TextField
        label="Nome"
        value={name}
        onChange={setName}
        maxLength={120}
        autoComplete="off"
        data-autofocus=""
        required
      />
    </FormDialog>
  );
}

export interface MergeCategoryDialogProps {
  open: boolean;
  onClose: () => void;
  /** The category that disappears into the chosen one. */
  category: LedgerAccount;
  /** Called with the chosen target after the domain accepted the merge; the page confirms and runs it. */
  onChoose: (targetId: Id) => void;
}

/**
 * Mesclar categoria: chooses the category this one merges into. Nothing changes here: the page then asks for
 * confirmation, saying how many entries move, and runs the merge as one action.
 */
export function MergeCategoryDialog({ open, onClose, category, onChoose }: MergeCategoryDialogProps) {
  const ledger = useWorkspace().ledger;
  const options = useMemo(() => mergeTargets(ledger, category.id), [ledger, category.id]);
  const [target, setTarget] = useState<string | null>(null);

  const confirm = () => {
    if (target === null) throw new DomainError("Escolha a categoria de destino.");
    const preview = dom.categories.previewMerge(ledger, category.id, target);
    if (preview.closedMonths.length) {
      const months = preview.closedMonths.map(ymBr).join(", ");
      throw new DomainError(
        `Há lançamentos de “${category.name}” em mês fechado (${months}). Reabra-o antes de mesclar.`,
      );
    }
    onChoose(target);
  };

  return (
    <FormDialog
      open={open}
      onClose={onClose}
      title={`Mesclar “${category.name}”`}
      description="Tudo o que usa esta categoria passa para a escolhida: lançamentos, subcategorias, orçamentos, recorrências e regras. Depois ela fica arquivada."
      confirmLabel="Continuar…"
      size="sm"
      onConfirm={confirm}
    >
      {options.length ? (
        <Select
          label="Mesclar em"
          options={options}
          value={target}
          onChange={setTarget}
          placeholder="Escolha a categoria"
        />
      ) : (
        <Caption>Não há outra categoria do mesmo tipo para receber esta.</Caption>
      )}
    </FormDialog>
  );
}
