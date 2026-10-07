/**
 * Pagar parcela (desktop `PayInstallmentDialog`): records one installment with amortization, interest and
 * fees kept apart. Paying more than the installment (a fine, late interest) adds the difference to interest.
 */
import { DomainError, dom, formatBrl, type Operation } from "@opesvault/domain";
import { DateField, MoneyField, Select, formatBrDate } from "@opesvault/ui";
import { useState } from "react";
import { useWorkspace } from "../data/react.tsx";
import { liquidAccounts } from "./account_choices.ts";
import { Caption, FormDialog, useFormAct } from "./livro_form.tsx";
import { dateText, editableMoney, readDate, readMoney } from "./form_readers.ts";

export interface PayInstallmentDialogProps {
  open: boolean;
  onClose: () => void;
  plan: dom.loans.LoanPlan;
  item: dom.loans.Installment;
  onDone?: (operation: Operation) => void;
}

export function PayInstallmentDialog({ open, onClose, plan, item, onDone }: PayInstallmentDialogProps) {
  const workspace = useWorkspace();
  const act = useFormAct();
  const accounts = liquidAccounts(workspace.ledger);
  const [account, setAccount] = useState<string | null>(
    accounts.some((a) => a.id === plan.payment_account_id) ? plan.payment_account_id : (accounts[0]?.id ?? null),
  );
  const [amount, setAmount] = useState(editableMoney(item.payment));
  const [when, setWhen] = useState(dateText(workspace.today()));

  const confirm = () => {
    const value = readMoney(amount, { allowEmpty: true });
    if (value === null || value.lt(item.payment)) throw new DomainError("O valor não pode ser menor que a parcela.");
    const on = readDate(when, "A data do pagamento");
    const operation = act((l) =>
      dom.loans.payInstallment(l, plan.id, item.number, on, value, account ?? plan.payment_account_id),
    );
    onDone?.(operation);
  };

  return (
    <FormDialog
      open={open}
      onClose={onClose}
      title={`Pagar parcela ${item.number} — ${plan.name}`}
      confirmLabel="Registrar pagamento"
      size="sm"
      onConfirm={confirm}
    >
      <div className="flex flex-col gap-4">
        <Caption>
          Vencimento {formatBrDate(item.due)} · amortização {formatBrl(item.amortization)} · juros{" "}
          {formatBrl(item.interest)}
          {item.fees.isPositive() ? ` · seguros e tarifas ${formatBrl(item.fees)}` : ""}
        </Caption>
        <Select
          label="Pago pela conta"
          options={accounts}
          value={account}
          onChange={setAccount}
          placeholder="Nenhuma conta de dinheiro"
        />
        <MoneyField label="Valor pago" value={amount} onChange={setAmount} data-autofocus="" />
        <DateField label="Data do pagamento" value={when} onChange={setWhen} />
        <Caption>Valor acima da parcela (multa, juros de atraso) entra como juros.</Caption>
      </div>
    </FormDialog>
  );
}
