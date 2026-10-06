/**
 * Conta (desktop `AccountDialog`): a ledger account with its type, institution, identification and one
 * holder or two (a joint account; the order is kept, the first is the principal). A new account may start
 * with an opening balance; the type of an existing one is fixed.
 */
import {
  AccountSubtype,
  AccountType,
  DomainError,
  LedgerAccountSchema,
  catalogs,
  type Id,
  type LedgerAccount,
} from "@opesvault/domain";
import { DateField, MoneyField, Select, TextField, type SelectOption } from "@opesvault/ui";
import { useMemo, useState } from "react";
import { useWorkspace } from "../data/react.tsx";
import { ASSET_SUBTYPES, LIABILITY_SUBTYPES, SUBTYPE_LABELS, memberChoices } from "./accounts_labels.ts";
import { FormDialog, FormGrid, FullRow, NONE, dateText, readDate, readMoney, useFormAct } from "./livro_form.tsx";

export interface AccountDialogProps {
  open: boolean;
  onClose: () => void;
  /** The account being edited; without one a new account is created. */
  account?: LedgerAccount;
  onDone?: (account: LedgerAccount, created: boolean) => void;
}

const SUBTYPES: SelectOption[] = [...ASSET_SUBTYPES, ...LIABILITY_SUBTYPES].map((s) => ({
  id: s,
  label: SUBTYPE_LABELS[s] ?? s,
}));

/** Names of the banks for the institution field's suggestions (the COMPE list, desktop `institution_edit`). */
export function BankNameList({ id }: { id: string }) {
  const names = useMemo(
    () => [...new Set(catalogs.banks().map((b) => b.name))].sort((a, b) => a.localeCompare(b, "pt-BR")),
    [],
  );
  return (
    <datalist id={id}>
      {names.map((name) => (
        <option key={name} value={name} />
      ))}
    </datalist>
  );
}

export function AccountDialog({ open, onClose, account, onDone }: AccountDialogProps) {
  const workspace = useWorkspace();
  const ledger = workspace.ledger;
  const act = useFormAct();
  const current = account?.holders;
  const members = useMemo(() => memberChoices(ledger, current ?? []), [ledger, current]);
  const [name, setName] = useState(account?.name ?? "");
  const [subtype, setSubtype] = useState<string>(account?.subtype ?? AccountSubtype.CHECKING);
  const [institution, setInstitution] = useState(account?.institution ?? "");
  const [masked, setMasked] = useState(account?.masked_number ?? "");
  const [holder, setHolder] = useState<string>(current?.[0] ?? NONE);
  const [coHolder, setCoHolder] = useState<string>(current?.[1] ?? NONE);
  const [opening, setOpening] = useState("");
  const [openingOn, setOpeningOn] = useState(dateText(workspace.today()));

  const holders = (): Id[] => {
    const first = holder === NONE ? null : holder;
    const second = coHolder === NONE ? null : coHolder;
    if (second !== null && first === null) throw new DomainError("Escolha o titular antes do segundo titular.");
    if (second !== null && second === first) throw new DomainError("O segundo titular precisa ser outra pessoa.");
    return [first, second].filter((m): m is Id => m !== null);
  };

  const confirm = () => {
    const title = name.trim();
    if (!title) throw new DomainError("Informe o nome da conta.");
    const chosen = holders();
    const kind = ASSET_SUBTYPES.includes(subtype as AccountSubtype) ? AccountType.ASSET : AccountType.LIABILITY;
    const fields = {
      name: title,
      institution: institution.trim() || null,
      masked_number: masked.trim() || null,
      holders: chosen,
    };
    const value = account ? null : readMoney(opening, { allowEmpty: true });
    const on = account || value === null ? null : readDate(openingOn, "A data do saldo");
    const saved = act((l) => {
      if (account) return l.updateAccount({ ...account, ...fields }, "Edição do cadastro");
      const created = l.addAccount(
        LedgerAccountSchema.parse({ ...fields, type: kind, subtype: subtype as AccountSubtype }),
      );
      if (value !== null && on !== null) l.recordOpeningBalance(created.id, value, on);
      return created;
    });
    onDone?.(saved, account === undefined);
  };

  return (
    <FormDialog
      open={open}
      onClose={onClose}
      title={account ? "Editar conta" : "Nova conta"}
      confirmLabel="Salvar conta"
      onConfirm={confirm}
    >
      <FormGrid>
        <FullRow>
          <TextField
            label="Nome"
            value={name}
            onChange={setName}
            maxLength={120}
            autoComplete="off"
            data-autofocus=""
            required
          />
        </FullRow>
        <Select
          label="Tipo"
          options={SUBTYPES}
          value={subtype}
          onChange={setSubtype}
          disabled={account !== undefined}
        />
        <TextField
          label="Instituição"
          value={institution}
          onChange={setInstitution}
          list="contas-bancos"
          maxLength={120}
          placeholder="digite para escolher na lista de bancos"
          autoComplete="off"
        />
        <BankNameList id="contas-bancos" />
        <TextField
          label="Identificação"
          value={masked}
          onChange={setMasked}
          maxLength={32}
          placeholder="ex.: final 1234"
          autoComplete="off"
        />
        <div aria-hidden="true" className="hidden tablet:block" />
        <Select
          label="Titular"
          options={[{ id: NONE, label: "(sem titular)" }, ...members]}
          value={holder}
          onChange={setHolder}
        />
        <Select
          label="Segundo titular"
          options={[{ id: NONE, label: "(conta individual)" }, ...members]}
          value={coHolder}
          onChange={setCoHolder}
        />
        {account ? null : (
          <>
            <MoneyField
              label="Saldo de abertura"
              value={opening}
              onChange={setOpening}
              placeholder="opcional"
              hint="Deixe vazio para começar sem saldo."
            />
            <DateField label="Data do saldo" value={openingOn} onChange={setOpeningOn} />
          </>
        )}
      </FormGrid>
    </FormDialog>
  );
}
