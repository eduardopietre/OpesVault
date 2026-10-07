/**
 * Aporte, Provento and Pagamento de imposto (desktop `EventCommands.contribution`, `distribution`, `pay_tax`).
 * A contribution is capital moved into the investment, never income; a distribution is income paid outside the
 * position; the tax payment settles tax that a redemption left due.
 */
import { DomainError, investments, type Id } from "@opesvault/domain";
import { DateField, MoneyField, Select } from "@opesvault/ui";
import { useState } from "react";
import { useWorkspace } from "../data/react.tsx";
import { cashAccounts } from "./investment_forms.ts";
import { Caption, FormDialog, FormGrid, useFormAct } from "./livro_form.tsx";
import { dateText, readDate, readMoney } from "./form_readers.ts";

const { service } = investments;

interface FlowProps {
  open: boolean;
  onClose: () => void;
  onDone?: () => void;
}

function useAccount() {
  const ledger = useWorkspace().ledger;
  const options = cashAccounts(ledger);
  const [account, setAccount] = useState<string | null>(options[0]?.id ?? null);
  const need = (): string => {
    if (account === null) throw new DomainError("Não há conta de dinheiro para movimentar. Cadastre uma em Contas.");
    return account;
  };
  return { options, account, setAccount, need };
}

export function InvestmentContributionDialog({
  open,
  onClose,
  onDone,
  positionId,
  name,
}: FlowProps & { positionId: Id; name: string }) {
  const workspace = useWorkspace();
  const act = useFormAct();
  const { options, account, setAccount, need } = useAccount();
  const [when, setWhen] = useState(dateText(workspace.today()));
  const [value, setValue] = useState("");

  const confirm = () => {
    const on = readDate(when);
    const amount = readMoney(value);
    const from = need();
    act((l) => service.contribute(l, positionId, amount, on, from), "registrar aporte");
    onDone?.();
  };

  return (
    <FormDialog
      open={open}
      onClose={onClose}
      title={`Aporte — ${name}`}
      confirmLabel="Registrar"
      size="sm"
      onConfirm={confirm}
    >
      <FormGrid columns={1}>
        <DateField label="Data" value={when} onChange={setWhen} />
        <MoneyField label="Valor" value={value} onChange={setValue} data-autofocus="" />
        <Select
          label="Saiu da conta"
          options={options}
          value={account}
          onChange={setAccount}
          placeholder="Nenhuma conta"
        />
        <Caption>Um aporte é capital que passa a estar no investimento; não é rendimento.</Caption>
      </FormGrid>
    </FormDialog>
  );
}

export function InvestmentDistributionDialog({
  open,
  onClose,
  onDone,
  positionId,
  name,
}: FlowProps & { positionId: Id; name: string }) {
  const workspace = useWorkspace();
  const act = useFormAct();
  const { options, account, setAccount, need } = useAccount();
  const [when, setWhen] = useState(dateText(workspace.today()));
  const [value, setValue] = useState("");
  const [tax, setTax] = useState("");

  const confirm = () => {
    const on = readDate(when);
    const gross = readMoney(value);
    const withheld = readMoney(tax, { allowEmpty: true });
    const to = need();
    act((l) => service.distribute(l, positionId, gross, on, to, withheld ?? "0"), "registrar rendimento");
    onDone?.();
  };

  return (
    <FormDialog
      open={open}
      onClose={onClose}
      title={`Provento pago fora do investimento — ${name}`}
      confirmLabel="Registrar"
      size="sm"
      onConfirm={confirm}
    >
      <FormGrid columns={1}>
        <DateField label="Data" value={when} onChange={setWhen} />
        <MoneyField label="Valor bruto" value={value} onChange={setValue} data-autofocus="" />
        <MoneyField label="Imposto retido" value={tax} onChange={setTax} />
        <Select
          label="Creditado na conta"
          options={options}
          value={account}
          onChange={setAccount}
          placeholder="Nenhuma conta"
        />
        <Caption>Provento é rendimento: não muda o custo nem o valor do investimento.</Caption>
      </FormGrid>
    </FormDialog>
  );
}

export function InvestmentTaxPaymentDialog({ open, onClose, onDone }: FlowProps) {
  const workspace = useWorkspace();
  const act = useFormAct();
  const { options, account, setAccount, need } = useAccount();
  const [when, setWhen] = useState(dateText(workspace.today()));
  const [value, setValue] = useState("");

  const confirm = () => {
    const on = readDate(when, "A data do pagamento");
    const amount = readMoney(value);
    const from = need();
    act((l) => service.payTax(l, amount, on, from), "pagar imposto");
    onDone?.();
  };

  return (
    <FormDialog
      open={open}
      onClose={onClose}
      title="Pagamento de imposto devido"
      confirmLabel="Registrar"
      size="sm"
      onConfirm={confirm}
    >
      <FormGrid columns={1}>
        <DateField label="Data do pagamento" value={when} onChange={setWhen} />
        <MoneyField label="Valor" value={value} onChange={setValue} data-autofocus="" />
        <Select
          label="Pago pela conta"
          options={options}
          value={account}
          onChange={setAccount}
          placeholder="Nenhuma conta"
        />
        <Caption>Quita o imposto que resgates anteriores deixaram a pagar.</Caption>
      </FormGrid>
    </FormDialog>
  );
}
