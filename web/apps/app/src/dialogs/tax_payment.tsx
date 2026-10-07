/**
 * DARF pago (desktop `PaymentDialog`): the money leaves the account as a tax expense and the month counts as
 * paid. The amount comes with the fine and interest, if it was paid late; nothing is computed here.
 */
import { DomainError, tax, type Dec, type Id, type YearMonth } from "@opesvault/domain";
import { DateField, MoneyField, Select } from "@opesvault/ui";
import { useState } from "react";
import { useWorkspace } from "../data/react.tsx";
import { liquidAccounts } from "./account_choices.ts";
import { Caption, FormDialog, dateText, editableMoney, readDate, readMoney, useFormAct } from "./livro_form.tsx";

export interface PaymentDialogProps {
  open: boolean;
  onClose: () => void;
  purpose: tax.model.PaymentPurpose;
  month: YearMonth;
  memberId: Id | null;
  /** What is still due, to start from (variable income); none for the Carnê-Leão. */
  suggested: Dec | null;
  onDone?: () => void;
}

export function PaymentDialog({ open, onClose, purpose, month, memberId, suggested, onDone }: PaymentDialogProps) {
  const workspace = useWorkspace();
  const ledger = workspace.ledger;
  const act = useFormAct();
  const accounts = liquidAccounts(ledger);
  const [amount, setAmount] = useState(suggested && suggested.isPositive() ? editableMoney(suggested) : "");
  const [paidOn, setPaidOn] = useState(dateText(workspace.today()));
  const [account, setAccount] = useState<string | null>(accounts[0]?.id ?? null);
  const who = memberId ? ledger.members.get(memberId)?.name : undefined;

  const confirm = () => {
    const value = readMoney(amount, { allowEmpty: true });
    if (value === null) throw new DomainError("Informe o valor pago.");
    const on = readDate(paidOn, "A data do pagamento");
    if (account === null) throw new DomainError("Escolha a conta.");
    act((l) => tax.records.recordPayment(l, purpose, month, value, on, account, memberId), "registrar pagamento de imposto");
    onDone?.();
  };

  return (
    <FormDialog
      open={open}
      onClose={onClose}
      title={tax.model.PURPOSE_LABELS[purpose]}
      size="sm"
      confirmLabel="Registrar pagamento"
      onConfirm={confirm}
    >
      <Caption>
        Apuração de {String(month.month).padStart(2, "0")}/{month.year}
        {who ? ` · ${who}` : ""}. Valor com multa e juros, se pago em atraso.
      </Caption>
      <MoneyField label="Valor pago" value={amount} onChange={setAmount} data-autofocus="" />
      <DateField label="Data do pagamento" value={paidOn} onChange={setPaidOn} />
      <Select
        label="Conta"
        options={accounts}
        value={account}
        onChange={setAccount}
        placeholder="Nenhuma conta de dinheiro"
      />
    </FormDialog>
  );
}
