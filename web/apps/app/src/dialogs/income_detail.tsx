/**
 * Detalhar rendimento (desktop `ui/tax_dialogs/income.py` `IncomeDetailDialog`): gross, withheld income tax
 * and INSS of a deposit, as printed on the payslip, for the annual return. A field left empty stays unknown,
 * never zero; the deposit in the book does not change.
 */
import { DomainError, cashDate, formatBrl, tax, type Id } from "@opesvault/domain";
import { MoneyField, Select } from "@opesvault/ui";
import { useState } from "react";
import { useWorkspace } from "../data/react.tsx";
import { Caption, FormDialog, FormGrid, FullRow, useFormAct } from "./livro_form.tsx";
import { dateOr } from "../data/money.ts";
import { editableMoney, readMoney } from "./form_readers.ts";

const KINDS = Object.entries(tax.model.INCOME_KIND_LABELS).map(([id, label]) => ({ id, label }));

export interface IncomeDetailDialogProps {
  open: boolean;
  onClose: () => void;
  operationId: Id;
  onDone?: () => void;
}

export function IncomeDetailDialog({ open, onClose, operationId, onDone }: IncomeDetailDialogProps) {
  const ledger = useWorkspace().ledger;
  const act = useFormAct();
  const op = ledger.operations.get(operationId);
  if (op === undefined) throw new DomainError("Operação inexistente.");
  const detail = tax.records.detailOf(ledger, operationId);
  const received = tax.records.receivedAmount(ledger, operationId);
  const when = cashDate(op);
  const [kind, setKind] = useState<string>(detail?.kind ?? tax.model.IncomeKind.SALARY);
  const [gross, setGross] = useState(detail?.gross ? editableMoney(detail.gross) : "");
  const [withheld, setWithheld] = useState(detail?.withheld ? editableMoney(detail.withheld) : "");
  const [social, setSocial] = useState(detail?.social_security ? editableMoney(detail.social_security) : "");

  const confirm = () => {
    const values = [gross, withheld, social].map((text) => readMoney(text, { allowEmpty: true }));
    act((l) =>
      tax.records.setIncomeDetail(
        l,
        operationId,
        kind as tax.model.IncomeKind,
        values[0] ?? null,
        values[1] ?? null,
        values[2] ?? null,
      ),
    );
    onDone?.();
  };

  return (
    <FormDialog open={open} onClose={onClose} title="Detalhar rendimento" confirmLabel="Salvar" onConfirm={confirm}>
      <FormGrid>
        <FullRow>
          <Caption>
            {op.description} · {dateOr(when)} · recebido {formatBrl(received)}. Copie do contracheque; o depósito no
            livro não muda.
          </Caption>
        </FullRow>
        <FullRow>
          <Select label="Tipo de rendimento" options={KINDS} value={kind} onChange={setKind} />
        </FullRow>
        <MoneyField label="Bruto" value={gross} onChange={setGross} placeholder="não informado" />
        <MoneyField label="IR retido" value={withheld} onChange={setWithheld} placeholder="não informado" />
        <MoneyField label="INSS" value={social} onChange={setSocial} placeholder="não informado" />
      </FormGrid>
    </FormDialog>
  );
}
