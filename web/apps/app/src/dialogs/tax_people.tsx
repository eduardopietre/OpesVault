/**
 * Declarantes e dependentes (desktop `PeopleDialog`): who files a return and who is a dependent, one line per
 * member, edited one at a time in the member's tax data.
 */
import { sortedBy, tax, type Id, type Ledger } from "@opesvault/domain";
import { Button, DataTable, ElidedText, type DataColumn, fitHeight } from "@opesvault/ui";
import { useState } from "react";
import { useLedger } from "../data/react.tsx";
import { FormDialog, Caption } from "./livro_form.tsx";
import { MemberTaxDialog } from "./tax_member.tsx";
import { dateOr } from "../data/money.ts";

interface PersonRow {
  id: Id;
  name: string;
  cpf: string;
  birth: string;
  declaration: string;
}

const text = (value: string) => <ElidedText>{value}</ElidedText>;

const COLUMNS: DataColumn<PersonRow>[] = [
  { id: "name", header: "Integrante", cell: (r) => text(r.name), sortValue: (r) => r.name, grow: 1, width: 130 },
  { id: "cpf", header: "CPF", cell: (r) => r.cpf, sortValue: (r) => r.cpf, width: 140 },
  { id: "birth", header: "Nascimento", cell: (r) => r.birth, sortValue: (r) => r.birth, width: 110 },
  {
    id: "declaration",
    header: "Declaração",
    cell: (r) => text(r.declaration),
    sortValue: (r) => r.declaration,
    grow: 1,
    width: 160,
  },
];

export function peopleRows(ledger: Ledger): PersonRow[] {
  return sortedBy([...ledger.members.values()], (m) => m.name.toLowerCase()).map((member) => {
    const info = tax.records.memberInfo(ledger, member.id);
    const boss = info?.declared_by ? ledger.members.get(info.declared_by) : undefined;
    return {
      id: member.id,
      name: member.name,
      cpf: info?.cpf ? tax.ids.display(info.cpf) : "—",
      birth: dateOr(info?.birth_date),
      declaration: boss ? `Dependente de ${boss.name}` : "Própria",
    };
  });
}

export interface PeopleDialogProps {
  open: boolean;
  onClose: () => void;
}

export function PeopleDialog({ open, onClose }: PeopleDialogProps) {
  const rows = useLedger(peopleRows);
  const [picked, setPicked] = useState<Id | null>(null);
  const [editing, setEditing] = useState<{ id: Id; key: number } | null>(null);
  const [editOpen, setEditOpen] = useState(false);
  // A toast would sit behind this dialog: the result is said here.
  const [saved, setSaved] = useState(false);
  const selected = rows.find((r) => r.id === picked) ?? rows[0] ?? null;

  const edit = (id: Id | undefined = selected?.id) => {
    if (!id) return;
    setPicked(id);
    setEditing((current) => ({ id, key: (current?.key ?? 0) + 1 }));
    setEditOpen(true);
  };

  return (
    <>
      <FormDialog open={open} onClose={onClose} title="Declarantes e dependentes" closeOnly size="lg">
        <DataTable
          label="Integrantes"
          rows={rows}
          columns={COLUMNS}
          getRowId={(r) => r.id}
          selectedId={selected?.id ?? null}
          onSelect={setPicked}
          onActivate={edit}
          cardTitle={(r) => text(r.name)}
          height={fitHeight(rows.length, 8)}
        />
        <div className="flex flex-wrap items-center gap-3">
          <Button onClick={() => edit()} disabled={selected === null}>
            Editar…
          </Button>
          {saved ? (
            <p role="status" className="text-body font-medium text-positive">
              Dados fiscais salvos.
            </p>
          ) : null}
        </div>
        <Caption>
          Quem não é dependente de ninguém faz a própria declaração. Dependentes entram na declaração de quem os
          declara.
        </Caption>
      </FormDialog>
      {editing ? (
        <MemberTaxDialog
          key={editing.key}
          open={editOpen}
          onClose={() => setEditOpen(false)}
          memberId={editing.id}
          onDone={() => setSaved(true)}
        />
      ) : null}
    </>
  );
}
