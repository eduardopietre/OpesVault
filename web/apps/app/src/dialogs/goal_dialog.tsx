/**
 * Meta (desktop `GoalDialog` of `ui/pages/goals_page.py`): a savings or net-worth target, optionally by a
 * date. A goal only follows a value the ledger already has; it never moves money (docs/09 §1.3 C).
 */
import { DomainError, dom, type Dec, type Id, type IsoDate } from "@opesvault/domain";
import { Checkbox, MoneyField, Select, TextField, type SelectOption } from "@opesvault/ui";
import { useMemo, useState } from "react";
import { useWorkspace } from "../data/react.tsx";
import { assetAccounts } from "./account_choices.ts";
import {
  Caption,
  FormDialog,
  FormGrid,
  FullRow,
  OptionalDateField,
  optionalDateValue,
  readOptionalDate,
  useFormAct,
} from "./livro_form.tsx";
import { editableMoney, readMoney } from "./form_readers.ts";

type Goal = dom.goals.Goal;

const KINDS: readonly SelectOption[] = Object.entries(dom.goals.KIND_LABELS).map(([id, label]) => ({ id, label }));

export interface GoalDialogProps {
  open: boolean;
  onClose: () => void;
  /** The goal being edited; without one a new goal is created. */
  goal?: Goal | null;
  /** For a new goal: an example the fields start with (the person keeps or changes it). */
  example?: GoalDraft | null;
  onDone?: (goal: Goal, created: boolean) => void;
}

export interface GoalDraft {
  name: string;
  kind: Goal["kind"];
  target: Dec | null;
  targetDate: IsoDate | null;
}

/** Mounted with a fresh `key` for each opening, so the fields start from the given values. */
export function GoalDialog({ open, onClose, goal = null, example = null, onDone }: GoalDialogProps) {
  const workspace = useWorkspace();
  const ledger = workspace.ledger;
  const act = useFormAct();
  // Asset accounts; an archived one stays listed only while the goal still uses it.
  const accounts = useMemo(() => {
    const chosen = new Set<string>(goal?.account_ids ?? []);
    const listed = assetAccounts(ledger);
    const extra = [...chosen]
      .filter((id) => !listed.some((o) => o.id === id) && ledger.accounts.get(id as Id))
      .map((id) => ({ id, label: `${ledger.account(id as Id).name} (arquivada)` }));
    return [...listed, ...extra];
  }, [ledger, goal]);
  const start = goal ? null : example;
  const [name, setName] = useState(goal?.name ?? start?.name ?? "");
  const [kind, setKind] = useState<string>(goal?.kind ?? start?.kind ?? "net_worth");
  const [chosen, setChosen] = useState<ReadonlySet<string>>(new Set(goal?.account_ids ?? []));
  const [target, setTarget] = useState(
    goal ? editableMoney(goal.target) : start?.target ? editableMoney(start.target) : "",
  );
  const [deadline, setDeadline] = useState(optionalDateValue(goal?.target_date ?? start?.targetDate ?? null));
  const byAccounts = kind === "accounts";

  const confirm = () => {
    const title = name.trim();
    if (!title) throw new DomainError("Dê um nome à meta.");
    const value = readMoney(target, { allowEmpty: true });
    if (value === null) throw new DomainError("Informe o valor da meta.");
    const fields = {
      name: title,
      kind: kind as Goal["kind"],
      target: value,
      target_date: readOptionalDate(deadline, "O prazo"),
      account_ids: byAccounts ? accounts.filter((o) => chosen.has(o.id)).map((o) => o.id as Id) : [],
    };
    const saved = act((l) =>
      goal
        ? dom.goals.updateGoal(l, { ...goal, ...fields }, "meta editada")
        : dom.goals.addGoal(l, dom.goals.GoalSchema.parse({ ...fields, created_on: workspace.today() })),
    );
    onDone?.(saved, goal === null);
  };

  const toggle = (id: string, on: boolean) =>
    setChosen((current) => {
      const next = new Set(current);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  return (
    <FormDialog
      open={open}
      onClose={onClose}
      title={goal ? "Editar meta" : "Nova meta"}
      description={
        start
          ? start.target
            ? "Um exemplo para começar: uma reserva de emergência de seis meses de gastos (pela média dos últimos três meses), em um ano. Mude o que quiser; a meta não movimenta dinheiro."
            : "Um exemplo para começar: uma reserva de emergência em um ano. Informe o valor e mude o que quiser; a meta não movimenta dinheiro."
          : "Acompanha quanto falta e em que ritmo o projeto chega lá. Não movimenta dinheiro."
      }
      confirmLabel={goal ? "Salvar" : "Criar meta"}
      onConfirm={confirm}
    >
      <FormGrid>
        <FullRow>
          <TextField
            label="Nome"
            value={name}
            onChange={setName}
            placeholder="ex.: Reserva de emergência, Entrada do apartamento"
            autoComplete="off"
            maxLength={80}
            data-autofocus=""
          />
        </FullRow>
        <Select label="Conta como" options={KINDS} value={kind} onChange={setKind} />
        <MoneyField label="Valor da meta" value={target} onChange={setTarget} />
        <FullRow>
          <fieldset className="flex min-w-0 flex-col gap-2">
            <legend className="mb-1 text-body font-medium text-text">Contas da meta</legend>
            {accounts.length ? (
              <div
                role="group"
                aria-label="Lista de contas"
                tabIndex={0}
                className="grid max-h-40 grid-cols-1 gap-x-4 gap-y-2 overflow-auto rounded-md border border-separator p-3 tablet:grid-cols-2"
              >
                {accounts.map((option) => (
                  <Checkbox
                    key={option.id}
                    label={option.label}
                    checked={byAccounts && chosen.has(option.id)}
                    disabled={!byAccounts}
                    onCheckedChange={(on) => toggle(option.id, on)}
                  />
                ))}
              </div>
            ) : (
              <Caption>Nenhuma conta de ativo cadastrada.</Caption>
            )}
            <Caption>
              {byAccounts
                ? "O saldo somado das contas marcadas, como a poupança da reserva."
                : "Patrimônio líquido: tudo o que o projeto tem menos o que deve. Para contar só algumas contas, escolha “Saldo de contas escolhidas”."}
            </Caption>
          </fieldset>
        </FullRow>
        <OptionalDateField label="Prazo" value={deadline} onChange={setDeadline} />
      </FormGrid>
    </FormDialog>
  );
}
