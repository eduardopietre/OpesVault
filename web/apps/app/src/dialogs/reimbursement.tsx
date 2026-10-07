/**
 * Reembolso a receber (desktop `ReimbursementDialog`): marks an expense as something a health plan, an
 * employer or someone else will pay back. The expected amount starts at the expense's total.
 */
import { AccountType, DomainError, Dec, ZERO, cashDate, dom, formatBrl, type Operation } from "@opesvault/domain";
import { DateField, MoneyField, TextField } from "@opesvault/ui";
import { useState } from "react";
import { useWorkspace } from "../data/react.tsx";
import { Caption, FormDialog, FormGrid, FullRow, useFormAct } from "./livro_form.tsx";
import { dateOr } from "../data/money.ts";
import { dateText, editableMoney, readDate, readMoney } from "./form_readers.ts";

export interface ReimbursementDialogProps {
  open: boolean;
  onClose: () => void;
  operation: Operation;
  onDone?: () => void;
}

export function ReimbursementDialog({ open, onClose, operation: op, onDone }: ReimbursementDialogProps) {
  const workspace = useWorkspace();
  const ledger = workspace.ledger;
  const act = useFormAct();
  const total = Dec.sum(
    op.postings
      .filter((p) => ledger.account(p.account_id).type === AccountType.EXPENSE && p.amount.isPositive())
      .map((p) => p.amount),
    ZERO,
  );
  const [payer, setPayer] = useState("");
  const [expected, setExpected] = useState(total.isPositive() ? editableMoney(total) : "");
  const [requested, setRequested] = useState(dateText(workspace.today()));
  const when = op.occurred_on ?? cashDate(op);

  const confirm = () => {
    if (!payer.trim()) throw new DomainError("Informe quem reembolsa.");
    const value = readMoney(expected);
    if (!value.isPositive()) throw new DomainError("Informe um valor positivo.");
    const on = readDate(requested, "A data do pedido");
    act((l) => dom.sharing.request(l, op.id, payer, value, on), "pedir reembolso");
    onDone?.();
  };

  return (
    <FormDialog open={open} onClose={onClose} title="Reembolso a receber" confirmLabel="Registrar" onConfirm={confirm}>
      <FormGrid>
        <FullRow>
          <Caption>
            {op.description} · {dateOr(when)} · {formatBrl(total)}
          </Caption>
        </FullRow>
        <FullRow>
          <TextField
            label="Quem reembolsa"
            value={payer}
            onChange={setPayer}
            placeholder="ex.: Plano de saúde, Empresa"
            autoComplete="off"
          />
        </FullRow>
        <MoneyField label="Valor esperado" value={expected} onChange={setExpected} />
        <DateField label="Pedido em" value={requested} onChange={setRequested} />
      </FormGrid>
    </FormDialog>
  );
}
