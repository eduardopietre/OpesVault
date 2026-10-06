/**
 * CPF ou CNPJ (desktop `TaxIdDialog`): the number of a payee, an institution or a payer, with the name used
 * in the return. The number stays inside the project and its check digits are verified.
 */
import { tax } from "@opesvault/domain";
import { TextField } from "@opesvault/ui";
import { useState } from "react";
import { useWorkspace } from "../data/react.tsx";
import { Caption, FormDialog, useFormAct } from "./livro_form.tsx";
import { TaxIdField, readTaxId } from "./tax_fields.tsx";

const TITLES: Record<tax.model.TaxSubject, string> = {
  merchant: "Quem recebeu o pagamento",
  account: "Instituição da conta",
  category: "Fonte pagadora",
};

export interface TaxIdDialogProps {
  open: boolean;
  onClose: () => void;
  subject: tax.model.TaxSubject;
  /** A merchant key, or the id of an account or income category. */
  reference: string;
  /** What the number belongs to, to suggest the name and tell the person which one this is. */
  label: string;
  onDone?: () => void;
}

export function TaxIdDialog({ open, onClose, subject, reference, label, onDone }: TaxIdDialogProps) {
  const ledger = useWorkspace().ledger;
  const act = useFormAct();
  const current = tax.records.identity(ledger, subject, reference);
  const [number, setNumber] = useState(current ? tax.ids.display(current.tax_id) : "");
  const [name, setName] = useState(current ? (current.name ?? "") : label);

  const confirm = () => {
    const digits = readTaxId(number, "any");
    act((l) => tax.records.setIdentity(l, subject, reference, digits ?? "", name));
    onDone?.();
  };

  return (
    <FormDialog
      open={open}
      onClose={onClose}
      title="CPF ou CNPJ"
      description={`${TITLES[subject]}: ${label}`}
      size="sm"
      confirmLabel="Salvar"
      onConfirm={confirm}
    >
      <TaxIdField label="CPF ou CNPJ" value={number} onChange={setNumber} data-autofocus="" />
      <TextField label="Nome na declaração" value={name} onChange={setName} maxLength={150} autoComplete="off" />
      <Caption>O número fica só dentro do projeto; os dígitos verificadores são conferidos.</Caption>
    </FormDialog>
  );
}
