/**
 * Dados fiscais do integrante (desktop `MemberTaxDialog`): CPF, birth date and who declares the member (a
 * dependent goes in someone's return). The CPF stays inside the project.
 */
import { DomainError, tax, type Id } from "@opesvault/domain";
import { Select, TextField, type SelectOption } from "@opesvault/ui";
import { useMemo, useState } from "react";
import { useWorkspace } from "../data/react.tsx";
import {
  Caption,
  FormDialog,
  FormGrid,
  FullRow,
  NONE,
  OptionalDateField,
  optionalDateValue,
  readOptionalDate,
  useFormAct,
} from "./livro_form.tsx";
import { TaxIdField, readTaxId } from "./tax_fields.tsx";
import { memberItems } from "./account_choices.ts";

export interface MemberTaxDialogProps {
  open: boolean;
  onClose: () => void;
  memberId: Id;
  onDone?: () => void;
}

export function MemberTaxDialog({ open, onClose, memberId, onDone }: MemberTaxDialogProps) {
  const workspace = useWorkspace();
  const ledger = workspace.ledger;
  const act = useFormAct();
  const member = ledger.members.get(memberId);
  if (member === undefined) throw new DomainError("Integrante inexistente.");
  const info = tax.records.memberInfo(ledger, memberId);
  const [cpf, setCpf] = useState(info?.cpf ? tax.ids.display(info.cpf) : "");
  const [birth, setBirth] = useState(optionalDateValue(info?.birth_date ?? null));
  const [declaredBy, setDeclaredBy] = useState<string>(info?.declared_by ?? NONE);
  const [relation, setRelation] = useState(info?.relation ?? "");
  const options = useMemo<SelectOption[]>(
    () => [
      { id: NONE, label: "Faz a própria declaração" },
      ...memberItems(ledger)
        .filter((m) => m.id !== memberId)
        .map((m) => ({ id: m.id, label: `Dependente de ${m.label}` })),
    ],
    [ledger, memberId],
  );

  const confirm = () => {
    const digits = readTaxId(cpf, "cpf", true);
    const born = readOptionalDate(birth, "A data de nascimento");
    const by = declaredBy === NONE ? null : declaredBy;
    act((l) =>
      tax.records.setMemberInfo(
        l,
        memberId,
        { cpf: digits, birth_date: born, declared_by: by, relation },
        workspace.today(),
      ),
    );
    onDone?.();
  };

  return (
    <FormDialog
      open={open}
      onClose={onClose}
      title={`Dados fiscais — ${member.name}`}
      confirmLabel="Salvar"
      onConfirm={confirm}
    >
      <FormGrid>
        <TaxIdField label="CPF" value={cpf} onChange={setCpf} kinds="cpf" data-autofocus="" />
        <OptionalDateField label="Data de nascimento" value={birth} onChange={setBirth} />
        <FullRow>
          <Select label="Quem declara" options={options} value={declaredBy} onChange={setDeclaredBy} />
        </FullRow>
        <FullRow>
          <TextField
            label="Relação de dependência"
            value={relation}
            onChange={setRelation}
            maxLength={60}
            placeholder="ex.: Filho(a), Cônjuge"
            autoComplete="off"
          />
        </FullRow>
        <FullRow>
          <Caption>
            Cada declaração é de um CPF. Dependentes entram na declaração de quem os declara, com as próprias receitas e
            despesas. O CPF fica só dentro do projeto.
          </Caption>
        </FullRow>
      </FormGrid>
    </FormDialog>
  );
}
