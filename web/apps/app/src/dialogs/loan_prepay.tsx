/**
 * Amortização antecipada (desktop `PrepaymentDialog`): simulates an early repayment as the user types, and
 * registering it is a separate, explicit choice. A simulation never records anything.
 */
import { DomainError, dom, formatBrl } from "@opesvault/domain";
import { DateField, MoneyField, Select, type SelectOption } from "@opesvault/ui";
import { useMemo, useState } from "react";
import { useWorkspace } from "../data/react.tsx";
import { liquidAccounts } from "./account_choices.ts";
import { Caption, FormDialog, useFormAct } from "./livro_form.tsx";
import { dateText, readDate, readMoney } from "./form_readers.ts";

export interface PrepaymentDialogProps {
  open: boolean;
  onClose: () => void;
  plan: dom.loans.LoanPlan;
  onDone?: (prepayment: dom.loans.LoanPrepayment) => void;
}

const MODES: SelectOption[] = Object.entries(dom.loans.MODE_LABELS).map(([id, label]) => ({ id, label }));

/** The lines of the simulation, or null while the amount is not one. */
function simulationLines(sim: dom.loans.PrepaymentSimulation): string[] {
  const lines = [
    `Juros a pagar: ${formatBrl(sim.interestBefore)} → ${formatBrl(sim.interestAfter)} (economia ${formatBrl(sim.interestSaved)})`,
    `Parcelas restantes: ${sim.installmentsBefore} → ${sim.installmentsAfter}`,
  ];
  if (sim.nextPaymentBefore !== null && sim.nextPaymentAfter !== null) {
    lines.push(`Próxima parcela: ${formatBrl(sim.nextPaymentBefore)} → ${formatBrl(sim.nextPaymentAfter)}`);
  }
  lines.push("Simulação: nada é registrado até você confirmar.");
  return lines;
}

export function PrepaymentDialog({ open, onClose, plan, onDone }: PrepaymentDialogProps) {
  const workspace = useWorkspace();
  const ledger = workspace.ledger;
  const act = useFormAct();
  const accounts = liquidAccounts(ledger);
  const [amount, setAmount] = useState("");
  const [mode, setMode] = useState<string>(dom.loans.PrepaymentMode.REDUCE_TERM);
  const [account, setAccount] = useState<string | null>(
    accounts.some((a) => a.id === plan.payment_account_id) ? plan.payment_account_id : (accounts[0]?.id ?? null),
  );
  const [when, setWhen] = useState(dateText(workspace.today()));

  const lines = useMemo(() => {
    try {
      const value = readMoney(amount, { allowEmpty: true });
      if (!value?.isPositive()) return null;
      return simulationLines(dom.loans.simulatePrepayment(ledger, plan.id, value, mode as dom.loans.PrepaymentMode));
    } catch {
      return null;
    }
  }, [ledger, plan.id, amount, mode]);

  const confirm = () => {
    const value = readMoney(amount, { allowEmpty: true });
    if (value === null || !value.isPositive()) throw new DomainError("Informe um valor positivo.");
    if (account === null) throw new DomainError("Cadastre a conta de onde sai o pagamento.");
    const on = readDate(when, "A data da amortização");
    const saved = act(
      (l) => dom.loans.prepay(l, plan.id, value, on, mode as dom.loans.PrepaymentMode, account),
      "amortizar financiamento",
    );
    onDone?.(saved);
  };

  return (
    <FormDialog
      open={open}
      onClose={onClose}
      title={`Amortização antecipada — ${plan.name}`}
      confirmLabel="Registrar amortização"
      size="sm"
      onConfirm={confirm}
    >
      <div className="flex flex-col gap-4">
        <MoneyField label="Valor da amortização" value={amount} onChange={setAmount} data-autofocus="" />
        <Select label="Efeito" options={MODES} value={mode} onChange={setMode} />
        <Select
          label="Pago pela conta"
          options={accounts}
          value={account}
          onChange={setAccount}
          placeholder="Nenhuma conta de dinheiro"
        />
        <DateField label="Data da amortização" value={when} onChange={setWhen} />
        <div
          role="status"
          aria-label="Resultado da simulação"
          className="rounded-lg bg-accent-soft px-3 py-2 text-caption text-text"
        >
          {lines ? (
            <ul className="flex flex-col gap-0.5">
              {lines.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          ) : (
            <p className="text-secondary">Informe um valor para ver a economia.</p>
          )}
        </div>
        <Caption>O valor inteiro amortiza a dívida, sem juros, depois da última parcela paga.</Caption>
      </div>
    </FormDialog>
  );
}
