/**
 * Novo investimento (desktop `InvestmentsPage.new_position`): name, class, how it is tracked (by observed value
 * or by quantity and price), holder, the starting date and the capital (or a reference value when the cost is
 * unknown). Characteristics (type, issuer, rate, maturity) come after, from "Características…".
 */
import { DomainError, investments, type Id } from "@opesvault/domain";
import { DateField, MoneyField, Select, TextField, type SelectOption } from "@opesvault/ui";
import { useState } from "react";
import { useWorkspace } from "../data/react.tsx";
import { cashAccounts } from "./investment_forms.ts";
import {
  Caption,
  FormDialog,
  FormGrid,
  FullRow,
  NONE,
  dateText,
  memberFromChoice,
  memberOptions,
  readDate,
  readMoney,
  useFormAct,
} from "./livro_form.tsx";

const { model, service } = investments;

export interface InvestmentPositionDialogProps {
  open: boolean;
  onClose: () => void;
  onDone?: (positionId: Id) => void;
}

const CLASSES: SelectOption[] = Object.entries(model.ASSET_CLASS_LABELS).map(([id, label]) => ({ id, label }));
const MODES: SelectOption[] = [
  { id: model.TrackingMode.VALUE, label: "Por valor observado" },
  { id: model.TrackingMode.QUANTITY, label: "Por quantidade e preço" },
];

export function InvestmentPositionDialog({ open, onClose, onDone }: InvestmentPositionDialogProps) {
  const workspace = useWorkspace();
  const ledger = workspace.ledger;
  const act = useFormAct();
  const [name, setName] = useState("");
  const [assetClass, setAssetClass] = useState<string>(model.AssetClass.FIXED_INCOME);
  const [mode, setMode] = useState<string>(model.TrackingMode.VALUE);
  const [ticker, setTicker] = useState("");
  const [holder, setHolder] = useState<string>(NONE);
  const [when, setWhen] = useState(dateText(workspace.today()));
  const [cost, setCost] = useState("");
  const [from, setFrom] = useState<string>(NONE);
  const [reference, setReference] = useState("");
  const byQuantity = mode === model.TrackingMode.QUANTITY;
  const sources: SelectOption[] = [{ id: NONE, label: "(investimento já existente)" }, ...cashAccounts(ledger)];

  const confirm = () => {
    const title = name.trim();
    if (!title) throw new DomainError("Informe o nome.");
    const opened = readDate(when, "A data inicial");
    const capital = byQuantity ? null : readMoney(cost, { allowEmpty: true });
    const known = byQuantity ? null : readMoney(reference, { allowEmpty: true });
    // A position tracked by quantity starts empty: trades or an opening lot give it cost (docs/06 §4).
    if (!byQuantity && capital === null && known === null) {
      throw new DomainError("Informe o custo inicial ou um valor de referência.");
    }
    const position = act((l) =>
      service.createPosition(l, title, assetClass as investments.model.AssetClass, opened, {
        holder_id: memberFromChoice(holder),
        mode: mode as investments.model.TrackingMode,
        ticker: ticker.trim() || null,
        initial_cost: capital,
        from_account: from === NONE ? null : from,
        reference_value: known,
      }),
    );
    onDone?.(position.id);
  };

  return (
    <FormDialog
      open={open}
      onClose={onClose}
      title="Novo investimento"
      confirmLabel="Criar"
      size="lg"
      onConfirm={confirm}
    >
      <FormGrid>
        <FullRow>
          <TextField
            label="Nome"
            value={name}
            onChange={setName}
            maxLength={200}
            placeholder="ex.: CDB Banco X 2028, Tesouro IPCA+ 2035, PETR4"
            autoComplete="off"
            data-autofocus=""
            required
          />
        </FullRow>
        <Select label="Classe" options={CLASSES} value={assetClass} onChange={setAssetClass} />
        <Select label="Acompanhamento" options={MODES} value={mode} onChange={setMode} />
        <TextField label="Código (opcional)" value={ticker} onChange={setTicker} maxLength={20} autoComplete="off" />
        <Select label="Titular" options={memberOptions(ledger)} value={holder} onChange={setHolder} />
        <DateField label="Data inicial" value={when} onChange={setWhen} />
        {byQuantity ? null : (
          <>
            <MoneyField
              label="Capital/custo inicial"
              value={cost}
              onChange={setCost}
              placeholder="vazio se desconhecido"
            />
            <Select label="Dinheiro saiu de" options={sources} value={from} onChange={setFrom} />
            <MoneyField
              label="Valor de referência"
              value={reference}
              onChange={setReference}
              placeholder="se o custo é desconhecido"
            />
          </>
        )}
        <FullRow>
          <Caption>
            {byQuantity
              ? "Um ativo acompanhado por quantidade começa vazio: registre compras ou uma posição inicial em Negociação."
              : "Com o custo conhecido, o ganho é calculado; sem ele, informe só o valor de referência e o ganho desde a aquisição fica indisponível. Descreva tipo, taxa e vencimento em Mais › Características."}
          </Caption>
        </FullRow>
      </FormGrid>
    </FormDialog>
  );
}
