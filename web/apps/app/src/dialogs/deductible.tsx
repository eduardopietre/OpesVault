/**
 * Despesa dedutível (desktop `DeductibleDialog`): marks an expense category as deductible for the annual
 * return. Only a mark and a kind: legal limits are never applied (docs/00 §5).
 */
import { dom, type Id } from "@opesvault/domain";
import { Select } from "@opesvault/ui";
import { useMemo, useState } from "react";
import { useWorkspace } from "../data/react.tsx";
import { Caption, FormDialog, NONE, useFormAct } from "./livro_form.tsx";

export interface DeductibleDialogProps {
  open: boolean;
  onClose: () => void;
  categoryId: Id;
  onDone?: (kind: dom.deductibles.DeductibleKind | null) => void;
}

export function DeductibleDialog({ open, onClose, categoryId, onDone }: DeductibleDialogProps) {
  const ledger = useWorkspace().ledger;
  const act = useFormAct();
  const category = ledger.account(categoryId);
  const own = useMemo(
    () => [...dom.deductibles.marks(ledger).values()].find((m) => m.category_id === categoryId)?.kind ?? null,
    [ledger, categoryId],
  );
  const inherited = own === null ? dom.deductibles.kindOf(ledger, categoryId) : null;
  const [kind, setKind] = useState<string>(own ?? NONE);

  const confirm = () => {
    const chosen = kind === NONE ? null : (kind as dom.deductibles.DeductibleKind);
    act((l) => dom.deductibles.mark(l, categoryId, chosen));
    onDone?.(chosen);
  };

  return (
    <FormDialog
      open={open}
      onClose={onClose}
      title={`Despesa dedutível — ${category.name}`}
      confirmLabel="Salvar"
      onConfirm={confirm}
    >
      <div className="flex flex-col gap-4">
        <Select
          label="Tipo de dedução"
          options={[
            { id: NONE, label: "Não é dedutível" },
            ...Object.entries(dom.deductibles.KIND_LABELS).map(([id, label]) => ({ id, label })),
          ]}
          value={kind}
          onChange={setKind}
        />
        {inherited !== null ? (
          <Caption>Já dedutível pela categoria-mãe ({dom.deductibles.KIND_LABELS[inherited]}).</Caption>
        ) : null}
        <Caption>
          Despesas destas categorias aparecem em Relatórios › Despesas dedutíveis, por pessoa, como apoio à declaração
          anual. Limites legais não são aplicados.
        </Caption>
      </div>
    </FormDialog>
  );
}
