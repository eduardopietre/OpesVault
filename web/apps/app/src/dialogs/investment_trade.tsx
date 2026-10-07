/**
 * Negociação of a position tracked by quantity (desktop `TradeCommands`, docs/06 §4): buy, sell, opening
 * position, split or reverse split, and bonus shares. Quantities are typed the Brazilian way and never pass
 * through a float; the cost method of a sale defaults to the asset class's (average cost for stocks and funds,
 * lot by lot for the rest).
 */
import { DomainError, investments, type Id } from "@opesvault/domain";
import { DateField, MoneyField, Select, TextField, type SelectOption } from "@opesvault/ui";
import { useState } from "react";
import { useWorkspace } from "../data/react.tsx";
import { cashAccounts } from "./investment_forms.ts";
import { Caption, FormDialog, FormGrid, NONE, useFormAct } from "./livro_form.tsx";
import { dateText, readDate, readMoney, readQuantity } from "./form_readers.ts";

const { trades } = investments;

export type TradeKind = "buy" | "sell" | "opening" | "split" | "bonus";

export const TRADE_TITLES: Readonly<Record<TradeKind, string>> = {
  buy: "Compra",
  sell: "Venda",
  opening: "Posição inicial",
  split: "Desdobramento/grupamento",
  bonus: "Bonificação",
};

export interface InvestmentTradeDialogProps {
  open: boolean;
  onClose: () => void;
  kind: TradeKind;
  positionId: Id;
  name: string;
  onDone?: () => void;
}

const METHODS: SelectOption[] = [
  { id: NONE, label: "Padrão da classe" },
  { id: trades.CostMethod.AVERAGE, label: "Custo médio" },
  { id: trades.CostMethod.FIFO, label: "Por lote (mais antigo)" },
];

export function InvestmentTradeDialog({ open, onClose, kind, positionId, name, onDone }: InvestmentTradeDialogProps) {
  const workspace = useWorkspace();
  const ledger = workspace.ledger;
  const act = useFormAct();
  const cash = cashAccounts(ledger);
  const [when, setWhen] = useState(dateText(workspace.today()));
  const [quantity, setQuantity] = useState("");
  const [price, setPrice] = useState("");
  const [fees, setFees] = useState("");
  const [tax, setTax] = useState("");
  const [method, setMethod] = useState<string>(NONE);
  const [account, setAccount] = useState<string | null>(cash[0]?.id ?? null);
  const [cost, setCost] = useState("");
  const [factor, setFactor] = useState("");

  const needAccount = (): string => {
    if (account === null) throw new DomainError("Não há conta de dinheiro para movimentar. Cadastre uma em Contas.");
    return account;
  };

  const confirm = () => {
    const on = readDate(when);
    switch (kind) {
      case "buy": {
        const qty = readQuantity(quantity);
        const unit = readMoney(price);
        const extra = readMoney(fees, { allowEmpty: true });
        const from = needAccount();
        act((l) => trades.buy(l, positionId, on, qty, unit, from, { fees: extra ?? "0" }), "registrar compra");
        break;
      }
      case "sell": {
        const qty = readQuantity(quantity);
        const unit = readMoney(price);
        const extra = readMoney(fees, { allowEmpty: true });
        const withheld = readMoney(tax, { allowEmpty: true });
        const to = needAccount();
        act((l) =>
          trades.sell(l, positionId, on, qty, unit, to, {
            fees: extra ?? "0",
            tax_withheld: withheld ?? "0",
            method: method === NONE ? null : (method as investments.trades.CostMethod),
          }),
        );
        break;
      }
      case "opening": {
        const qty = readQuantity(quantity);
        const total = readMoney(cost);
        act((l) => trades.openingLot(l, positionId, on, qty, total), "registrar posição inicial");
        break;
      }
      case "split": {
        const ratio = readQuantity(factor, "Fator");
        act((l) => trades.split(l, positionId, on, ratio), "registrar desdobramento");
        break;
      }
      case "bonus": {
        const qty = readQuantity(quantity);
        const informed = readMoney(cost, { allowEmpty: true });
        act((l) => trades.bonus(l, positionId, on, qty, informed ?? "0"), "registrar bonificação");
        break;
      }
    }
    onDone?.();
  };

  const account_ = (label: string) => (
    <Select label={label} options={cash} value={account} onChange={setAccount} placeholder="Nenhuma conta" />
  );

  return (
    <FormDialog
      open={open}
      onClose={onClose}
      title={`${TRADE_TITLES[kind]} — ${name}`}
      confirmLabel="Registrar"
      size="sm"
      onConfirm={confirm}
    >
      <FormGrid columns={1}>
        <DateField label="Data" value={when} onChange={setWhen} />
        {kind === "split" ? (
          <>
            <TextField
              label="Fator (2 = cada ação vira 2)"
              value={factor}
              onChange={setFactor}
              inputMode="decimal"
              autoComplete="off"
              data-autofocus=""
            />
            <Caption>Menor que 1 é grupamento (0,1 = cada 10 viram 1). A quantidade muda; o custo, não.</Caption>
          </>
        ) : (
          <TextField
            label={kind === "bonus" ? "Quantidade recebida" : "Quantidade"}
            value={quantity}
            onChange={setQuantity}
            inputMode="decimal"
            autoComplete="off"
            data-autofocus=""
          />
        )}
        {kind === "buy" || kind === "sell" ? (
          <>
            <MoneyField label="Preço unitário" value={price} onChange={setPrice} maxDecimals={8} />
            <MoneyField label="Custos" value={fees} onChange={setFees} />
          </>
        ) : null}
        {kind === "sell" ? (
          <>
            <MoneyField label="Imposto retido" value={tax} onChange={setTax} />
            <Select label="Custo" options={METHODS} value={method} onChange={setMethod} />
          </>
        ) : null}
        {kind === "buy" ? account_("Pago pela conta") : null}
        {kind === "sell" ? account_("Creditado na conta") : null}
        {kind === "opening" ? (
          <>
            <MoneyField label="Custo total conhecido" value={cost} onChange={setCost} />
            <Caption>Para o que já existia quando o projeto começou: quantidade e custo conhecidos.</Caption>
          </>
        ) : null}
        {kind === "bonus" ? (
          <MoneyField label="Custo informado pela empresa" value={cost} onChange={setCost} placeholder="0,00" />
        ) : null}
      </FormGrid>
    </FormDialog>
  );
}
