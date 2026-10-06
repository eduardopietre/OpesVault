/**
 * Regra de categoria (desktop `RuleDialog`): "a descrição contém X → categoria Y", for any account or one.
 * Shows how many pending import items it would categorize before it is saved; categories chosen by hand
 * stay as they are. Editing asks the reason, kept in the history.
 */
import { AccountType, DomainError, importing, type Id } from "@opesvault/domain";
import { Checkbox, Select, TextField, type SelectOption } from "@opesvault/ui";
import { useMemo, useState } from "react";
import { useWorkspace } from "../data/react.tsx";
import { categoryItems } from "./account_choices.ts";
import { Caption, FormDialog, FormGrid, FullRow, NONE, useFormAct } from "./livro_form.tsx";

const { rules, suggestions, importStore, importModel } = importing;

export interface RuleDialogProps {
  open: boolean;
  onClose: () => void;
  rule?: importing.rules.CategoryRule;
  /** A description to start the pattern from (a learned proposal, an import item). */
  description?: string;
  targetId?: Id | null;
  /** The account the rule is limited to when it starts from an item. */
  accountId?: Id | null;
  /** The import item that gave rise to the rule. */
  fromItem?: Id | null;
  onDone?: (rule: importing.rules.CategoryRule, changed: number) => void;
}

export function RuleDialog({
  open,
  onClose,
  rule,
  description = "",
  targetId = null,
  accountId = null,
  fromItem = null,
  onDone,
}: RuleDialogProps) {
  const ledger = useWorkspace().ledger;
  const act = useFormAct();
  const targets = useMemo<SelectOption[]>(
    () => [
      ...categoryItems(ledger, AccountType.EXPENSE).map((o) => ({ ...o, label: `Despesa: ${o.label}` })),
      ...categoryItems(ledger, AccountType.INCOME).map((o) => ({ ...o, label: `Receita: ${o.label}` })),
    ],
    [ledger],
  );
  const scoped = rule ? rule.account_id : accountId;
  const scopes = useMemo<SelectOption[]>(() => {
    const options: SelectOption[] = [{ id: NONE, label: "Qualquer conta ou cartão" }];
    const account = scoped ? ledger.accounts.get(scoped) : undefined;
    if (scoped && account) options.push({ id: scoped, label: `Só em ${account.name}` });
    return options;
  }, [ledger, scoped]);
  const [pattern, setPattern] = useState(rule ? rule.pattern : rules.suggestPattern(description));
  const [target, setTarget] = useState<string | null>(rule ? rule.target_account_id : targetId);
  const [scope, setScope] = useState<string>(rule ? (rule.account_id ?? NONE) : NONE);
  const [applyNow, setApplyNow] = useState(true);
  const [reason, setReason] = useState("");

  /** How many pending items the rule would categorize, before saving it. */
  const preview = useMemo(() => {
    const needle = rules.normalize(pattern);
    if (needle.length < rules.MIN_PATTERN) return `Digite ao menos ${rules.MIN_PATTERN} caracteres.`;
    const batches = importStore.batches(ledger);
    const restricted = scope === NONE ? null : scope;
    const hits = [...importStore.items(ledger).values()].filter(
      (i) =>
        (i.status === importModel.ItemStatus.READY || i.status === importModel.ItemStatus.NEEDS_REVIEW) &&
        rules.normalize(i.description).includes(needle) &&
        (restricted === null || batches.get(i.batch_id)?.account_id === restricted),
    );
    const manual = hits.filter((i) => i.target_account_id !== null && i.suggestion_source === null).length;
    return (
      `Pega ${hits.length} item(ns) pendente(s) agora.` +
      (manual ? ` ${manual} com categoria escolhida à mão continuam como estão.` : "")
    );
  }, [ledger, pattern, scope]);

  const confirm = () => {
    if (target === null) throw new DomainError("Escolha a categoria.");
    if (rules.normalize(pattern).length < rules.MIN_PATTERN) {
      throw new DomainError(`O texto precisa ter ao menos ${rules.MIN_PATTERN} caracteres.`);
    }
    if (rule && !reason.trim()) throw new DomainError("Informe o motivo da alteração.");
    const account = scope === NONE ? null : scope;
    const result = act((l) => {
      const saved = rule
        ? rules.updateRule(l, { ...rule, pattern, target_account_id: target, account_id: account }, reason.trim())
        : rules.addRule(l, pattern, target, account, fromItem);
      return { saved, changed: applyNow ? suggestions.applyRules(l) : 0 };
    });
    onDone?.(result.saved, result.changed);
  };

  return (
    <FormDialog
      open={open}
      onClose={onClose}
      title="Regra de categoria"
      confirmLabel={rule ? "Salvar regra" : "Criar regra"}
      onConfirm={confirm}
    >
      <FormGrid columns={1}>
        <TextField
          label="A descrição contém"
          value={pattern}
          onChange={setPattern}
          hint="Maiúsculas e acentos não importam."
          autoComplete="off"
          data-autofocus=""
          required
        />
        <Select
          label="Categoria"
          options={targets}
          value={target}
          onChange={setTarget}
          placeholder="Escolha a categoria"
        />
        <Select label="Vale para" options={scopes} value={scope} onChange={setScope} />
        <Checkbox
          label="Aplicar agora aos itens pendentes de revisão"
          checked={applyNow}
          onCheckedChange={setApplyNow}
        />
        <FullRow>
          <p role="status" className="text-caption text-secondary">
            {preview}
          </p>
        </FullRow>
        {rule ? (
          <TextField
            label="Motivo da alteração"
            value={reason}
            onChange={setReason}
            placeholder="obrigatório; fica no histórico"
            autoComplete="off"
          />
        ) : (
          <Caption>A regra sugere a categoria dos itens importados; nada é aprovado sozinho.</Caption>
        )}
      </FormGrid>
    </FormDialog>
  );
}
