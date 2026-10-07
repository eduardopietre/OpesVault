/**
 * Registrar acerto (desktop `SettlementDialog`): one member paid another back. Nothing moves money here; the
 * transfer itself, if any, is a normal operation. Opened on a balance, it starts with its pair and amount.
 */
import { DomainError, dom, type Dec, type Id } from "@opesvault/domain";
import { DateField, MoneyField, Select, TextField } from "@opesvault/ui";
import { useMemo, useState } from "react";
import { useWorkspace } from "../data/react.tsx";
import { FormDialog, FormGrid, FullRow, useFormAct } from "./livro_form.tsx";
import { dateText, editableMoney, readDate, readMoney } from "./form_readers.ts";

export interface SharingSettleDialogProps {
  open: boolean;
  onClose: () => void;
  debtorId?: Id | null;
  creditorId?: Id | null;
  amount?: Dec | null;
  onDone?: () => void;
}

export function SharingSettleDialog({
  open,
  onClose,
  debtorId = null,
  creditorId = null,
  amount = null,
  onDone,
}: SharingSettleDialogProps) {
  const workspace = useWorkspace();
  const ledger = workspace.ledger;
  const act = useFormAct();
  const members = useMemo(
    () => [...ledger.members.values()].filter((m) => m.active).map((m) => ({ id: m.id, label: m.name })),
    [ledger],
  );
  const has = (id: Id | null) => id !== null && members.some((m) => m.id === id);
  const firstDebtor = has(debtorId) ? (debtorId as Id) : (members[0]?.id ?? "");
  // someone else, by default (desktop)
  const firstCreditor = has(creditorId)
    ? (creditorId as Id)
    : (members.find((m) => m.id !== firstDebtor)?.id ?? members[0]?.id ?? "");
  const [debtor, setDebtor] = useState<string>(firstDebtor);
  const [creditor, setCreditor] = useState<string>(firstCreditor);
  const [value, setValue] = useState(amount ? editableMoney(amount) : "");
  const [when, setWhen] = useState(dateText(workspace.today()));
  const [note, setNote] = useState("");

  const confirm = () => {
    if (!debtor || debtor === creditor) throw new DomainError("Escolha dois integrantes diferentes.");
    const money = readMoney(value);
    if (!money.isPositive()) throw new DomainError("Informe um valor positivo.");
    const on = readDate(when, "A data do acerto");
    act((l) => dom.sharing.settle(l, debtor, creditor, money, on, note.trim() || null), "registrar acerto");
    onDone?.();
  };

  return (
    <FormDialog open={open} onClose={onClose} title="Registrar acerto" confirmLabel="Registrar" onConfirm={confirm}>
      <FormGrid>
        <Select label="Quem pagou" options={members} value={debtor} onChange={setDebtor} />
        <Select label="Para quem" options={members} value={creditor} onChange={setCreditor} />
        <MoneyField label="Valor" value={value} onChange={setValue} />
        <DateField label="Data do acerto" value={when} onChange={setWhen} />
        <FullRow>
          <TextField label="Observação" value={note} onChange={setNote} autoComplete="off" />
        </FullRow>
      </FormGrid>
    </FormDialog>
  );
}
