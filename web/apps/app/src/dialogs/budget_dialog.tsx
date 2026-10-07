/**
 * Orçamento de uma categoria (desktop `BudgetDialog`): the category and the amount planned for the month.
 * A category given by the caller is fixed (editing a line); without one the user chooses it.
 */
import type { Dec } from "@opesvault/domain";
import { Button, Dialog, MoneyField, Select, type SelectOption } from "@opesvault/ui";
import { useState } from "react";
import { readAmount } from "./form_readers.ts";

export interface BudgetDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** "outubro de 2026". */
  monthLabel: string;
  options: readonly SelectOption[];
  /** The category being edited; the choice is then locked. */
  categoryId: string | null;
  /** The amount as typed ("2.350,00"), empty for a new line. */
  initialAmount: string;
  /** Saves and says whether it worked (the page shows the domain's refusal itself). */
  onSave: (categoryId: string, amount: Dec) => boolean;
}

/** Mounted with a fresh `key` for each opening, so the fields start from the given values. */
export function BudgetDialog({
  open,
  onOpenChange,
  monthLabel,
  options,
  categoryId,
  initialAmount,
  onSave,
}: BudgetDialogProps) {
  const [category, setCategory] = useState<string | null>(categoryId);
  const [amount, setAmount] = useState(initialAmount);
  const [error, setError] = useState<{ field: "category" | "amount"; message: string } | null>(null);

  const submit = () => {
    if (category === null) {
      setError({ field: "category", message: "Escolha a categoria." });
      return;
    }
    const value = readAmount(amount);
    if (value === null || !value.isPositive()) {
      setError({ field: "amount", message: "Informe um valor positivo." });
      return;
    }
    setError(null);
    if (onSave(category, value)) onOpenChange(false);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={`Orçamento de ${monthLabel}`}
      description="Quanto planeja gastar nesta categoria no mês. O gasto segue a competência."
      size="sm"
      onSubmit={submit}
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancelar</Button>
          <Button variant="primary" type="submit">
            Salvar
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Select
          label="Categoria"
          options={options}
          value={category}
          onChange={(id) => {
            setCategory(id);
            setError(null);
          }}
          disabled={categoryId !== null}
          placeholder="Escolha a categoria"
          error={error?.field === "category" ? error.message : null}
        />
        <MoneyField
          label="Planejado para o mês"
          value={amount}
          onChange={(text) => {
            setAmount(text);
            setError(null);
          }}
          error={error?.field === "amount" ? error.message : null}
          data-autofocus=""
        />
      </div>
    </Dialog>
  );
}
