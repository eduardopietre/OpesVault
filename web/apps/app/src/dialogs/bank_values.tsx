/**
 * Valores em uma data (desktop `ValuesDialog`): what the bank shows for each part of a bank account on a date.
 * Each balance becomes a check against the app; with "Ajustar o saldo" the difference is posted as an
 * adjustment on that date. Investments receive a valuation. What is left empty is not recorded.
 */
import { DomainError, OperationKind, dom, formatBrl, type Dec, type Id, type Ledger } from "@opesvault/domain";
import { Checkbox, DateField, MoneyField, TextField } from "@opesvault/ui";
import { useMemo, useState } from "react";
import { useWorkspace } from "../data/react.tsx";
import { Caption, FormDialog, dateText, readDate, readMoney, useFormAct } from "./livro_form.tsx";

const { banking } = dom;

export interface ValuesDialogProps {
  open: boolean;
  onClose: () => void;
  bankId: Id;
  onDone?: (recorded: dom.banking.Recorded) => void;
}

/** The account has only opening balances and adjustments: its balance comes from informed values. */
export function trackedByValues(ledger: Ledger, accountId: Id): boolean {
  for (const op of ledger.activeOperations()) {
    if (op.postings.some((p) => p.account_id === accountId) && op.kind !== OperationKind.OPENING_BALANCE) return false;
  }
  return true;
}

export function ValuesDialog({ open, onClose, bankId, onDone }: ValuesDialogProps) {
  const workspace = useWorkspace();
  const ledger = workspace.ledger;
  const act = useFormAct();
  const item = banking.bankAccounts(ledger).get(bankId);
  const rows = useMemo(() => banking.valuesAt(ledger, bankId, workspace.today()), [ledger, bankId, workspace]);
  const [when, setWhen] = useState(dateText(workspace.today()));
  const [informed, setInformed] = useState<Record<string, string>>({});
  const [adjust, setAdjust] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(rows.filter((v) => v.kind !== "investment").map((v) => [v.ref, trackedByValues(ledger, v.ref)])),
  );
  const [note, setNote] = useState("");

  const onDate = useMemo(() => {
    try {
      return readDate(when);
    } catch {
      return null;
    }
  }, [when]);
  /** What the app has at the chosen date, per item. */
  const app = useMemo(
    () => new Map(banking.valuesAt(ledger, bankId, onDate ?? workspace.today()).map((v) => [v.ref, v.value])),
    [ledger, bankId, onDate, workspace],
  );

  const confirm = () => {
    const day = readDate(when, "A data dos valores");
    const values = new Map<Id, Dec>();
    const adjusted = new Set<Id>();
    for (const value of rows) {
      const raw = (informed[value.ref] ?? "").trim();
      if (!raw) continue;
      try {
        values.set(value.ref, readMoney(raw));
      } catch {
        throw new DomainError(`${value.label}: valor inválido, use o formato 1.234,56.`);
      }
      if (value.kind !== "investment" && adjust[value.ref]) adjusted.add(value.ref);
    }
    if (values.size === 0) throw new DomainError("Informe ao menos um valor.");
    const recorded = act((l) =>
      banking.recordValues(l, bankId, day, values, workspace.today(), { adjust: adjusted, note }),
    );
    onDone?.(recorded);
  };

  return (
    <FormDialog
      open={open}
      onClose={onClose}
      title={`Valores em uma data — ${item?.name ?? ""}`}
      confirmLabel="Registrar valores"
      size="lg"
      onConfirm={confirm}
    >
      <div className="flex flex-col gap-4">
        <div className="max-w-56">
          <DateField label="Data dos valores" value={when} onChange={setWhen} data-autofocus="" />
        </div>
        <ul aria-label="Valores por item" className="flex flex-col gap-2">
          {rows.map((value) => (
            <li
              key={value.ref}
              className="grid min-w-0 items-end gap-x-4 gap-y-2 rounded-lg border border-separator px-3 py-2.5 tablet:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1.2fr)]"
            >
              <div className="min-w-0">
                <div className="truncate text-body font-medium">{value.label}</div>
                {value.kind === "investment" ? <div className="text-caption text-secondary">Investimento</div> : null}
              </div>
              <div className="min-w-0">
                <div className="text-caption text-secondary">No aplicativo</div>
                <div className="text-body tabular-nums">
                  {app.get(value.ref) ? formatBrl(app.get(value.ref)!) : "—"}
                </div>
              </div>
              <div className="min-w-0">
                <div aria-hidden="true" className="text-caption text-secondary">
                  Valor no banco
                </div>
                <MoneyField
                  hideLabel
                  label={`Valor no banco: ${value.label}`}
                  value={informed[value.ref] ?? ""}
                  onChange={(text) => setInformed((current) => ({ ...current, [value.ref]: text }))}
                />
              </div>
              {value.kind === "investment" ? (
                <p className="pb-2 text-caption text-secondary">Vira avaliação do investimento.</p>
              ) : (
                <div className="pb-1.5">
                  <Checkbox
                    label={
                      <span className="text-caption">
                        <span className="sr-only">{value.label}: </span>Ajustar o saldo
                      </span>
                    }
                    checked={adjust[value.ref] ?? false}
                    onCheckedChange={(checked) => setAdjust((current) => ({ ...current, [value.ref]: checked }))}
                  />
                </div>
              )}
            </li>
          ))}
        </ul>
        <TextField
          label="Origem dos valores"
          value={note}
          onChange={setNote}
          maxLength={500}
          placeholder="ex.: extrato do aplicativo, informe de rendimentos"
          autoComplete="off"
        />
        <Caption>
          Deixe em branco o que não quiser informar. Cada saldo vira uma conferência com o banco; com “Ajustar o saldo”,
          a diferença é lançada como ajuste nessa data e o saldo do aplicativo passa a ser o do banco (patrimônio,
          relatórios e imposto de renda acompanham). Contas com lançamentos ficam sem ajuste por padrão: a diferença
          indica lançamento faltando. Investimentos recebem uma avaliação nessa data.
        </Caption>
      </div>
    </FormDialog>
  );
}
