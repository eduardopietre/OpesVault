/**
 * Marcadores (desktop `ui/planning_dialogs.py` `TagDialog` and `RenameTagDialog`): tags cut across categories
 * (a trip, a renovation) and never change a value. An installment plan is tagged as a whole.
 */
import { dom, DomainError, type Id } from "@opesvault/domain";
import { Select, TextField } from "@opesvault/ui";
import { useId, useMemo, useState } from "react";
import { useWorkspace } from "../data/react.tsx";
import { Caption, FormDialog, useFormAct } from "./livro_form.tsx";

const ACTIONS = [
  { id: "add", label: "Adicionar aos selecionados" },
  { id: "remove", label: "Remover dos selecionados" },
];

export interface TagDialogProps {
  open: boolean;
  onClose: () => void;
  operationIds: readonly Id[];
  /** How many operations changed. */
  onDone?: (changed: number) => void;
}

export function TagDialog({ open, onClose, operationIds, onDone }: TagDialogProps) {
  const ledger = useWorkspace().ledger;
  const act = useFormAct();
  const listId = useId();
  const known = useMemo(() => dom.tags.allTags(ledger), [ledger]);
  const current = useMemo(
    () =>
      [...new Set(operationIds.flatMap((id) => dom.tags.tagsOf(ledger, id)))].sort((a, b) =>
        a.toLowerCase().localeCompare(b.toLowerCase(), "pt-BR"),
      ),
    [ledger, operationIds],
  );
  const [tag, setTag] = useState("");
  const [action, setAction] = useState("add");

  const confirm = () => {
    dom.tags.normalize(tag); // refuses an empty or too long name before anything is touched
    const changed = act((l) =>
      action === "remove" ? dom.tags.removeTag(l, operationIds, tag.trim()) : dom.tags.addTag(l, operationIds, tag),
    );
    onDone?.(changed);
  };

  return (
    <FormDialog open={open} onClose={onClose} title="Marcadores" confirmLabel="Aplicar" onConfirm={confirm}>
      <div className="flex flex-col gap-4">
        <Caption>
          {operationIds.length} lançamento(s). Marcadores atuais: {current.join(", ") || "nenhum"}. Marcadores agrupam
          lançamentos de várias categorias (uma viagem, uma reforma) e não mudam valores.
        </Caption>
        <TextField
          label="Marcador"
          value={tag}
          onChange={setTag}
          placeholder="ex.: Viagem 2026, Reforma da cozinha"
          autoComplete="off"
          list={listId}
          maxLength={dom.tags.MAX_LENGTH}
        />
        <datalist id={listId}>
          {known.map((name) => (
            <option key={name} value={name} />
          ))}
        </datalist>
        <Select label="O que fazer" options={ACTIONS} value={action} onChange={setAction} />
      </div>
    </FormDialog>
  );
}

export interface RenameTagDialogProps {
  open: boolean;
  onClose: () => void;
  tag: string;
  onDone?: (changed: number, name: string) => void;
}

export function RenameTagDialog({ open, onClose, tag, onDone }: RenameTagDialogProps) {
  const act = useFormAct();
  const [name, setName] = useState(tag);

  const confirm = () => {
    const clean = dom.tags.normalize(name);
    if (clean === tag) throw new DomainError("Escreva um nome diferente do atual.");
    const changed = act((l) => dom.tags.renameTag(l, tag, name), "renomear marcador");
    onDone?.(changed, clean);
  };

  return (
    <FormDialog open={open} onClose={onClose} title="Renomear marcador" confirmLabel="Renomear" onConfirm={confirm}>
      <TextField label="Novo nome" value={name} onChange={setName} autoComplete="off" maxLength={dom.tags.MAX_LENGTH} />
    </FormDialog>
  );
}
