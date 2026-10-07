/**
 * Regras de renda variável (desktop `VariableRulesDialog`): the rates of stock, ETF and real estate fund gains
 * and the monthly exemption limit, as the person informs them. Without a rate the tax stays unknown.
 */
import { makeDate, tax } from "@opesvault/domain";
import { DateField, MoneyField, TextField } from "@opesvault/ui";
import { useState } from "react";
import { useWorkspace } from "../data/react.tsx";
import { Caption, FormDialog, FormGrid, FullRow, useFormAct } from "./livro_form.tsx";
import { percentText } from "./tax_fields.tsx";
import { dateText, editableMoney, readDate, readMoney, readPercent } from "./form_readers.ts";

const BUCKETS = Object.keys(tax.model.BUCKET_LABELS) as tax.model.Bucket[];

export interface VariableRulesDialogProps {
  open: boolean;
  onClose: () => void;
  onDone?: () => void;
}

export function VariableRulesDialog({ open, onClose, onDone }: VariableRulesDialogProps) {
  const workspace = useWorkspace();
  const ledger = workspace.ledger;
  const act = useFormAct();
  const current = tax.records.variableRules(ledger);
  const [validFrom, setValidFrom] = useState(
    dateText(current ? current.valid_from : makeDate(Number(workspace.today().slice(0, 4)), 1, 1)),
  );
  const [rates, setRates] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      BUCKETS.map((bucket) => {
        const rule = current ? tax.model.ruleOf(current, bucket) : null;
        return [bucket, percentText(rule ? rule.rate : null)];
      }),
    ),
  );
  const common = current ? tax.model.ruleOf(current, tax.model.Bucket.COMMON) : null;
  const [limit, setLimit] = useState(common?.exempt_sales_limit ? editableMoney(common.exempt_sales_limit) : "");
  const [source, setSource] = useState(current?.source ?? "");

  const confirm = () => {
    const exempt = readMoney(limit, { allowEmpty: true });
    const rules = BUCKETS.map((bucket) =>
      tax.model.BucketRuleSchema.parse({
        bucket,
        rate: readPercent(rates[bucket] ?? "", tax.model.BUCKET_LABELS[bucket]),
        exempt_sales_limit: bucket === tax.model.Bucket.COMMON ? exempt : null,
      }),
    );
    const from = readDate(validFrom, "A data de início da vigência");
    act((l) => tax.records.setVariableRules(l, from, rules, source));
    onDone?.();
  };

  return (
    <FormDialog
      open={open}
      onClose={onClose}
      title="Regras de renda variável"
      confirmLabel="Salvar"
      onConfirm={confirm}
    >
      <FormGrid>
        <FullRow>
          <DateField label="Vale a partir de" value={validFrom} onChange={setValidFrom} data-autofocus="" />
        </FullRow>
        {BUCKETS.map((bucket) => (
          <TextField
            key={bucket}
            label={`${tax.model.BUCKET_LABELS[bucket]} (%)`}
            value={rates[bucket] ?? ""}
            onChange={(value) => setRates((all) => ({ ...all, [bucket]: value }))}
            inputMode="decimal"
            autoComplete="off"
            placeholder="alíquota em %"
            className="text-right tabular-nums"
          />
        ))}
        <MoneyField
          label="Vendas de ações isentas até"
          value={limit}
          onChange={setLimit}
          placeholder="sem isenção"
          hint="Total mensal de vendas de ações."
        />
        <FullRow>
          <TextField
            label="Fonte"
            value={source}
            onChange={setSource}
            maxLength={300}
            autoComplete="off"
            placeholder="de onde vieram os valores"
          />
        </FullRow>
        <FullRow>
          <Caption>
            Nada vem preenchido: informe as alíquotas e o limite vigentes. Prejuízos são compensados nos meses seguintes
            dentro do mesmo tipo (comuns, day trade, fundos imobiliários). Sem alíquota, o imposto fica desconhecido.
          </Caption>
        </FullRow>
      </FormGrid>
    </FormDialog>
  );
}
