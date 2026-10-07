/**
 * Vincular realizado (desktop `link_selected` of `ui/pages/recurrences_page.py`): the operations that can
 * realize a forecast (same accounts, value within the tolerance, date in the window), one to choose. Nothing
 * is linked on its own (docs/05 §6); a linked operation stops counting as pending (TA-17).
 */
import { Dec, ZERO, cashDate, dom, formatBrl, formatDateBr, type Operation } from "@opesvault/domain";
import { RadioGroup } from "@opesvault/ui";
import { useMemo, useState } from "react";
import { useWorkspace } from "../data/react.tsx";
import { Caption, FormDialog, useFormAct } from "./livro_form.tsx";
import { dateOr } from "../data/money.ts";

type Forecast = dom.recurrence.Forecast;

export interface RecurrenceLinkDialogProps {
  open: boolean;
  onClose: () => void;
  forecast: Forecast;
  /** `dom.recurrence.candidates` for the forecast: never empty. */
  candidates: readonly Operation[];
  onDone?: (operation: Operation) => void;
}

export function RecurrenceLinkDialog({ open, onClose, forecast, candidates, onDone }: RecurrenceLinkDialogProps) {
  const ledger = useWorkspace().ledger;
  const act = useFormAct();
  const [chosen, setChosen] = useState<string>(candidates[0]?.id ?? "");
  const rule = dom.recurrence.rules(ledger).get(forecast.ruleId);
  const options = useMemo(
    () =>
      candidates.map((op) => {
        const when = cashDate(op) ?? op.occurred_on;
        const value = rule
          ? Dec.sum(
              op.postings.filter((p) => p.account_id === rule.account_id).map((p) => p.amount),
              ZERO,
            ).abs()
          : null;
        return {
          value: op.id,
          label: `${dateOr(when)} ${op.description}`,
          ...(value ? { description: formatBrl(value) } : {}),
        };
      }),
    [candidates, rule],
  );

  const confirm = () => {
    const op = candidates.find((o) => o.id === chosen);
    if (!op) return;
    act((l) => dom.recurrence.realize(l, forecast.ruleId, forecast.dueOn, op.id), "vincular previsão");
    onDone?.(op);
  };

  return (
    <FormDialog
      open={open}
      onClose={onClose}
      title="Vincular realizado"
      description={`Previsão de ${formatDateBr(forecast.dueOn)}: ${forecast.description}, ${formatBrl(forecast.amount.abs())}.`}
      confirmLabel="Vincular"
      size="md"
      onConfirm={confirm}
    >
      <RadioGroup label="Lançamento realizado" value={chosen} onValueChange={setChosen} options={options} />
      <Caption>O lançamento deixa de contar como pendente e a previsão passa a Realizada.</Caption>
    </FormDialog>
  );
}
