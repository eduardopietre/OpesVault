/**
 * Financiamentos (desktop `accounts/loans.py`): each contract with its schedule, what is left to pay and early
 * payments. The schedule is computed from the contract; the ledger's balance is the reference.
 */
import { charts, dom, type Id } from "@opesvault/domain";
import { ChartView, Collapsible, MenuButton, notify } from "@opesvault/ui";
import { useState } from "react";
import { useGoTo } from "../../data/navigation.ts";
import { useLedger, useWorkspace } from "../../data/react.tsx";
import { LoanDialog } from "../../dialogs/loan_new.tsx";
import { PayInstallmentDialog } from "../../dialogs/loan_pay.tsx";
import { PrepaymentDialog } from "../../dialogs/loan_prepay.tsx";
import { FigureCard, Money } from "../../components/figures.tsx";
import { toChartData } from "../../data/chart_data.ts";
import { type TabReveal, EditButton, Empty, ListTable, Toolbar, useTabReveal } from "../../components/list_parts.tsx";
import type { TierColumn } from "../../components/tier_columns.ts";
import { installmentRows, loanRows, nextInstallment, type InstallmentRow, type LoanRow } from "./rows.ts";
import { useDialog } from "../../data/dialog.ts";
import { useLock } from "../../data/read_only.ts";
import { cents, moneyOr, dateOr } from "../../data/money.ts";
import { accountRef } from "../livro/rows.ts";

const { loans } = dom;

export interface LoanReveal {
  planId: Id;
  number: number | null;
  pay: boolean;
}

const COLUMNS: TierColumn<LoanRow>[] = [
  { id: "name", header: "Financiamento", cell: (r) => r.name, sortValue: (r) => r.name, grow: 2, width: 170, tier: 1 },
  { id: "system", header: "Sistema", cell: (r) => r.system, sortValue: (r) => r.system, width: 100, tier: 5 },
  { id: "rate", header: "Taxa", cell: (r) => r.rate, width: 160, tier: 3 },
  { id: "paid", header: "Parcelas pagas", cell: (r) => r.paid, width: 130, tier: 2 },
  { id: "next", header: "Próxima", cell: (r) => r.next, grow: 1, width: 180, tier: 1 },
  {
    id: "outstanding",
    header: "Saldo devedor",
    cell: (r) => moneyOr(r.outstanding),
    sortValue: (r) => cents(r.outstanding),
    align: "end",
    width: 135,
    tier: 1,
  },
  {
    id: "inLedger",
    header: "No livro",
    cell: (r) => moneyOr(r.inLedger),
    sortValue: (r) => cents(r.inLedger),
    align: "end",
    width: 135,
    tier: 4,
  },
];

const STATE_TONE: Record<dom.loans.InstallmentState, string> = {
  [loans.InstallmentState.PAID]: "text-positive",
  [loans.InstallmentState.OVERDUE]: "font-medium text-negative",
  [loans.InstallmentState.PENDING]: "",
};

const SCHEDULE_COLUMNS: TierColumn<InstallmentRow>[] = [
  { id: "number", header: "Nº", cell: (r) => r.number, sortValue: (r) => r.number, align: "end", width: 60, tier: 1 },
  { id: "due", header: "Vencimento", cell: (r) => r.due, sortValue: (r) => r.number, width: 110, tier: 1 },
  {
    id: "payment",
    header: "Parcela",
    cell: (r) => moneyOr(r.payment),
    sortValue: (r) => cents(r.payment),
    align: "end",
    width: 120,
    tier: 1,
  },
  {
    id: "amortization",
    header: "Amortização",
    cell: (r) => moneyOr(r.amortization),
    sortValue: (r) => cents(r.amortization),
    align: "end",
    width: 120,
    tier: 3,
  },
  {
    id: "interest",
    header: "Juros",
    cell: (r) => moneyOr(r.interest),
    sortValue: (r) => cents(r.interest),
    align: "end",
    width: 110,
    tier: 2,
  },
  {
    id: "fees",
    header: "Seguros e tarifas",
    cell: (r) => moneyOr(r.fees),
    sortValue: (r) => cents(r.fees),
    align: "end",
    width: 130,
    tier: 5,
  },
  {
    id: "balanceAfter",
    header: "Saldo após",
    cell: (r) => moneyOr(r.balanceAfter),
    sortValue: (r) => cents(r.balanceAfter),
    align: "end",
    width: 130,
    tier: 4,
  },
  {
    id: "state",
    header: "Situação",
    cell: (r) => <span className={STATE_TONE[r.state]}>{r.stateLabel}</span>,
    sortValue: (r) => r.number,
    grow: 2,
    width: 150,
    tier: 1,
  },
];

type Spec = { kind: "new" } | { kind: "pay"; planId: Id; number: number } | { kind: "prepay"; planId: Id };

export function LoansTab({ reveal }: { reveal?: TabReveal<LoanReveal> | null }) {
  const workspace = useWorkspace();
  const ledger = workspace.ledger;
  const today = workspace.today();
  const go = useGoTo();
  const { locked } = useLock();
  const rows = useLedger((l) => loanRows(l, today), today);
  const [planPick, setPlanPick] = useState<Id | null>(null);
  const [numberPick, setNumberPick] = useState<string | null>(null);
  const dialog = useDialog<Spec>();
  const plan = rows.find((r) => r.id === planPick) ?? rows[0] ?? null;
  const planId = plan?.id ?? null;

  const schedule = useLedger((l) => (planId ? installmentRows(l, planId, today) : []), `${planId ?? ""}|${today}`);
  const status = useLedger((l) => (planId ? loans.status(l, planId, today) : null), `${planId ?? ""}|${today}`);
  const chart = useLedger(
    (l) => (planId ? toChartData(charts.data.loanChart(l, planId, today), { monthLabels: true }) : null),
    `${planId ?? ""}|${today}`,
  );
  const installment = schedule.find((r) => r.id === numberPick) ?? nextInstallment(schedule);

  const pay = (number: number | null = installment?.number ?? null, forPlan: Id | null = planId) => {
    if (forPlan === null || number === null) {
      notify("Selecione uma parcela.");
      return;
    }
    if (loans.paidNumbers(ledger, forPlan).has(number)) {
      notify("Esta parcela já está paga.");
      return;
    }
    dialog.show({ kind: "pay", planId: forPlan, number });
  };

  useTabReveal(reveal, (value) => {
    if (!loans.plans(ledger).has(value.planId)) return;
    setPlanPick(value.planId);
    const list = installmentRows(ledger, value.planId, today);
    const target =
      value.number === null ? nextInstallment(list) : (list.find((r) => r.number === value.number) ?? null);
    setNumberPick(target?.id ?? null);
    if (value.pay) pay(target?.number ?? null, value.planId);
  });

  const paying = dialog.spec?.kind === "pay" ? dialog.spec : null;
  const selectedPlan = planId ? loans.plans(ledger).get(planId) : undefined;

  return (
    <div className="flex flex-col gap-4">
      <Toolbar label="Comandos dos financiamentos">
        <EditButton variant="primary" onClick={() => dialog.show({ kind: "new" })}>
          Novo financiamento…
        </EditButton>
        <EditButton onClick={() => pay()}>Pagar parcela…</EditButton>
        <MenuButton
          label="Mais"
          items={[
            {
              id: "prepay",
              label: "Simular ou registrar amortização antecipada…",
              disabled: locked,
              onSelect: () =>
                planId ? dialog.show({ kind: "prepay", planId }) : notify("Selecione um financiamento."),
            },
            {
              id: "ledger",
              label: "Ver lançamentos do financiamento",
              onSelect: () =>
                selectedPlan
                  ? go("livro", { ref: accountRef(selectedPlan.liability_account_id) })
                  : notify("Selecione um financiamento."),
            },
          ]}
        />
      </Toolbar>

      {rows.length ? (
        <ListTable
          label="Financiamentos"
          rows={rows}
          columns={COLUMNS}
          getRowId={(r) => r.id}
          selectedId={planId}
          onSelect={(id) => {
            setPlanPick(id);
            setNumberPick(null);
          }}
          max={6}
        />
      ) : (
        <Empty title="Nenhum financiamento">
          Cadastre o contrato para acompanhar parcelas, juros e o saldo devedor, e simular amortizações antecipadas.
        </Empty>
      )}

      {plan && status ? (
        <>
          <div className="max-tablet:[&_.text-figure]:text-headline">
            <FigureCard
              title={`Situação de ${plan.name}`}
              min="9rem"
              figures={[
                { label: "Saldo devedor", value: <Money value={status.outstanding} /> },
                { label: "Juros a pagar", value: <Money value={status.interestToCome} /> },
                {
                  label: "Parcelas vencidas",
                  value: status.overdue,
                  tone: status.overdue ? "negative" : undefined,
                },
                { label: "Termina em", value: dateOr(status.end) },
              ]}
            />
          </div>
          {chart ? (
            <Collapsible title="Saldo devedor, juros e amortização" prefKey="contas/financiamento_grafico">
              <ChartView chart={chart} height={260} />
              {chart.note ? <p className="mt-2 text-caption text-secondary">{chart.note}</p> : null}
            </Collapsible>
          ) : null}
          <Collapsible title="Cronograma" prefKey="contas/financiamento_cronograma">
            <ListTable
              label="Cronograma de parcelas"
              rows={schedule}
              columns={SCHEDULE_COLUMNS}
              getRowId={(r) => r.id}
              selectedId={installment?.id ?? null}
              onSelect={setNumberPick}
              onActivate={(id) => {
                setNumberPick(id);
                pay(Number(id));
              }}
              max={14}
              cardTitle={(r) => `Parcela ${r.number} · ${r.due}`}
            />
          </Collapsible>
        </>
      ) : null}

      {dialog.spec?.kind === "new" ? (
        <LoanDialog
          key={dialog.key}
          open={dialog.open}
          onClose={dialog.close}
          onDone={(created) => {
            setPlanPick(created.id);
            setNumberPick(null);
            notify("Financiamento criado. O cronograma foi calculado pelo contrato.");
          }}
        />
      ) : null}
      {paying ? (
        <PayInstallmentDialog
          key={dialog.key}
          open={dialog.open}
          onClose={dialog.close}
          plan={loans.plans(ledger).get(paying.planId)!}
          item={loans.planSchedule(ledger, paying.planId).find((i) => i.number === paying.number)!}
          onDone={() => {
            setNumberPick(null);
            notify(`Parcela ${paying.number} registrada: amortização, juros e encargos separados.`);
          }}
        />
      ) : null}
      {dialog.spec?.kind === "prepay" ? (
        <PrepaymentDialog
          key={dialog.key}
          open={dialog.open}
          onClose={dialog.close}
          plan={loans.plans(ledger).get(dialog.spec.planId)!}
          onDone={() => notify("Amortização antecipada registrada; o cronograma foi recalculado.")}
        />
      ) : null}
    </div>
  );
}
