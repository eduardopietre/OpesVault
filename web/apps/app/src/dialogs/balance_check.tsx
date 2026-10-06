/**
 * Conferir saldo (desktop `BalanceCheckDialog`): the balance the bank shows on a date, kept to compare with
 * the book's balance. A card or loan is typed as the debt, a positive amount.
 */
import { AccountType, dom, type Id } from "@opesvault/domain";
import { DateField, MoneyField, Select, TextField } from "@opesvault/ui";
import { useMemo, useState } from "react";
import { useWorkspace } from "../data/react.tsx";
import { balanceAccounts } from "./account_choices.ts";
import { Caption, FormDialog, FormGrid, FullRow, dateText, readDate, readMoney, useFormAct } from "./livro_form.tsx";

export interface BalanceCheckDialogProps {
  open: boolean;
  onClose: () => void;
  accountId: Id;
  /** Offers these accounts to choose from (the Livro, when an operation touches more than one). */
  choices?: readonly Id[];
  onDone?: (result: dom.balanceChecks.BalanceCheck, accountName: string) => void;
}

export function BalanceCheckDialog({ open, onClose, accountId, choices, onDone }: BalanceCheckDialogProps) {
  const workspace = useWorkspace();
  const ledger = workspace.ledger;
  const act = useFormAct();
  const [account, setAccount] = useState<string>(accountId);
  const options = useMemo(
    () => (choices ? balanceAccounts(ledger).filter((o) => choices.includes(o.id)) : []),
    [ledger, choices],
  );
  const [when, setWhen] = useState(dateText(workspace.today()));
  const [informed, setInformed] = useState("");
  const [note, setNote] = useState("");
  const chosen = ledger.account(account);
  const hint =
    chosen.type === AccountType.LIABILITY
      ? "Saldo devedor, como o banco mostra (valor positivo)."
      : "Saldo da conta no fim do dia, como o banco mostra (negativo se estiver no cheque especial).";

  const confirm = () => {
    const value = readMoney(informed);
    const on = readDate(when, "A data do saldo");
    const result = act((l) => dom.balanceChecks.record(l, account, on, value, note));
    onDone?.(result, chosen.name);
  };

  return (
    <FormDialog
      open={open}
      onClose={onClose}
      title={`Conferir saldo — ${ledger.account(accountId).name}`}
      confirmLabel="Conferir"
      onConfirm={confirm}
    >
      <FormGrid>
        {options.length > 1 ? (
          <FullRow>
            <Select label="Conta" options={options} value={account} onChange={setAccount} />
          </FullRow>
        ) : null}
        <FullRow>
          <Caption>{hint}</Caption>
        </FullRow>
        <DateField label="Data do saldo no banco" value={when} onChange={setWhen} />
        <MoneyField label="Saldo no banco" value={informed} onChange={setInformed} />
        <FullRow>
          <TextField
            label="Observação"
            value={note}
            onChange={setNote}
            placeholder="ex.: extrato do aplicativo do banco"
            autoComplete="off"
          />
        </FullRow>
      </FormGrid>
    </FormDialog>
  );
}
