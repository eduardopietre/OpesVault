/**
 * Bens e Direitos (desktop `FilingDialog`): group, code and description of an account or an investment in the
 * return. The group the app suggests is only a hint; the choice is the person's.
 */
import { DomainError, tax, type Id } from "@opesvault/domain";
import { TextField } from "@opesvault/ui";
import { useState } from "react";
import { useWorkspace } from "../data/react.tsx";
import { Caption, FormDialog, useFormAct } from "./livro_form.tsx";
import { AssetCodeField, splitCode } from "./tax_fields.tsx";

export interface FilingDialogProps {
  open: boolean;
  onClose: () => void;
  subject: tax.model.FilingSubject;
  reference: Id;
  /** The account or investment being filed. */
  name: string;
  /** The group the app suggests (marked as such), when nothing was chosen yet. */
  suggested: string | null;
  onDone?: () => void;
}

export function FilingDialog({ open, onClose, subject, reference, name, suggested, onDone }: FilingDialogProps) {
  const ledger = useWorkspace().ledger;
  const act = useFormAct();
  const current = tax.records.filingOf(ledger, subject, reference);
  const [kind, setKind] = useState<string | null>(current ? `${current.group}.${current.code}` : null);
  const [description, setDescription] = useState(current?.description ? current.description : name);

  const confirm = () => {
    if (kind === null) throw new DomainError("Escolha o grupo e o código na tabela do IRPF.");
    const [group, code] = splitCode(kind);
    act((l) => tax.records.setFiling(l, subject, reference, group, code, description));
    onDone?.();
  };

  return (
    <FormDialog
      open={open}
      onClose={onClose}
      title="Bens e Direitos"
      description={name}
      size="lg"
      confirmLabel="Salvar"
      onConfirm={confirm}
    >
      <AssetCodeField label="Tipo (grupo e código do IRPF)" value={kind} onChange={setKind} />
      <TextField
        label="Discriminação"
        value={description}
        onChange={setDescription}
        maxLength={512}
        autoComplete="off"
      />
      <Caption>
        Grupo e código da tabela de Bens e Direitos do programa IRPF (digite para procurar)
        {suggested && current === null ? `; sugestão: grupo ${suggested}` : ""}. O valor declarado é o custo, calculado
        pelo aplicativo.
      </Caption>
    </FormDialog>
  );
}
