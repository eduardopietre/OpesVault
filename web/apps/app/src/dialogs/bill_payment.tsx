/**
 * Pagar fatura (desktop `BillPaymentDialog`): pays one card bill from where it is seen, with the remaining
 * amount, today and the card's settlement account already filled in. A payment after the due date settles
 * the overdue bills first, oldest to newest (docs/04 §5): the dialog says so, it is not an error.
 */
import { Dec, DomainError, formatBrl, type Card, type IsoDate, type Operation } from "@opesvault/domain";
import { DateField, MoneyField, Select, formatBrDate } from "@opesvault/ui";
import { useState } from "react";
import { useWorkspace } from "../data/react.tsx";
import { liquidAccounts } from "./account_choices.ts";
import { Caption, FormDialog, useFormAct } from "./livro_form.tsx";
import { dateText, editableMoney, readDate, readMoney } from "./form_readers.ts";

export interface BillSummary {
  due: IsoDate;
  total: Dec;
  payments: Dec;
  remaining: Dec;
}

export interface BillPaymentDialogProps {
  open: boolean;
  onClose: () => void;
  card: Card;
  bill: BillSummary;
  onDone?: (operation: Operation) => void;
}

export function BillPaymentDialog({ open, onClose, card, bill, onDone }: BillPaymentDialogProps) {
  const workspace = useWorkspace();
  const ledger = workspace.ledger;
  const act = useFormAct();
  const accounts = liquidAccounts(ledger);
  const settlement = card.settlement_account_id;
  const [account, setAccount] = useState<string | null>(
    settlement && accounts.some((a) => a.id === settlement) ? settlement : (accounts[0]?.id ?? null),
  );
  const [amount, setAmount] = useState(editableMoney(bill.remaining));
  const [when, setWhen] = useState(dateText(workspace.today()));
  const late = (() => {
    try {
      return readDate(when) > bill.due;
    } catch {
      return false;
    }
  })();

  const confirm = () => {
    if (account === null) throw new DomainError("Cadastre a conta de onde sai o pagamento.");
    const value = readMoney(amount);
    if (!value.isPositive()) throw new DomainError("Informe um valor positivo.");
    const on = readDate(when, "A data do pagamento");
    const operation = act((l) => l.recordCardPayment(card.id, account, value, on), "pagar fatura");
    onDone?.(operation);
  };

  return (
    <FormDialog
      open={open}
      onClose={onClose}
      title={`Pagar fatura — ${card.name}`}
      confirmLabel="Registrar pagamento"
      size="sm"
      onConfirm={confirm}
    >
      <div className="flex flex-col gap-4">
        <Caption>
          Vencimento {formatBrDate(bill.due)} · total {formatBrl(bill.total)} · pago {formatBrl(bill.payments)} · falta{" "}
          {formatBrl(bill.remaining)}
        </Caption>
        <Select
          label="Pago pela conta"
          options={accounts}
          value={account}
          onChange={setAccount}
          placeholder="Nenhuma conta de dinheiro"
        />
        <MoneyField label="Valor" value={amount} onChange={setAmount} data-autofocus="" />
        <DateField label="Data do pagamento" value={when} onChange={setWhen} />
        {late ? (
          <p role="status" className="text-caption font-medium text-warning">
            Pagamento após o vencimento: quita primeiro esta fatura vencida.
          </p>
        ) : null}
      </div>
    </FormDialog>
  );
}
