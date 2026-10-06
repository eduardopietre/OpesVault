/**
 * Regra de imposto (desktop `EventCommands.new_rule`): a rule the person types for simulations. No rate, base
 * or limit is built in (docs/00 §5): the rule is the person's, with where it came from, and it is always
 * labelled as a simulation.
 */
import { DomainError, investments, type Id } from "@opesvault/domain";
import { MoneyField, Select, TextField, type SelectOption } from "@opesvault/ui";
import { useState } from "react";
import { readPercent } from "./investment_forms.ts";
import { Caption, FormDialog, FormGrid, FullRow, readMoney, useFormAct } from "./livro_form.tsx";

const { model } = investments;

const KINDS: SelectOption[] = [
  { id: model.TaxRuleKind.RATE_ON_POSITIVE_GAIN, label: "Percentual sobre ganho positivo" },
  { id: model.TaxRuleKind.RATE_ON_INFORMED_BASE, label: "Percentual sobre base informada" },
  { id: model.TaxRuleKind.FIXED, label: "Valor fixo" },
];

export interface InvestmentRuleDialogProps {
  open: boolean;
  onClose: () => void;
  onDone?: (ruleId: Id) => void;
}

export function InvestmentRuleDialog({ open, onClose, onDone }: InvestmentRuleDialogProps) {
  const act = useFormAct();
  const [name, setName] = useState("");
  const [kind, setKind] = useState<string>(model.TaxRuleKind.RATE_ON_POSITIVE_GAIN);
  const [rate, setRate] = useState("");
  const [fixed, setFixed] = useState("");
  const [source, setSource] = useState("informado pelo usuário");
  const isFixed = kind === model.TaxRuleKind.FIXED;

  const confirm = () => {
    if (!name.trim()) throw new DomainError("Informe o nome.");
    const percentage = isFixed ? null : readPercent(rate);
    const amount = isFixed ? readMoney(fixed) : null;
    if (!isFixed && percentage === null) throw new DomainError("Informe a alíquota: o aplicativo não traz nenhuma.");
    const saved = act((l) => {
      const rule = model.TaxRuleSchema.parse({
        name: name.trim(),
        kind,
        rate: percentage,
        fixed_amount: amount,
        source: source.trim() || "informado pelo usuário",
      });
      // the rule's version is text ("1"); the ledger's entity version is a number, which the history coerces
      l.put("tax_rule", rule as never);
      return rule;
    });
    onDone?.(saved.id);
  };

  return (
    <FormDialog
      open={open}
      onClose={onClose}
      title="Regra de imposto (simulação)"
      confirmLabel="Salvar"
      size="md"
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
        <FullRow>
          <Select label="Tipo" options={KINDS} value={kind} onChange={setKind} />
        </FullRow>
        {isFixed ? (
          <MoneyField label="Valor fixo" value={fixed} onChange={setFixed} />
        ) : (
          <TextField
            label="Alíquota (%)"
            value={rate}
            onChange={setRate}
            inputMode="decimal"
            autoComplete="off"
            placeholder="ex.: 15"
          />
        )}
        <TextField label="Fonte" value={source} onChange={setSource} maxLength={300} autoComplete="off" />
        <FullRow>
          <Caption>
            A regra é sua: o aplicativo não traz tabela, alíquota nem limite. O resultado do simulador sempre aparece
            como estimativa, com o nome desta regra.
          </Caption>
        </FullRow>
      </FormGrid>
    </FormDialog>
  );
}
