/**
 * Reembolso recebido (desktop `ReceiveDialog`): the money of a reimbursement arrived and becomes a refund of
 * the original categories, in the month it was received. The amount starts at what is still missing.
 */
import { DomainError, ZERO, dom, type Id } from "@opesvault/domain";
import { DateField, MoneyField, Select } from "@opesvault/ui";
import { useMemo, useState } from "react";
import { useWorkspace } from "../data/react.tsx";
import { assetAccounts } from "./account_choices.ts";
import {
  Caption,
  FormDialog,
  FormGrid,
  FullRow,
  dateText,
  editableMoney,
  readDate,
  readMoney,
  useFormAct,
} from "./livro_form.tsx";

export interface SharingReceiveDialogProps {
  open: boolean;
  onClose: () => void;
  reimbursementId: Id;
  onDone?: () => void;
}

export function SharingReceiveDialog({ open, onClose, reimbursementId, onDone }: SharingReceiveDialogProps) {
  const workspace = useWorkspace();
  const ledger = workspace.ledger;
  const act = useFormAct();
  const item = dom.sharing.reimbursements(ledger).get(reimbursementId);
  const accounts = useMemo(() => assetAccounts(ledger), [ledger]);
  const missing = item ? item.expected.sub(dom.sharing.received(ledger, item)) : ZERO;
  const [account, setAccount] = useState<string>(accounts[0]?.id ?? "");
  const [amount, setAmount] = useState(missing.isPositive() ? editableMoney(missing) : "");
  const [when, setWhen] = useState(dateText(workspace.today()));

  const confirm = () => {
    if (!account) throw new DomainError("Cadastre a conta que recebeu.");
    const value = readMoney(amount);
    if (!value.isPositive()) throw new DomainError("Informe um valor positivo.");
    const on = readDate(when, "A data do recebimento");
    act((l) => dom.sharing.receive(l, reimbursementId, account, value, on));
    onDone?.();
  };

  return (
    <FormDialog
      open={open}
      onClose={onClose}
      title="Reembolso recebido"
      confirmLabel="Registrar recebimento"
      onConfirm={confirm}
    >
      <FormGrid>
        <FullRow>
          <Caption>O valor entra como estorno das categorias da despesa original, no mês em que foi recebido.</Caption>
        </FullRow>
        <FullRow>
          <Select label="Recebido na conta" options={accounts} value={account} onChange={setAccount} />
        </FullRow>
        <MoneyField label="Valor recebido" value={amount} onChange={setAmount} />
        <DateField label="Data do recebimento" value={when} onChange={setWhen} />
      </FormGrid>
    </FormDialog>
  );
}
