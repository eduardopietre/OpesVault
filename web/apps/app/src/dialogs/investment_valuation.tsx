/**
 * Nova avaliação (desktop `EventCommands.new_valuation`, docs/07 §3) and Corrigir observação. A valuation is
 * an observed value on a date, never a flow: a new date adds a point; another source on a date that already
 * has one is kept apart (the first is used until the person picks another); the same source on the same date
 * is refused and the person is pointed to "corrigir observação". The default reading of a date that also has
 * movements is the closing of the day, after them.
 */
import { DomainError, formatBrl, formatDateBr, investments, type Id, type IsoDate } from "@opesvault/domain";
import { Button, DateField, MoneyField, Select, TextField, parseBrDate, type SelectOption } from "@opesvault/ui";
import { useState } from "react";
import { useWorkspace } from "../data/react.tsx";
import { readQuantity } from "./investment_forms.ts";
import {
  Caption,
  FormDialog,
  FormGrid,
  FullRow,
  dateText,
  editableMoney,
  readDate,
  readMoney,
  useFormAct,
} from "./livro_form.tsx";

const { model, service } = investments;

const NATURES: SelectOption[] = Object.entries(model.NATURE_LABELS).map(([id, label]) => ({ id, label }));

export interface InvestmentValuationDialogProps {
  open: boolean;
  onClose: () => void;
  positionId: Id;
  /** Name of the investment, for the title. */
  name: string;
  /** The date to start from (the form's default is today). */
  on?: IsoDate | null;
  /** The person chose to correct the observation that already exists instead of adding one. */
  onFix?: (valuationId: Id) => void;
  onDone?: () => void;
}

export function InvestmentValuationDialog({
  open,
  onClose,
  positionId,
  name,
  on = null,
  onFix,
  onDone,
}: InvestmentValuationDialogProps) {
  const workspace = useWorkspace();
  const ledger = workspace.ledger;
  const act = useFormAct();
  const byQuantity = service.position(ledger, positionId).mode === model.TrackingMode.QUANTITY;
  const [when, setWhen] = useState(dateText(on ?? workspace.today()));
  const [value, setValue] = useState("");
  const [nature, setNature] = useState<string>(model.ValueNature.GROSS);
  const [source, setSource] = useState("manual");
  const [note, setNote] = useState("");
  const [quantity, setQuantity] = useState("");
  const [price, setPrice] = useState("");

  const iso = parseBrDate(when) as IsoDate | null;
  const sameDay = iso ? service.valuationsOf(ledger, positionId).filter((v) => v.on === iso) : [];
  const sameSource = sameDay.find((v) => v.source === (source.trim() || "manual")) ?? null;
  const flows = iso ? service.eventsOf(ledger, positionId).filter((e) => e.on === iso) : [];

  const confirm = () => {
    const on_ = readDate(when, "A data");
    const amount = readMoney(value);
    const typed = quantity.trim() ? readQuantity(quantity) : null;
    const unit = byQuantity ? readMoney(price, { allowEmpty: true }) : null;
    act((l) =>
      service.addValuation(l, positionId, on_, amount, nature as investments.model.ValueNature, {
        source: source.trim() || "manual",
        quantity: byQuantity ? typed : null,
        unit_price: unit,
        note: note.trim() || null,
      }),
    );
    onDone?.();
  };

  return (
    <FormDialog
      open={open}
      onClose={onClose}
      title={`Nova avaliação — ${name}`}
      confirmLabel="Registrar"
      size="md"
      onConfirm={confirm}
      extraActions={
        sameSource && onFix ? (
          <Button
            onClick={() => {
              onClose();
              onFix(sameSource.id);
            }}
          >
            Corrigir a observação existente…
          </Button>
        ) : null
      }
    >
      <FormGrid>
        <DateField label="Data" value={when} onChange={setWhen} data-autofocus="" />
        <MoneyField label="Valor" value={value} onChange={setValue} />
        <Select label="Natureza" options={NATURES} value={nature} onChange={setNature} />
        <TextField label="Fonte" value={source} onChange={setSource} maxLength={120} autoComplete="off" />
        {byQuantity ? (
          <>
            <TextField
              label="Quantidade"
              value={quantity}
              onChange={setQuantity}
              inputMode="decimal"
              autoComplete="off"
            />
            <MoneyField label="Preço unitário" value={price} onChange={setPrice} />
          </>
        ) : null}
        <FullRow>
          <TextField label="Observação" value={note} onChange={setNote} maxLength={500} autoComplete="off" />
        </FullRow>
        {sameDay.length > 0 ? (
          <FullRow>
            <Caption>
              {sameSource
                ? `Já existe avaliação desta fonte em ${formatDateBr(iso!)} (${formatBrl(sameSource.value)}). Use "Corrigir a observação existente" para mudar o valor, ou informe outra fonte para registrar outra observação, preservando o histórico.`
                : `Já existe avaliação em ${formatDateBr(iso!)} (${sameDay.map((v) => `${v.source}: ${formatBrl(v.value)}`).join("; ")}). Esta será registrada como outra fonte; a primeira continua sendo a usada até você escolher.`}
            </Caption>
          </FullRow>
        ) : null}
        {flows.length > 0 ? (
          <FullRow>
            <Caption>
              Há movimentos neste dia ({flows.length === 1 ? "1 evento" : `${flows.length} eventos`}). A avaliação vale
              como o fechamento do dia, depois dos movimentos registrados.
            </Caption>
          </FullRow>
        ) : null}
      </FormGrid>
    </FormDialog>
  );
}

export interface InvestmentFixDialogProps {
  open: boolean;
  onClose: () => void;
  valuationId: Id;
  onDone?: () => void;
}

/** Corrigir observação: a new value with the reason; the history keeps the old one. */
export function InvestmentFixDialog({ open, onClose, valuationId, onDone }: InvestmentFixDialogProps) {
  const ledger = useWorkspace().ledger;
  const act = useFormAct();
  const current = service.valuations(ledger).get(valuationId);
  const [value, setValue] = useState(current ? editableMoney(current.value) : "");
  const [reason, setReason] = useState("");

  const confirm = () => {
    const amount = readMoney(value);
    if (!reason.trim()) throw new DomainError("Correções exigem motivo.");
    act((l) => service.correctValuation(l, valuationId, amount, reason.trim()));
    onDone?.();
  };

  return (
    <FormDialog
      open={open}
      onClose={onClose}
      title="Corrigir observação"
      confirmLabel="Corrigir"
      size="sm"
      onConfirm={confirm}
    >
      <div className="flex flex-col gap-3">
        {current ? (
          <Caption>
            Avaliação de {formatDateBr(current.on)} ({current.source}): {formatBrl(current.value)}. O histórico guarda o
            valor anterior e o motivo.
          </Caption>
        ) : null}
        <MoneyField label="Valor corrigido" value={value} onChange={setValue} data-autofocus="" />
        <TextField label="Motivo" value={reason} onChange={setReason} maxLength={200} autoComplete="off" required />
      </div>
    </FormDialog>
  );
}
