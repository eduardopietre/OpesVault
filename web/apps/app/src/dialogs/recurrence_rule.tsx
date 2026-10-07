/**
 * Recorrência (desktop `RuleDialog` of `ui/pages/recurrences_page.py`): a fixed bill or an expected income,
 * with the amount the person expects, how much it may vary and when it falls due. Used to create a rule,
 * to create one from a charge that repeats (`suggestion`) and to edit one. A forecast never changes a
 * balance (docs/04 §3).
 */
import { AccountType, DomainError, ZERO, dom, type Id, type IsoDate, type Ledger } from "@opesvault/domain";
import { DateField, MoneyField, Select, TextField, type SelectOption } from "@opesvault/ui";
import { useMemo, useState } from "react";
import { useWorkspace } from "../data/react.tsx";
import { balanceAccounts, categoryItems, withCurrent } from "./account_choices.ts";
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
import { dateText, editableMoney, readDate, readMoney } from "./form_readers.ts";

type Rule = dom.recurrence.RecurrenceRule;
type Frequency = Rule["frequency"];

const FREQUENCIES: readonly SelectOption[] = [
  { id: "monthly", label: "Mensal" },
  { id: "yearly", label: "Anual" },
  { id: "weekly", label: "Semanal" },
];

/** Income and expense categories in one list, each labelled by its kind. */
function categoryChoices(ledger: Ledger): SelectOption[] {
  return [
    ...categoryItems(ledger, AccountType.EXPENSE).map((o) => ({ ...o, label: `Despesa: ${o.label}` })),
    ...categoryItems(ledger, AccountType.INCOME).map((o) => ({ ...o, label: `Receita: ${o.label}` })),
  ];
}

export interface RecurrenceRuleDialogProps {
  open: boolean;
  onClose: () => void;
  /** The rule being edited; without one a new rule is created. */
  rule?: Rule | null;
  /** A charge that repeats (`dom.subscriptions.candidates`): fills the form of a new rule. */
  suggestion?: dom.subscriptions.Candidate | null;
  onDone?: (rule: Rule, created: boolean) => void;
}

/** Mounted with a fresh `key` for each opening, so the fields start from the given values. */
export function RecurrenceRuleDialog({
  open,
  onClose,
  rule = null,
  suggestion = null,
  onDone,
}: RecurrenceRuleDialogProps) {
  const workspace = useWorkspace();
  const ledger = workspace.ledger;
  const act = useFormAct();
  const accounts = useMemo(
    () => (rule ? withCurrent(ledger, balanceAccounts(ledger), rule.account_id) : balanceAccounts(ledger)),
    [ledger, rule],
  );
  const categories = useMemo(
    () => (rule ? withCurrent(ledger, categoryChoices(ledger), rule.counterpart_id) : categoryChoices(ledger)),
    [ledger, rule],
  );
  const [description, setDescription] = useState(rule?.description ?? suggestion?.description ?? "");
  const [account, setAccount] = useState<string | null>(rule?.account_id ?? suggestion?.accountId ?? null);
  const [counterpart, setCounterpart] = useState<string | null>(rule?.counterpart_id ?? suggestion?.categoryId ?? null);
  const [amount, setAmount] = useState(
    rule ? editableMoney(rule.amount) : suggestion ? editableMoney(suggestion.amount) : "",
  );
  const [tolerance, setTolerance] = useState(rule && !rule.tolerance.isZero() ? editableMoney(rule.tolerance) : "");
  const [frequency, setFrequency] = useState<string>(rule?.frequency ?? "monthly");
  const [day, setDay] = useState(String(rule?.day ?? suggestion?.day ?? 5));
  const [start, setStart] = useState(dateText(rule?.start ?? (`${workspace.today().slice(0, 8)}01` as IsoDate)));
  const [end, setEnd] = useState(optionalDateValue(rule?.end ?? null));
  const weekly = frequency === "weekly";

  const confirm = () => {
    const name = description.trim();
    if (!name) throw new DomainError("Informe a descrição.");
    if (account === null) throw new DomainError("Escolha a conta.");
    if (counterpart === null) throw new DomainError("Escolha a categoria.");
    const expected = readMoney(amount).abs();
    const accepted = (readMoney(tolerance, { allowEmpty: true }) ?? ZERO).abs();
    const number = Number(day);
    if (!weekly && (!/^\d+$/.test(day.trim()) || number < 1 || number > 31)) {
      throw new DomainError("O dia do vencimento vai de 1 a 31.");
    }
    const first = readDate(start, "O início");
    const last = readOptionalDate(end, "O fim");
    const fields = {
      description: name,
      account_id: account as Id,
      counterpart_id: counterpart as Id,
      amount: expected,
      tolerance: accepted,
      frequency: frequency as Frequency,
      day: weekly ? (rule?.day ?? 1) : number,
      start: first,
      end: last,
    };
    const saved = act((l) =>
      rule
        ? dom.recurrence.updateRule(l, { ...rule, ...fields }, "recorrência editada")
        : dom.recurrence.addRule(l, dom.recurrence.RecurrenceRuleSchema.parse(fields)),
    );
    onDone?.(saved, rule === null);
  };

  return (
    <FormDialog
      open={open}
      onClose={onClose}
      title={rule ? "Editar recorrência" : "Nova recorrência"}
      description={
        suggestion
          ? "Preenchida a partir de cobranças que se repetem. Confira antes de criar."
          : "Uma conta fixa ou uma receita esperada. O aplicativo prevê cada vencimento e avisa quando atrasa."
      }
      confirmLabel={rule ? "Salvar" : "Criar recorrência"}
      onConfirm={confirm}
    >
      <FormGrid>
        <FullRow>
          <TextField
            label="Descrição"
            value={description}
            onChange={setDescription}
            placeholder="ex.: Aluguel, Salário, Escola"
            autoComplete="off"
            maxLength={200}
            data-autofocus=""
          />
        </FullRow>
        <Select label="Conta" options={accounts} value={account} onChange={setAccount} placeholder="Escolha a conta" />
        <Select
          label="Categoria"
          options={categories}
          value={counterpart}
          onChange={setCounterpart}
          placeholder="Escolha a categoria"
        />
        <MoneyField label="Valor esperado" value={amount} onChange={setAmount} />
        <MoneyField
          label="Variação aceita"
          value={tolerance}
          onChange={setTolerance}
          placeholder="0,00"
          hint="Quanto o valor pago pode variar para mais ou para menos e ainda ser este compromisso (0 = valor exato)."
        />
        <Select label="Frequência" options={FREQUENCIES} value={frequency} onChange={setFrequency} />
        <TextField
          label="Dia do vencimento"
          type="number"
          inputMode="numeric"
          min={1}
          max={31}
          value={weekly ? "" : day}
          onChange={setDay}
          disabled={weekly}
          placeholder={weekly ? "a cada 7 dias" : undefined}
          hint={weekly ? "Semanal: repete a cada 7 dias a partir do início." : undefined}
        />
        <DateField label="Início" value={start} onChange={setStart} />
        <OptionalDateField label="Fim" value={end} onChange={setEnd} />
        <FullRow>
          <Caption>Previsões nunca alteram saldos: elas só aguardam o lançamento real.</Caption>
        </FullRow>
      </FormGrid>
    </FormDialog>
  );
}
