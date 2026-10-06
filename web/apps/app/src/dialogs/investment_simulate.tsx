/**
 * Simulador de resgate (desktop `EventCommands.simulate`, docs/07 §6, docs/06 §7): gross value, attributed
 * cost, gain, tax base, rule, tax, fees and net, every estimated field named. It never writes: not the portfolio,
 * not the cash, not the history. "Registrar resgate…" opens the redemption already filled, which asks for the
 * person's confirmation like any other.
 */
import { DomainError, formatBrl, investments, type Dec, type Id, type IsoDate } from "@opesvault/domain";
import { Badge, Button, DateField, Dialog, MoneyField, Select, type SelectOption } from "@opesvault/ui";
import { useState } from "react";
import { useWorkspace } from "../data/react.tsx";
import { Caption, dateText, editableMoney, readDate, readMoney } from "./livro_form.tsx";
import { percent } from "./investment_forms.ts";
import type { RedemptionPrefill } from "./investment_redeem.tsx";

const { performance, simulation } = investments;

export interface InvestmentSimulateDialogProps {
  open: boolean;
  onClose: () => void;
  positionId: Id;
  name: string;
  /** Opens the redemption, filled with what was simulated. */
  onRegister?: (prefill: RedemptionPrefill) => void;
}

interface Outcome {
  snapshot: string;
  sim: investments.simulation.Simulation;
  ruleName: string;
}

const money = (value: Dec | null) => (value === null ? "indisponível" : formatBrl(value));

function Row({ label, value, estimated, hint }: { label: string; value: string; estimated?: boolean; hint?: string }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 border-b border-separator/70 py-1.5 last:border-0">
      <dt className="text-secondary">{label}</dt>
      <dd className="flex min-w-0 flex-wrap items-center justify-end gap-2 text-right font-medium tabular-nums">
        {estimated ? <Badge tone="warning">estimado</Badge> : null}
        <span className="min-w-0">{value}</span>
        {hint ? <span className="w-full text-caption font-normal text-secondary">{hint}</span> : null}
      </dd>
    </div>
  );
}

export function InvestmentSimulateDialog({
  open,
  onClose,
  positionId,
  name,
  onRegister,
}: InvestmentSimulateDialogProps) {
  const workspace = useWorkspace();
  const ledger = workspace.ledger;
  const rules = [...ledger.entities<investments.model.TaxRule>("tax_rule").values()];
  const options: SelectOption[] = rules.map((r) => ({ id: r.id, label: r.name }));
  const [when, setWhen] = useState(dateText(workspace.today()));
  const [gross, setGross] = useState("");
  const [rule, setRule] = useState<string | null>(options[0]?.id ?? null);
  const [fees, setFees] = useState("");
  const [cost, setCost] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const snapshot = [when, gross, rule, fees, cost].join("|");
  const shown = outcome && outcome.snapshot === snapshot ? outcome : null;

  const run = () => {
    setError(null);
    try {
      const on: IsoDate = readDate(when);
      const amount = readMoney(gross);
      const chosen = rules.find((r) => r.id === rule);
      if (!chosen) throw new DomainError("Escolha a regra de imposto.");
      const informedFees = readMoney(fees, { allowEmpty: true });
      const attributed = readMoney(cost, { allowEmpty: true });
      const observed = performance.valueAt(ledger, positionId, on);
      const sim = simulation.simulate(ledger, positionId, on, amount, chosen, {
        fees: informedFees ?? "0",
        cost_attributed: attributed,
        current_value: observed ? observed.valuation.value : null,
      });
      setOutcome({ snapshot, sim, ruleName: chosen.name });
    } catch (cause) {
      if (cause instanceof DomainError) {
        setError(cause.message);
        setOutcome(null);
      } else throw cause;
    }
  };

  const register = () => {
    if (!shown) return;
    onClose();
    onRegister?.({
      on: when,
      gross: editableMoney(shown.sim.gross),
      cost: cost.trim() ? cost : "",
      fees: shown.sim.fees.isZero() ? "" : editableMoney(shown.sim.fees),
    });
  };

  const sim = shown?.sim ?? null;
  const estimated = (field: string) => (sim?.estimated_fields ?? []).some((f) => f.startsWith(field));

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title={`Simular resgate — ${name}`}
      description="Não altera nada: nem a carteira, nem o caixa, nem o histórico realizado."
      size="lg"
      onSubmit={run}
      footer={
        <>
          <Button onClick={onClose}>Fechar</Button>
          {sim && onRegister ? <Button onClick={register}>Registrar resgate…</Button> : null}
          <Button variant="primary" type="submit">
            Simular
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="grid grid-cols-1 gap-x-4 gap-y-3 tablet:grid-cols-2">
          <DateField label="Data" value={when} onChange={setWhen} />
          <MoneyField label="Valor bruto a resgatar" value={gross} onChange={setGross} data-autofocus="" />
          <Select label="Regra" options={options} value={rule} onChange={setRule} placeholder="Nenhuma regra" />
          <MoneyField label="Taxas" value={fees} onChange={setFees} />
          <MoneyField label="Custo atribuído" value={cost} onChange={setCost} placeholder="vazio = proporcional" />
        </div>
        {error ? (
          <p role="alert" className="rounded-md bg-negative-soft px-3 py-2 text-body font-medium text-negative">
            <span className="sr-only">Erro no formulário: </span>
            {error}
          </p>
        ) : null}
        {sim && shown ? (
          <section
            aria-label="Resultado da simulação"
            className="rounded-lg border border-separator bg-window/50 px-4 py-3"
          >
            <div className="mb-1 flex items-center gap-2 text-body font-semibold">
              <Badge tone="accent">Simulação</Badge>
              <span>não registra operação</span>
            </div>
            <dl className="text-body">
              <Row label="Valor bruto" value={formatBrl(sim.gross)} />
              <Row
                label="Custo atribuído"
                value={money(sim.cost_attributed)}
                estimated={estimated("custo atribuído")}
                hint={sim.cost_method}
              />
              <Row label="Ganho" value={money(sim.gain)} />
              <Row label="Base do imposto" value={sim.tax_base === null ? "—" : money(sim.tax_base)} />
              <Row label="Regra" value={sim.rule} />
              <Row label="Imposto" value={money(sim.tax)} estimated />
              <Row label="Taxas" value={formatBrl(sim.fees)} />
              <Row label="Líquido" value={money(sim.net)} estimated />
              <Row
                label="Retorno bruto"
                value={percent(sim.gross_return)}
                hint="sobre o custo atribuído, sem anualização"
              />
              <Row label="Retorno líquido" value={percent(sim.net_return)} hint="sem anualização" />
              {sim.remaining_value !== null ? (
                <Row label="Valor que sobra" value={formatBrl(sim.remaining_value)} />
              ) : null}
              {sim.remaining_cost !== null ? (
                <Row label="Custo que sobra" value={formatBrl(sim.remaining_cost)} />
              ) : null}
            </dl>
            <Caption>Campos estimados: {sim.estimated_fields.join(", ")}.</Caption>
          </section>
        ) : outcome ? (
          <Caption>Os valores mudaram desde a última simulação: simule de novo.</Caption>
        ) : null}
      </div>
    </Dialog>
  );
}
