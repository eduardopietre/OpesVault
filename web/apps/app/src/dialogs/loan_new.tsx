/**
 * Novo financiamento (desktop `LoanDialog`): a loan as the contract says it: balance, rate, term, system and
 * the first due date. The schedule is computed; how the debt enters the book is chosen here.
 */
import {
  AccountSubtype,
  AccountType,
  Dec,
  DomainError,
  LedgerAccountSchema,
  dom,
  type LedgerAccount,
} from "@opesvault/domain";
import { DateField, MoneyField, Select, TextField, type SelectOption } from "@opesvault/ui";
import { useState } from "react";
import { useWorkspace } from "../data/react.tsx";
import { assetAccounts, categoryItems } from "./account_choices.ts";
import { Caption, FormDialog, FormGrid, FullRow, useFormAct } from "./livro_form.tsx";
import { typedPercent, dateText, readDate, readMoney } from "./form_readers.ts";

const { loans } = dom;

export interface LoanDialogProps {
  open: boolean;
  onClose: () => void;
  onDone?: (plan: dom.loans.LoanPlan) => void;
}

const RATE_BASES: SelectOption[] = [
  { id: "month", label: "% ao mês" },
  { id: "year", label: "% ao ano (efetiva)" },
];

const OPENINGS: SelectOption[] = [
  { id: loans.Opening.OPENING_BALANCE, label: "Dívida existente: registrar o saldo devedor como saldo de abertura" },
  { id: loans.Opening.DEPOSIT, label: "Dinheiro recebido agora numa conta" },
  { id: loans.Opening.NONE, label: "A dívida já está registrada no livro" },
];

const SYSTEMS: SelectOption[] = Object.entries(loans.SYSTEM_LABELS).map(([id, label]) => ({ id, label }));

/** The monthly rate (a fraction) from what was typed as a percentage, per month or per year. */
function monthlyRate(text: string, basis: string): Dec {
  const percent = typedPercent(text, "Taxa inválida. Use o formato 0,99.") ?? Dec.from(0);
  if (percent.isNegative() || percent.gte(100)) throw new DomainError("Informe a taxa em %, entre 0 e 100.");
  const fraction = percent.div(100);
  return basis === "year" ? loans.annualToMonthly(fraction) : fraction;
}

export function LoanDialog({ open, onClose, onDone }: LoanDialogProps) {
  const workspace = useWorkspace();
  const ledger = workspace.ledger;
  const act = useFormAct();
  const accounts = assetAccounts(ledger);
  const expenses = categoryItems(ledger, AccountType.EXPENSE);
  const usual = ledger.categories(AccountType.EXPENSE).find((a) => a.name === "Juros e encargos")?.id ?? null;
  const [name, setName] = useState("");
  const [principal, setPrincipal] = useState("");
  const [rate, setRate] = useState("");
  const [basis, setBasis] = useState("month");
  const [term, setTerm] = useState("60");
  const [system, setSystem] = useState<string>(loans.AmortizationSystem.PRICE);
  const [firstDue, setFirstDue] = useState(dateText(workspace.today()));
  const [payment, setPayment] = useState<string | null>(accounts[0]?.id ?? null);
  const [interest, setInterest] = useState<string | null>(usual ?? expenses[0]?.id ?? null);
  const [fees, setFees] = useState("");
  const [feesCategory, setFeesCategory] = useState<string | null>(usual ?? expenses[0]?.id ?? null);
  const [opening, setOpening] = useState<string>(loans.Opening.OPENING_BALANCE);
  const [deposit, setDeposit] = useState<string | null>(accounts[0]?.id ?? null);
  const [openedOn, setOpenedOn] = useState(dateText(workspace.today()));

  const confirm = () => {
    const title = name.trim();
    if (!title) throw new DomainError("Informe o nome do financiamento.");
    const balance = readMoney(principal, { allowEmpty: true });
    if (balance === null || !balance.isPositive()) throw new DomainError("Informe o saldo devedor.");
    if (payment === null || interest === null) {
      throw new DomainError("Cadastre a conta de pagamento e a categoria de juros.");
    }
    const monthly = monthlyRate(rate, basis);
    const count = Number(term.trim());
    if (!Number.isInteger(count) || count < 1 || count > loans.MAX_TERM) {
      throw new DomainError(`Informe de 1 a ${loans.MAX_TERM} parcelas.`);
    }
    const perInstallment = readMoney(fees, { allowEmpty: true }) ?? Dec.from(0);
    const due = readDate(firstDue, "O vencimento da próxima parcela");
    const kind = opening as dom.loans.Opening;
    const on = kind === loans.Opening.NONE ? null : readDate(openedOn, "A data do saldo");
    const plan = act((l) => {
      const account: LedgerAccount = l.addAccount(
        LedgerAccountSchema.parse({ name: title, type: AccountType.LIABILITY, subtype: AccountSubtype.LOAN }),
      );
      return loans.createLoan(
        l,
        loans.LoanPlanSchema.parse({
          name: title,
          liability_account_id: account.id,
          payment_account_id: payment,
          interest_category_id: interest,
          fees_category_id: perInstallment.isPositive() ? feesCategory : null,
          principal: balance,
          monthly_rate: monthly,
          term: count,
          system: system as dom.loans.AmortizationSystem,
          first_due: due,
          fees_per_installment: perInstallment,
        }),
        kind,
        { on, depositAccountId: kind === loans.Opening.DEPOSIT ? deposit : null },
      );
    });
    onDone?.(plan);
  };

  return (
    <FormDialog
      open={open}
      onClose={onClose}
      title="Novo financiamento"
      confirmLabel="Criar financiamento"
      size="lg"
      onConfirm={confirm}
    >
      <FormGrid>
        <FullRow>
          <TextField
            label="Nome"
            value={name}
            onChange={setName}
            maxLength={120}
            placeholder="ex.: Financiamento do apartamento"
            autoComplete="off"
            data-autofocus=""
            required
          />
        </FullRow>
        <MoneyField label="Saldo devedor" value={principal} onChange={setPrincipal} />
        <TextField
          label="Parcelas restantes"
          value={term}
          onChange={setTerm}
          type="number"
          min={1}
          max={loans.MAX_TERM}
          inputMode="numeric"
        />
        <TextField
          label="Taxa de juros (%)"
          value={rate}
          onChange={setRate}
          inputMode="decimal"
          placeholder="ex.: 0,99"
          autoComplete="off"
        />
        <Select label="Período da taxa" options={RATE_BASES} value={basis} onChange={setBasis} />
        <Select label="Sistema de amortização" options={SYSTEMS} value={system} onChange={setSystem} />
        <DateField label="Vencimento da próxima parcela" value={firstDue} onChange={setFirstDue} />
        <Select
          label="Parcelas pagas pela conta"
          options={accounts}
          value={payment}
          onChange={setPayment}
          placeholder="Nenhuma conta"
        />
        <Select
          label="Categoria dos juros"
          options={expenses}
          value={interest}
          onChange={setInterest}
          placeholder="Nenhuma categoria"
        />
        <MoneyField label="Seguros e tarifas por parcela" value={fees} onChange={setFees} />
        <Select
          label="Categoria dos seguros e tarifas"
          options={expenses}
          value={feesCategory}
          onChange={setFeesCategory}
          placeholder="Nenhuma categoria"
        />
        <FullRow>
          <Select label="Como a dívida entra no livro" options={OPENINGS} value={opening} onChange={setOpening} />
        </FullRow>
        <Select
          label="Conta que recebeu o dinheiro"
          options={accounts}
          value={deposit}
          onChange={setDeposit}
          disabled={opening !== loans.Opening.DEPOSIT}
          placeholder="Nenhuma conta"
        />
        <DateField
          label="Data do saldo"
          value={openedOn}
          onChange={setOpenedOn}
          disabled={opening === loans.Opening.NONE}
        />
        <FullRow>
          <Caption>
            Informe o saldo devedor e as parcelas que ainda faltam, como no extrato do contrato. O cronograma é
            calculado; diferenças de centavos com o banco são normais.
          </Caption>
        </FullRow>
      </FormGrid>
    </FormDialog>
  );
}
