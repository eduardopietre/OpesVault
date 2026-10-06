/**
 * O orçamento do mês numa grade (desktop `BudgetGridDialog`): every expense category with its plan, this
 * month's spending and last month's plan beside it. Empty means no plan for that category. One dialog,
 * one undo step.
 */
import { formatBrl } from "@opesvault/domain";
import { Button, MoneyField, Dialog, notify } from "@opesvault/ui";
import { useRef, useState } from "react";
import { fillFromPrevious, parseGrid, type GridChange, type GridRow } from "./budget_logic.ts";

export interface BudgetGridDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  monthLabel: string;
  previousLabel: string;
  rows: readonly GridRow[];
  /** Writes the differences and says whether it worked. */
  onSave: (changes: readonly GridChange[]) => boolean;
}

const COLUMNS = "grid-cols-[minmax(0,1fr)_9.5rem] tablet:grid-cols-[minmax(0,1fr)_9.5rem_7.5rem_7.5rem]";

const money = (value: Parameters<typeof formatBrl>[0] | null) => (value === null ? "—" : formatBrl(value));

/** Mounted with a fresh `key` for each opening. */
export function BudgetGridDialog({
  open,
  onOpenChange,
  monthLabel,
  previousLabel,
  rows,
  onSave,
}: BudgetGridDialogProps) {
  const [texts, setTexts] = useState<Record<string, string>>(() =>
    Object.fromEntries(rows.map((row) => [row.categoryId, row.text])),
  );
  const [error, setError] = useState<string | null>(null);
  const inputs = useRef(new Map<string, HTMLInputElement>());

  const copyPrevious = () => {
    const next = fillFromPrevious(rows, texts);
    const filled = Object.keys(next).filter((id) => next[id] !== texts[id]).length;
    if (filled === 0) {
      notify(`Nada a copiar: ${previousLabel} não tem orçamento, ou os campos já estão preenchidos.`);
      return;
    }
    setTexts(next);
    setError(null);
  };

  const submit = () => {
    const parsed = parseGrid(rows, texts);
    if (!parsed.ok) {
      setError(parsed.error);
      inputs.current.get(parsed.categoryId)?.focus();
      return;
    }
    setError(null);
    if (onSave(parsed.changes)) onOpenChange(false);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={`Orçamento de ${monthLabel}`}
      description="Quanto planeja gastar em cada categoria. Deixe vazio o que não quer acompanhar. O gasto segue a competência: compras no cartão contam no mês em que aconteceram."
      size="lg"
      onSubmit={submit}
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancelar</Button>
          <Button variant="primary" type="submit">
            Salvar orçamento
          </Button>
        </>
      }
    >
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <Button size="sm" onClick={copyPrevious} title="Preenche os campos vazios com o plano anterior">
          Copiar do mês anterior
        </Button>
        {error ? (
          <p role="alert" className="text-caption font-medium text-negative">
            {error}
          </p>
        ) : null}
      </div>
      {rows.length === 0 ? (
        <p className="py-6 text-center text-body text-secondary">Este projeto ainda não tem categorias de despesa.</p>
      ) : (
        <div role="group" aria-label="Orçamento por categoria">
          <div
            aria-hidden="true"
            className={`hidden gap-x-3 border-b border-separator pb-1.5 text-caption font-semibold text-secondary tablet:grid ${COLUMNS}`}
          >
            <span>Categoria</span>
            <span className="text-right">Planejado</span>
            <span className="text-right">Gasto no mês</span>
            <span className="text-right">Mês anterior</span>
          </div>
          <ul>
            {rows.map((row) => (
              <li
                key={row.categoryId}
                className={`grid items-center gap-x-3 gap-y-0.5 border-b border-separator/60 py-1.5 ${COLUMNS}`}
              >
                <span className="min-w-0 truncate text-body" title={row.name}>
                  {row.name}
                </span>
                <MoneyField
                  label={`Planejado para ${row.name}`}
                  hideLabel
                  placeholder="sem plano"
                  value={texts[row.categoryId] ?? ""}
                  onChange={(text) => {
                    setTexts((current) => ({ ...current, [row.categoryId]: text }));
                    setError(null);
                  }}
                  ref={(element) => {
                    if (element) inputs.current.set(row.categoryId, element);
                    else inputs.current.delete(row.categoryId);
                  }}
                />
                <span className="col-span-2 text-caption text-secondary tablet:col-span-1 tablet:text-right tablet:text-body tablet:text-text tablet:tabular-nums">
                  <span className="tablet:sr-only">Gasto no mês: </span>
                  {money(row.spent)}
                </span>
                <span className="col-span-2 text-caption text-secondary tablet:col-span-1 tablet:text-right tablet:text-body tablet:text-text tablet:tabular-nums">
                  <span className="tablet:sr-only">Mês anterior: </span>
                  {money(row.previous)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Dialog>
  );
}
