/**
 * Reembolso a receber (desktop `ReimbursementDialog`): marks an expense as something a health plan, an
 * employer or someone else will pay back. The expected amount starts at the expense's total. Opened from the
 * Livro it comes with its expense; opened from Reembolsos (no `operation`), the person picks the expense first.
 */
import {
  AccountType,
  DomainError,
  Dec,
  ZERO,
  cashDate,
  dom,
  formatBrl,
  type Id,
  type Ledger,
  type Operation,
} from "@opesvault/domain";
import { Combobox, DateField, MoneyField, TextField, type SelectOption } from "@opesvault/ui";
import { useMemo, useState } from "react";
import { useWorkspace } from "../data/react.tsx";
import { Caption, FormDialog, FormGrid, FullRow, useFormAct } from "./livro_form.tsx";
import { dateOr } from "../data/money.ts";
import { dateText, editableMoney, readDate, readMoney } from "./form_readers.ts";

/** How many expenses the picker offers, the most recent first (a long list would not help anyone choose). */
export const PICK_LIMIT = 200;

/** What the expense costs in its expense categories: the most a reimbursement can expect. */
function expenseTotal(ledger: Ledger, op: Operation): Dec {
  return Dec.sum(
    op.postings
      .filter((p) => ledger.account(p.account_id).type === AccountType.EXPENSE && p.amount.isPositive())
      .map((p) => p.amount),
    ZERO,
  );
}

/** The expenses that can still get a reimbursement: active, with an expense part, without one already. */
export function reimbursableExpenses(ledger: Ledger): Operation[] {
  const taken = new Set(
    [...dom.sharing.reimbursements(ledger).values()].filter((r) => !r.denied).map((r) => r.operation_id),
  );
  const found: Operation[] = [];
  for (const op of ledger.activeOperations()) {
    if (taken.has(op.id) || !expenseTotal(ledger, op).isPositive()) continue;
    found.push(op);
  }
  const when = (op: Operation) => op.occurred_on ?? cashDate(op) ?? "";
  return found.sort((a, b) => when(b).localeCompare(when(a)) || a.description.localeCompare(b.description));
}

export interface ReimbursementDialogProps {
  open: boolean;
  onClose: () => void;
  /** The expense; without it the dialog asks which one. */
  operation?: Operation | null;
  onDone?: () => void;
}

export function ReimbursementDialog({ open, onClose, operation = null, onDone }: ReimbursementDialogProps) {
  const workspace = useWorkspace();
  const ledger = workspace.ledger;
  const act = useFormAct();
  const candidates = useMemo(() => (operation ? [] : reimbursableExpenses(ledger)), [ledger, operation]);
  const options = useMemo<SelectOption[]>(
    () =>
      candidates.slice(0, PICK_LIMIT).map((op) => ({
        id: op.id,
        label: op.description,
        description: `${dateOr(op.occurred_on ?? cashDate(op))} · ${formatBrl(expenseTotal(ledger, op))}`,
      })),
    [candidates, ledger],
  );
  const [chosen, setChosen] = useState<Id | null>(null);
  const op = operation ?? (chosen ? (ledger.operations.get(chosen) ?? null) : null);
  const total = op ? expenseTotal(ledger, op) : ZERO;
  const [payer, setPayer] = useState("");
  const [expected, setExpected] = useState(total.isPositive() ? editableMoney(total) : "");
  const [requested, setRequested] = useState(dateText(workspace.today()));
  const when = op ? (op.occurred_on ?? cashDate(op)) : null;

  const choose = (id: string) => {
    setChosen(id);
    const picked = ledger.operations.get(id);
    const value = picked ? expenseTotal(ledger, picked) : ZERO;
    setExpected(value.isPositive() ? editableMoney(value) : "");
  };

  const confirm = () => {
    if (!op) throw new DomainError("Escolha o lançamento a reembolsar.");
    if (!payer.trim()) throw new DomainError("Informe quem reembolsa.");
    const value = readMoney(expected);
    if (!value.isPositive()) throw new DomainError("Informe um valor positivo.");
    const on = readDate(requested, "A data do pedido");
    act((l) => dom.sharing.request(l, op.id, payer, value, on), "pedir reembolso");
    onDone?.();
  };

  return (
    <FormDialog open={open} onClose={onClose} title="Reembolso a receber" confirmLabel="Registrar" onConfirm={confirm}>
      <FormGrid>
        {operation ? null : (
          <FullRow>
            <Combobox
              label="Lançamento a reembolsar"
              options={options}
              value={chosen}
              onChange={choose}
              placeholder="Digite parte da descrição"
              emptyText="Nenhuma despesa sem reembolso."
              hint={
                candidates.length > PICK_LIMIT
                  ? `As ${PICK_LIMIT} despesas mais recentes. Para uma mais antiga, use o Livro financeiro: Ações › Reembolso a receber.`
                  : "Despesas que ainda não têm reembolso, das mais recentes às mais antigas."
              }
            />
          </FullRow>
        )}
        {op ? (
          <FullRow>
            <Caption>
              {op.description} · {dateOr(when)} · {formatBrl(total)}
            </Caption>
          </FullRow>
        ) : null}
        <FullRow>
          <TextField
            label="Quem reembolsa"
            value={payer}
            onChange={setPayer}
            placeholder="ex.: Plano de saúde, Empresa"
            autoComplete="off"
          />
        </FullRow>
        <MoneyField label="Valor esperado" value={expected} onChange={setExpected} />
        <DateField label="Pedido em" value={requested} onChange={setRequested} />
      </FormGrid>
    </FormDialog>
  );
}
