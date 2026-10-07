/**
 * Conta bancária (desktop `BankAccountDialog`): bank by the COMPE list (or another institution), branch,
 * number, one holder or two (a joint account), and the parts inside: checking and savings, each new or an
 * existing ledger account. The investments held there come in through "Novo investimento".
 */
import { DomainError, catalogs, dom, type Dec, type Id, type IsoDate } from "@opesvault/domain";
import {
  Checkbox,
  Combobox,
  compareLabels,
  DateField,
  MoneyField,
  Select,
  TextField,
  type SelectOption,
} from "@opesvault/ui";
import { useMemo, useState } from "react";
import { useWorkspace } from "../data/react.tsx";
import { memberChoices } from "./accounts_labels.ts";
import { Caption, FormDialog, FormGrid, FullRow, NONE, useFormAct } from "./livro_form.tsx";
import { readDate, readMoney } from "./form_readers.ts";

const { banking } = dom;

/** The bank choice that stands for an institution outside the COMPE list. */
export const OTHER_BANK = "__outra__";

export interface BankAccountDialogProps {
  open: boolean;
  onClose: () => void;
  item?: dom.banking.BankAccount;
  onDone?: (item: dom.banking.BankAccount, created: boolean) => void;
}

/** Every bank with a COMPE code, found by typing part of the code or the name, and "Outra instituição". */
export function bankOptions(): SelectOption[] {
  return [
    ...catalogs.banks().map((b) => ({ id: b.code, label: catalogs.bankLabel(b), keywords: b.short_name })),
    { id: OTHER_BANK, label: "Outra instituição (sem código COMPE)" },
  ];
}

interface PartState {
  include: boolean;
  /** NONE: create a new ledger account; else the id of an existing one to use. */
  source: string;
  opening: string;
}

const PARTS = [banking.Part.CHECKING, banking.Part.SAVINGS] as const;

function partField(item: dom.banking.BankAccount | undefined, part: dom.banking.Part): Id | null {
  if (!item) return null;
  return part === banking.Part.CHECKING ? item.checking_id : item.savings_id;
}

export function BankAccountDialog({ open, onClose, item, onDone }: BankAccountDialogProps) {
  const workspace = useWorkspace();
  const ledger = workspace.ledger;
  const act = useFormAct();
  const banks = useMemo(() => bankOptions(), []);
  const members = memberChoices(ledger, item ? [item.holder_id, item.co_holder_id] : []);
  const [name, setName] = useState(item?.name ?? "");
  const [bank, setBank] = useState<string | null>(item ? (item.bank_code ?? OTHER_BANK) : null);
  const [otherBank, setOtherBank] = useState(item && item.bank_code === null ? item.bank_name : "");
  const [branch, setBranch] = useState(item?.branch ?? "");
  const [number, setNumber] = useState(item?.number ?? "");
  const [holder, setHolder] = useState<string | null>(item?.holder_id ?? members[0]?.id ?? null);
  const [joint, setJoint] = useState(item ? banking.joint(item) : false);
  const [coHolder, setCoHolder] = useState<string | null>(
    item?.co_holder_id ?? members.find((m) => m.id !== (item?.holder_id ?? members[0]?.id))?.id ?? null,
  );
  const [parts, setParts] = useState<Record<string, PartState>>(() =>
    Object.fromEntries(
      PARTS.map((part) => [part, { include: partField(item, part) !== null, source: NONE, opening: "" }]),
    ),
  );
  const [openingOn, setOpeningOn] = useState(`01/01/${workspace.today().slice(0, 4)}`);

  const change = (part: string, patch: Partial<PartState>) =>
    setParts((current) => ({ ...current, [part]: { ...current[part]!, ...patch } }));

  /** Ledger accounts of the right subtype that no bank account holds yet, to reuse instead of creating. */
  const free = (part: dom.banking.Part): SelectOption[] => {
    const subtype = banking.PART_SUBTYPES[part];
    return [...ledger.accounts.values()]
      .filter((a) => a.subtype === subtype && !a.archived && banking.ofAccount(ledger, a.id) === null)
      .sort((a, b) => compareLabels(a.name, b.name))
      .map((a) => ({ id: a.id, label: `Usar ${a.name}` }));
  };

  const build = (): dom.banking.BankAccount => {
    if (bank === null) throw new DomainError("Escolha o banco na lista ou Outra instituição.");
    if (holder === null) throw new DomainError("Cadastre o titular em Integrantes antes.");
    const built = banking.build({
      name,
      bank_code: bank === OTHER_BANK ? null : bank,
      bank_name: bank === OTHER_BANK ? otherBank : null,
      branch,
      number,
      holder_id: holder,
      co_holder_id: joint ? coHolder : null,
    });
    if (!item) return built;
    return {
      ...item,
      name: built.name,
      bank_code: built.bank_code,
      bank_name: built.bank_name,
      branch: built.branch,
      number: built.number,
      holder_id: built.holder_id,
      co_holder_id: built.co_holder_id,
    };
  };

  const confirm = () => {
    const built = build();
    /** What each part asks for: false (not wanted or already there), true (new) or an existing account's id. */
    const wanted = (part: dom.banking.Part): boolean | Id => {
      const state = parts[part]!;
      if (partField(item, part) !== null || !state.include) return false;
      return state.source === NONE ? true : state.source;
    };
    // The opening balance is typed only for a part that is created here.
    const typed = PARTS.filter((part) => wanted(part) === true && parts[part]!.opening.trim() !== "");
    const on: IsoDate | null = typed.length ? readDate(openingOn, "A data do saldo inicial") : null;
    const openings = new Map<dom.banking.Part, readonly [Dec, IsoDate]>();
    for (const part of typed) {
      const value = readMoney(parts[part]!.opening);
      if (!value.isZero() && on) openings.set(part, [value, on]);
    }
    const saved = act((l) => {
      if (!item) {
        return banking.create(l, built, {
          checking: wanted(banking.Part.CHECKING),
          savings: wanted(banking.Part.SAVINGS),
          opening: openings,
        });
      }
      let next = built;
      const add: dom.banking.Part[] = [];
      for (const part of PARTS) {
        const chosen = wanted(part);
        if (chosen === true) add.push(part);
        else if (typeof chosen === "string") {
          next = part === banking.Part.CHECKING ? { ...next, checking_id: chosen } : { ...next, savings_id: chosen };
        }
      }
      const result = banking.update(l, next, add);
      for (const [part, [value, when]] of openings) {
        const accountId = banking.components(result).find(([p]) => p === part)?.[1] ?? null;
        if (accountId !== null) l.recordOpeningBalance(accountId, value, when);
      }
      return result;
    });
    onDone?.(saved, item === undefined);
  };

  return (
    <FormDialog
      open={open}
      onClose={onClose}
      title={item ? "Editar conta bancária" : "Nova conta bancária"}
      confirmLabel="Salvar"
      size="lg"
      onConfirm={confirm}
    >
      <FormGrid>
        <FullRow>
          <TextField
            label="Nome da conta"
            value={name}
            onChange={setName}
            maxLength={120}
            placeholder="ex.: Itaú da Ana (vazio: nome do banco)"
            autoComplete="off"
            data-autofocus=""
          />
        </FullRow>
        <FullRow>
          <Combobox
            label="Banco"
            options={banks}
            value={bank}
            onChange={setBank}
            placeholder="Digite o código ou parte do nome"
            hint="Lista de códigos COMPE, embutida no aplicativo."
          />
        </FullRow>
        <FullRow>
          <TextField
            label="Nome da instituição"
            value={otherBank}
            onChange={setOtherBank}
            maxLength={150}
            disabled={bank !== OTHER_BANK}
            placeholder="nome da instituição"
            autoComplete="off"
          />
        </FullRow>
        <TextField
          label="Agência"
          value={branch}
          onChange={setBranch}
          maxLength={30}
          placeholder="ex.: 0123-4"
          autoComplete="off"
        />
        <TextField
          label="Número da conta"
          value={number}
          onChange={setNumber}
          maxLength={30}
          placeholder="ex.: 12345-6"
          autoComplete="off"
        />
        <Select label="Titular" options={members} value={holder} onChange={setHolder} placeholder="Sem integrantes" />
        <div className="flex min-w-0 flex-col gap-1.5">
          <Select
            label="Segundo titular"
            options={members.filter((m) => m.id !== holder)}
            value={coHolder}
            onChange={setCoHolder}
            disabled={!joint}
          />
        </div>
        <FullRow>
          <Checkbox label="Conta conjunta" checked={joint} onCheckedChange={setJoint} />
        </FullRow>
        {PARTS.map((part) => {
          const label = banking.PART_LABELS[part];
          const existing = partField(item, part);
          const state = parts[part]!;
          const isNew = existing === null && state.include && state.source === NONE;
          return (
            <FullRow key={part}>
              <fieldset className="grid min-w-0 gap-3 rounded-lg border border-separator p-3 tablet:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
                <legend className="px-1 text-body font-medium text-text">{label}</legend>
                <div className="tablet:col-span-2">
                  <Checkbox
                    label={`Incluir ${label.toLowerCase()}`}
                    checked={state.include}
                    disabled={existing !== null}
                    onCheckedChange={(include) => change(part, { include })}
                  />
                </div>
                <Select
                  label={`${label}: nova ou existente`}
                  options={
                    existing !== null
                      ? [{ id: NONE, label: ledger.account(existing).name }]
                      : [{ id: NONE, label: "Criar nova" }, ...free(part)]
                  }
                  value={state.source}
                  onChange={(source) => change(part, { source })}
                  disabled={existing !== null || !state.include}
                />
                <MoneyField
                  label={`${label}: saldo inicial`}
                  value={state.opening}
                  onChange={(opening) => change(part, { opening })}
                  disabled={!isNew}
                  placeholder="opcional"
                />
              </fieldset>
            </FullRow>
          );
        })}
        <FullRow>
          <DateField label="Data do saldo inicial" value={openingOn} onChange={setOpeningOn} />
        </FullRow>
        <FullRow>
          <Caption>
            Agência e conta aceitam letras, números e símbolos, sem espaços. Uma conta pode ter só corrente, só
            poupança, as duas ou nenhuma (só investimentos); os investimentos entram por Novo investimento.
          </Caption>
        </FullRow>
      </FormGrid>
    </FormDialog>
  );
}
