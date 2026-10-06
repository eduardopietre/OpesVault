/**
 * Integrante (desktop `MemberDialog`): name and role (holder or dependent); editing also sets the situation.
 * The role identifies, it never gives or takes access.
 */
import { DomainError, MemberRole, type Member } from "@opesvault/domain";
import { Checkbox, Select, TextField } from "@opesvault/ui";
import { useState } from "react";
import { Caption, FormDialog, useFormAct } from "./livro_form.tsx";
import { ROLE_LABELS } from "./accounts_labels.ts";

export interface MemberDialogProps {
  open: boolean;
  onClose: () => void;
  member?: Member;
  onDone?: (member: Member, created: boolean) => void;
}

const ROLES = Object.entries(ROLE_LABELS).map(([id, label]) => ({ id, label }));

export function MemberDialog({ open, onClose, member, onDone }: MemberDialogProps) {
  const act = useFormAct();
  const [name, setName] = useState(member?.name ?? "");
  const [role, setRole] = useState<string>(member?.role ?? MemberRole.HOLDER);
  const [active, setActive] = useState(member?.active ?? true);

  const confirm = () => {
    const title = name.trim();
    if (!title) throw new DomainError("Informe o nome.");
    const chosen = role as MemberRole;
    const saved = act((l) => {
      if (!member) return l.addMember(title, chosen);
      const updated: Member = { ...member, name: title, role: chosen, active };
      if (updated.name === member.name && updated.role === member.role && updated.active === member.active) {
        return member;
      }
      return l.updateMember(updated, "Edição do integrante");
    });
    onDone?.(saved, member === undefined);
  };

  return (
    <FormDialog
      open={open}
      onClose={onClose}
      title={member ? "Editar integrante" : "Novo integrante"}
      confirmLabel={member ? "Salvar" : "Adicionar"}
      size="sm"
      onConfirm={confirm}
    >
      <div className="flex flex-col gap-4">
        <TextField
          label="Nome"
          value={name}
          onChange={setName}
          maxLength={120}
          autoComplete="off"
          data-autofocus=""
          required
        />
        <Select label="Papel" options={ROLES} value={role} onChange={setRole} />
        <Caption>
          Titular responde pelas finanças do projeto; dependente (filhos, por exemplo) participa de rateios e pode ser
          portador de cartão adicional. O papel identifica; não dá nem tira acesso.
        </Caption>
        {member ? (
          <Checkbox
            label="Ativo (aparece em formulários, titularidade e rateios)"
            checked={active}
            onCheckedChange={setActive}
          />
        ) : null}
      </div>
    </FormDialog>
  );
}
