/**
 * Resgate, Resgate só com o líquido and Completar resgate (desktop `EventCommands.redemption`, `net_only`,
 * `complete`). Net credited now = gross − tax withheld − fees; tax due later stays a liability until paid. A
 * redemption known only by its net is incomplete: results that use it say so, until it is completed.
 */
import { DomainError, investments, formatBrl, formatDateBr, type Id } from "@opesvault/domain";
import { Checkbox, DateField, MoneyField, Select } from "@opesvault/ui";
import { useState } from "react";
import { useWorkspace } from "../data/react.tsx";
import { cashAccounts } from "./investment_forms.ts";
import { Caption, FormDialog, FormGrid, FullRow, dateText, readDate, readMoney, useFormAct } from "./livro_form.tsx";

const { service } = investments;

interface FlowProps {
  open: boolean;
  onClose: () => void;
  onDone?: () => void;
}

/** What the simulator hands over, so the redemption opens already filled (docs/07 §6). */
export interface RedemptionPrefill {
  on: string;
  gross: string;
  cost: string;
  fees: string;
}

function useCash() {
  const ledger = useWorkspace().ledger;
  const options = cashAccounts(ledger);
  const [account, setAccount] = useState<string | null>(options[0]?.id ?? null);
  const need = (): string => {
    if (account === null) throw new DomainError("Não há conta de dinheiro para movimentar. Cadastre uma em Contas.");
    return account;
  };
  return { options, account, setAccount, need };
}

export function InvestmentRedemptionDialog({
  open,
  onClose,
  onDone,
  positionId,
  name,
  prefill = null,
}: FlowProps & { positionId: Id; name: string; prefill?: RedemptionPrefill | null }) {
  const workspace = useWorkspace();
  const act = useFormAct();
  const { options, account, setAccount, need } = useCash();
  const [when, setWhen] = useState(prefill?.on ?? dateText(workspace.today()));
  const [gross, setGross] = useState(prefill?.gross ?? "");
  const [cost, setCost] = useState(prefill?.cost ?? "");
  const [withheld, setWithheld] = useState("");
  const [later, setLater] = useState("");
  const [fees, setFees] = useState(prefill?.fees ?? "");
  const [net, setNet] = useState("");
  const [final, setFinal] = useState(false);

  const confirm = () => {
    const on = readDate(when);
    const amount = readMoney(gross);
    const attributed = readMoney(cost, { allowEmpty: true });
    const tw = readMoney(withheld, { allowEmpty: true });
    const td = readMoney(later, { allowEmpty: true });
    const fee = readMoney(fees, { allowEmpty: true });
    const informed = readMoney(net, { allowEmpty: true });
    const to = need();
    act((l) => {
      const held = service.position(l, positionId);
      const event = service.redeem(l, positionId, on, amount, to, {
        cost_attributed: attributed,
        tax_withheld: tw ?? "0",
        tax_due_later: td ?? "0",
        fees: fee ?? "0",
        net_informed: informed,
        final,
      });
      // A total redemption closes the position. The domain tests this against the balance after posting, when
      // it is already lower, so it never closes (the desktop has the same defect): done here, in the same action.
      if (
        final &&
        held.mode === investments.model.TrackingMode.VALUE &&
        service.remainingCost(l, positionId).isZero()
      ) {
        l.put("position", { ...held, closed: true }, { reason: "resgate total" });
      }
      return event;
    });
    onDone?.();
  };

  return (
    <FormDialog
      open={open}
      onClose={onClose}
      title={`Resgate — ${name}`}
      description={
        prefill ? "Preenchido pela simulação. Confira os valores: nada é gravado até você confirmar." : undefined
      }
      confirmLabel="Registrar"
      size="lg"
      onConfirm={confirm}
    >
      <FormGrid>
        <DateField label="Data" value={when} onChange={setWhen} />
        <MoneyField label="Valor bruto" value={gross} onChange={setGross} data-autofocus="" />
        <MoneyField label="Custo atribuído" value={cost} onChange={setCost} placeholder="vazio = proporcional" />
        <MoneyField label="Imposto retido no ato" value={withheld} onChange={setWithheld} />
        <MoneyField label="Imposto devido a pagar depois" value={later} onChange={setLater} />
        <MoneyField label="Taxas descontadas" value={fees} onChange={setFees} />
        <MoneyField label="Líquido creditado (conferência)" value={net} onChange={setNet} placeholder="opcional" />
        <Select
          label="Conta de destino"
          options={options}
          value={account}
          onChange={setAccount}
          placeholder="Nenhuma conta"
        />
        <FullRow>
          <Checkbox label="Resgate total (encerra a posição)" checked={final} onCheckedChange={setFinal} />
        </FullRow>
        <FullRow>
          <Caption>
            Sem o custo atribuído, o custo é proporcional ao valor resgatado (hipótese de posição homogênea) e o
            resultado é marcado como estimado. Imposto devido a pagar depois só sai do caixa quando for pago.
          </Caption>
        </FullRow>
      </FormGrid>
    </FormDialog>
  );
}

export function InvestmentNetOnlyDialog({
  open,
  onClose,
  onDone,
  positionId,
  name,
}: FlowProps & { positionId: Id; name: string }) {
  const workspace = useWorkspace();
  const act = useFormAct();
  const { options, account, setAccount, need } = useCash();
  const [when, setWhen] = useState(dateText(workspace.today()));
  const [net, setNet] = useState("");

  const confirm = () => {
    const on = readDate(when);
    const value = readMoney(net);
    const to = need();
    act((l) => service.redeemNetOnly(l, positionId, on, value, to));
    onDone?.();
  };

  return (
    <FormDialog
      open={open}
      onClose={onClose}
      title={`Resgate com deduções a discriminar — ${name}`}
      confirmLabel="Registrar"
      size="sm"
      onConfirm={confirm}
    >
      <FormGrid columns={1}>
        <DateField label="Data" value={when} onChange={setWhen} />
        <MoneyField label="Líquido recebido" value={net} onChange={setNet} data-autofocus="" />
        <Select
          label="Conta de destino"
          options={options}
          value={account}
          onChange={setAccount}
          placeholder="Nenhuma conta"
        />
        <Caption>
          Só o líquido é conhecido: imposto e custo ficam a discriminar e os resultados que usam este resgate aparecem
          como incompletos. Complete-o depois, na tabela Movimentos.
        </Caption>
      </FormGrid>
    </FormDialog>
  );
}

export function InvestmentCompleteDialog({ open, onClose, onDone, eventId }: FlowProps & { eventId: Id }) {
  const ledger = useWorkspace().ledger;
  const act = useFormAct();
  const current = service.events(ledger).get(eventId);
  const [gross, setGross] = useState("");
  const [cost, setCost] = useState("");
  const [withheld, setWithheld] = useState("");
  const [fees, setFees] = useState("");

  const confirm = () => {
    const amount = readMoney(gross);
    const attributed = readMoney(cost, { allowEmpty: true });
    const tw = readMoney(withheld, { allowEmpty: true });
    const fee = readMoney(fees, { allowEmpty: true });
    act((l) =>
      service.completeRedemption(l, eventId, amount, {
        cost_attributed: attributed,
        tax_withheld: tw ?? "0",
        fees: fee ?? "0",
      }),
    );
    onDone?.();
  };

  return (
    <FormDialog
      open={open}
      onClose={onClose}
      title="Completar resgate"
      confirmLabel="Completar"
      size="sm"
      onConfirm={confirm}
    >
      <FormGrid columns={1}>
        {current ? (
          <Caption>
            Resgate de {formatDateBr(current.on)} com líquido {current.net ? formatBrl(current.net) : "—"}. O líquido
            informado deve bater com o bruto menos imposto e taxas.
          </Caption>
        ) : null}
        <MoneyField label="Valor bruto" value={gross} onChange={setGross} data-autofocus="" />
        <MoneyField label="Custo atribuído" value={cost} onChange={setCost} placeholder="vazio = proporcional" />
        <MoneyField label="Imposto retido" value={withheld} onChange={setWithheld} />
        <MoneyField label="Taxas" value={fees} onChange={setFees} />
      </FormGrid>
    </FormDialog>
  );
}
