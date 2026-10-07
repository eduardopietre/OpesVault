/**
 * Novo lançamento (desktop `ui/dialogs.py` `OperationDialog`): manual income, expense, transfer, card
 * purchase (in installments too) and bill payment (RF-10). While no category was picked, the description
 * suggests the usual one from the family's history; with the local AI on, a description the history does not
 * know can be asked to the model, which only selects the category. Expenses and card purchases can also be
 * split between categories (rateio); who pays each share is the postings editor's job ("Corrigir partidas").
 */
import {
  AccountType,
  DomainError,
  Dec,
  ai,
  cmpStr,
  dom,
  importing,
  type Id,
  type Ledger,
  type OperationInput,
} from "@opesvault/domain";
import { Button, DateField, MoneyField, Select, Switch, TextField, type SelectOption } from "@opesvault/ui";
import { Plus, Sparkles, Trash2 } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { failureText, rememberModel, useAiClient } from "../data/ai.ts";
import { useWorkspace } from "../data/react.tsx";
import { assetAccounts, balanceAccounts, cardItems, categoryItems, liquidAccounts } from "./account_choices.ts";
import {
  Caption,
  FormDialog,
  FormGrid,
  FullRow,
  NONE,
  competenceFromChoice,
  competenceOptions,
  memberFromChoice,
  memberOptions,
  useFormAct,
} from "./livro_form.tsx";
import { dateText, editableMoney, readDate, readMoney } from "./form_readers.ts";

export type OperationKindKey = "income" | "expense" | "transfer" | "card_purchase" | "card_payment";

/** The kinds the "Novo lançamento" menu offers, in the desktop's order. */
export const OPERATION_KINDS: Readonly<Record<OperationKindKey, string>> = {
  income: "Receita",
  expense: "Despesa",
  transfer: "Transferência",
  card_purchase: "Compra no cartão",
  card_payment: "Pagamento de fatura",
};

const POLICIES: SelectOption[] = [
  { id: "purchase", label: "Despesa inteira no mês da compra" },
  { id: "spread", label: "Despesa distribuída nas parcelas" },
];

interface SplitRow {
  key: number;
  category: string | null;
  amount: string;
}

export interface OperationDialogProps {
  open: boolean;
  onClose: () => void;
  kind: OperationKindKey;
  /** After the entry was recorded: its kind and the id of the (first) operation created. */
  onDone?: (kind: OperationKindKey, id: Id | null) => void;
}

function firstId(options: readonly SelectOption[], not: string | null = null): string | null {
  return options.find((o) => o.id !== not)?.id ?? options[0]?.id ?? null;
}

export function OperationDialog({ open, onClose, kind, onDone }: OperationDialogProps) {
  const workspace = useWorkspace();
  const ledger = workspace.ledger;
  const today = workspace.today();
  const act = useFormAct();
  const client = useAiClient();

  const categoryType = kind === "income" ? AccountType.INCOME : AccountType.EXPENSE;
  const sources = useMemo<SelectOption[]>(() => {
    switch (kind) {
      case "income":
        return categoryItems(ledger, AccountType.INCOME);
      case "expense":
        return assetAccounts(ledger);
      case "transfer":
        return balanceAccounts(ledger);
      default:
        return cardItems(ledger);
    }
  }, [ledger, kind]);
  const targets = useMemo<SelectOption[]>(() => {
    switch (kind) {
      case "income":
        return assetAccounts(ledger);
      case "transfer":
        return balanceAccounts(ledger);
      case "card_payment":
        return liquidAccounts(ledger);
      default:
        return categoryItems(ledger, AccountType.EXPENSE);
    }
  }, [ledger, kind]);
  const members = useMemo(() => memberOptions(ledger), [ledger]);
  const competences = useMemo(() => competenceOptions(null, today), [today]);
  const categoryOptions = kind === "income" ? sources : targets;
  const hasCategory = kind === "income" || kind === "expense" || kind === "card_purchase";
  const canSplit = kind === "expense" || kind === "card_purchase";

  const [description, setDescription] = useState("");
  const [amount, setAmount] = useState("");
  const [when, setWhen] = useState(dateText(today));
  const [competence, setCompetence] = useState(NONE);
  const [source, setSource] = useState<string | null>(firstId(sources));
  const [target, setTarget] = useState<string | null>(
    kind === "transfer" ? firstId(targets, firstId(sources)) : firstId(targets),
  );
  const [member, setMember] = useState(NONE);
  const [installments, setInstallments] = useState("1");
  const [policy, setPolicy] = useState("purchase");
  const [split, setSplit] = useState(false);
  const [parts, setParts] = useState<SplitRow[]>([
    { key: 1, category: firstId(categoryOptions), amount: "" },
    { key: 2, category: firstId(categoryOptions), amount: "" },
  ]);
  const nextKey = useRef(3);

  // The category the description suggests, until a person picks one (the model's answer only selects too).
  const [hint, setHint] = useState("");
  const [asking, setAsking] = useState(false);
  const [canAsk, setCanAsk] = useState(false);
  const alive = useRef(true);
  const chosenRef = useRef(false);
  const setCategory = (id: string | null) => (kind === "income" ? setSource(id) : setTarget(id));

  const pickCategory = (id: string) => {
    chosenRef.current = true;
    setHint("");
    setCanAsk(false);
    setCategory(id);
  };

  const onDescription = (text: string) => {
    setDescription(text);
    if (!hasCategory || chosenRef.current) return;
    const typed = text.trim();
    const found = importing.learning.suggest(ledger, typed, categoryType);
    if (found !== null && categoryOptions.some((o) => o.id === found.category_id)) {
      setCategory(found.category_id);
      const detail = importing.learning.describeSource(found.source) ?? "histórico";
      setHint(`Categoria sugerida pelo uso (${detail}). Escolha outra se não for.`);
      setCanAsk(false);
      return;
    }
    // Nothing learned: the model may help, if the person asks.
    setHint("");
    setCanAsk(typed.length >= 3 && !asking);
  };

  const askAi = async () => {
    const request = importing.aiSuggestions.planDescription(ledger, description, categoryType);
    if (client === null || request === null || asking) return;
    rememberModel(client);
    setAsking(true);
    setCanAsk(false);
    setHint("Perguntando à IA local…");
    try {
      await client.checkModel();
      const run = await client.suggestCategories(
        request.descriptions,
        [...request.categories.keys()].sort(cmpStr),
        request.examples,
      );
      if (!alive.current) return;
      setAsking(false);
      if (chosenRef.current) return;
      const suggested = run.suggestions[0];
      const found = suggested ? request.categories.get(suggested.category) : undefined;
      if (found === undefined || !categoryOptions.some((o) => o.id === found)) {
        setHint("A IA local não teve segurança para sugerir. Escolha a categoria.");
        return;
      }
      setCategory(found);
      setHint(`Categoria sugerida pela IA local (${client.model}). Confira antes de registrar.`);
    } catch (error) {
      if (!(error instanceof ai.ollama.AiUnavailable)) throw error;
      if (!alive.current) return;
      setAsking(false);
      setHint(`IA local: ${failureText(error)}`);
      setCanAsk(true);
    }
  };

  const count = Number.parseInt(installments, 10);
  const installing = kind === "card_purchase" && Number.isInteger(count) && count > 1;
  const splitting = split && canSplit && !installing;
  const splitTotal = parts.reduce((sum, p) => {
    try {
      return sum.add(p.amount.trim() ? readMoney(p.amount) : Dec.from(0));
    } catch {
      return sum;
    }
  }, Dec.from(0));
  const total = ((): Dec | null => {
    try {
      return amount.trim() ? readMoney(amount) : null;
    } catch {
      return null;
    }
  })();
  const difference = total !== null ? total.sub(splitTotal) : null;

  const validate = () => {
    if (!source || (!splitting && !target)) {
      throw new DomainError("Cadastre as contas, cartões e categorias necessários.");
    }
    const value = readMoney(amount);
    if (!value.isPositive()) throw new DomainError("Informe um valor positivo.");
    if (kind === "card_purchase" && (!Number.isInteger(count) || count < 1 || count > 72)) {
      throw new DomainError("Informe de 1 a 72 parcelas.");
    }
    return value;
  };

  const confirm = () => {
    const value = validate();
    const on = readDate(when);
    const label = description.trim() || OPERATION_KINDS[kind];
    const extra: Partial<OperationInput> = hasCategory
      ? { accrual_month: competenceFromChoice(competence), member_id: memberFromChoice(member) }
      : {};
    let splits: Id | [Id, Dec][] | null = null;
    if (splitting) {
      const rows = parts.filter((p) => p.amount.trim() || p.category);
      if (rows.some((p) => !p.category)) throw new DomainError("Escolha a categoria de cada parte do rateio.");
      splits = rows.map((p) => [p.category as Id, readMoney(p.amount)] as [Id, Dec]);
      if (splits.length < 2) throw new DomainError("Um rateio tem ao menos duas categorias.");
    }
    const run = (ledger: Ledger): Id | null => {
      const from = source as Id;
      const to = (target ?? "") as Id;
      switch (kind) {
        case "income":
          return ledger.recordIncome(to, from, value, on, label, extra).id;
        case "expense":
          return ledger.recordExpense(from, splits ?? to, value, on, label, extra).id;
        case "transfer":
          return ledger.recordTransfer(from, to, value, on, label).id;
        case "card_purchase": {
          if (!installing) return ledger.recordCardPurchase(from, splits ?? to, value, on, label, null, extra).id;
          // The policy decides the competence of each part.
          const { accrual_month: _ignored, ...rest } = extra;
          const plan = dom.cards.recordInstallmentPurchase(
            ledger,
            from,
            to,
            value,
            on,
            label,
            count,
            policy as dom.cards.CompetencePolicy,
            rest,
          );
          return plan.operation_ids[0] ?? null;
        }
        case "card_payment":
          return ledger.recordCardPayment(from, to, value, on).id;
      }
    };
    const created = act(run);
    onDone?.(kind, created);
  };

  const accountLabels: Record<OperationKindKey, [string, string]> = {
    income: ["Categoria", "Conta de destino"],
    expense: ["Conta de origem", "Categoria"],
    transfer: ["De", "Para"],
    card_purchase: ["Cartão", "Categoria"],
    card_payment: ["Cartão", "Pago pela conta"],
  };
  const [sourceLabel, targetLabel] = accountLabels[kind];
  const sourceSelect = (
    <Select
      label={sourceLabel}
      options={sources}
      value={source}
      onChange={kind === "income" ? pickCategory : setSource}
      placeholder={sources.length ? "Escolha…" : "Nenhuma disponível"}
    />
  );
  const targetSelect = (
    <Select
      label={targetLabel}
      options={targets}
      value={target}
      onChange={kind === "income" || kind === "transfer" || kind === "card_payment" ? setTarget : pickCategory}
      placeholder={targets.length ? "Escolha…" : "Nenhuma disponível"}
    />
  );
  const hintBlock =
    hasCategory && (hint || canAsk) ? (
      <FullRow>
        <div className="flex flex-wrap items-center gap-2" aria-live="polite">
          {hint ? <Caption>{hint}</Caption> : null}
          {canAsk && client !== null ? (
            <Button
              size="sm"
              variant="ghost"
              icon={<Sparkles />}
              onClick={() => void askAi()}
              title="Sugere a categoria pela descrição; só a descrição vai ao Ollama deste computador"
            >
              Perguntar à IA local
            </Button>
          ) : null}
        </div>
      </FullRow>
    ) : null;

  return (
    <FormDialog
      open={open}
      onClose={() => {
        alive.current = false;
        onClose();
      }}
      title={OPERATION_KINDS[kind]}
      description="Registra uma operação manual no livro."
      confirmLabel="Registrar"
      onConfirm={confirm}
      size="md"
    >
      <FormGrid>
        {kind !== "card_payment" ? (
          <FullRow>
            <TextField
              label="Descrição"
              value={description}
              onChange={onDescription}
              placeholder={OPERATION_KINDS[kind]}
              autoComplete="off"
            />
          </FullRow>
        ) : null}
        <MoneyField label="Valor" value={amount} onChange={setAmount} />
        <DateField label="Data" value={when} onChange={setWhen} />
        {kind === "income" ? (
          <>
            {sourceSelect}
            {targetSelect}
          </>
        ) : null}
        {kind === "expense" || kind === "card_purchase" ? (
          <>
            {sourceSelect}
            {splitting ? null : targetSelect}
          </>
        ) : null}
        {kind === "transfer" || kind === "card_payment" ? (
          <>
            {sourceSelect}
            {targetSelect}
          </>
        ) : null}
        {hintBlock}
        {kind === "card_purchase" ? (
          <>
            <TextField
              label="Parcelas"
              value={installments}
              onChange={setInstallments}
              inputMode="numeric"
              autoComplete="off"
              hint={installing ? "Parcelas iguais; os centavos que sobram vão para as primeiras." : undefined}
            />
            <Select label="Competência das parcelas" options={POLICIES} value={policy} onChange={setPolicy} />
          </>
        ) : null}
        {hasCategory && !(kind === "card_purchase" && installing) ? (
          <>
            <Select
              label="Competência"
              options={competences}
              value={competence}
              onChange={setCompetence}
              hint="Mês em que a despesa ou receita conta nos relatórios."
            />
            <Select label="Responsável" options={members} value={member} onChange={setMember} />
          </>
        ) : null}
        {hasCategory && installing ? (
          <FullRow>
            <Select label="Responsável" options={members} value={member} onChange={setMember} />
          </FullRow>
        ) : null}
        {canSplit && !installing ? (
          <FullRow>
            <Switch
              label="Ratear entre categorias"
              description="Divide o valor em partes de categorias diferentes (um mercado com itens de casa e de saúde)."
              checked={split}
              onCheckedChange={setSplit}
            />
          </FullRow>
        ) : null}
        {splitting ? (
          <FullRow>
            <fieldset className="flex flex-col gap-3 rounded-lg border border-separator p-3">
              <legend className="px-1 text-body font-medium">Partes do rateio</legend>
              {parts.map((part, index) => (
                <div key={part.key} className="grid grid-cols-[minmax(0,1fr)_minmax(0,9rem)_auto] items-end gap-2">
                  <Select
                    label={`Categoria da parte ${index + 1}`}
                    options={targets}
                    value={part.category}
                    onChange={(id) =>
                      setParts((rows) => rows.map((p) => (p.key === part.key ? { ...p, category: id } : p)))
                    }
                  />
                  <MoneyField
                    label={`Valor da parte ${index + 1}`}
                    value={part.amount}
                    onChange={(text) =>
                      setParts((rows) => rows.map((p) => (p.key === part.key ? { ...p, amount: text } : p)))
                    }
                  />
                  <Button
                    variant="ghost"
                    size="md"
                    aria-label={`Remover a parte ${index + 1}`}
                    title="Remover a parte"
                    disabled={parts.length <= 2}
                    onClick={() => setParts((rows) => rows.filter((p) => p.key !== part.key))}
                  >
                    <Trash2 aria-hidden="true" className="size-4" />
                  </Button>
                </div>
              ))}
              <div className="flex flex-wrap items-center justify-between gap-2">
                <Button
                  size="sm"
                  icon={<Plus />}
                  onClick={() =>
                    setParts((rows) => [...rows, { key: nextKey.current++, category: firstId(targets), amount: "" }])
                  }
                >
                  Adicionar parte
                </Button>
                <span className="text-caption text-secondary" aria-live="polite">
                  {difference === null
                    ? "Informe o valor total."
                    : difference.isZero()
                      ? "Rateio fechado ✓"
                      : `${difference.isPositive() ? "Faltam" : "Passam"} ${editableMoney(difference.abs())} para fechar`}
                </span>
              </div>
            </fieldset>
          </FullRow>
        ) : null}
      </FormGrid>
    </FormDialog>
  );
}
