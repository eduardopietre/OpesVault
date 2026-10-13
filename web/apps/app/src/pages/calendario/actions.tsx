/**
 * Paying or linking a due item right in the calendar, with the same dialogs as Contas and Recorrências: a card
 * bill or a loan installment is paid ("Pagar…"), a recurrence's forecast is linked to the operation that realized
 * it ("Vincular…"). Something already resolved, or an investment's maturity, has no action here: it only opens.
 */
import { dom, type Id, type IsoDate, type YearMonth } from "@opesvault/domain";
import { notify } from "@opesvault/ui";
import type { ReactNode } from "react";
import { BillPaymentDialog, type BillSummary } from "../../dialogs/bill_payment.tsx";
import { PayInstallmentDialog } from "../../dialogs/loan_pay.tsx";
import { RecurrenceLinkDialog } from "../../dialogs/recurrence_link.tsx";
import { useDialog } from "../../data/dialog.ts";
import { useWorkspace } from "../../data/react.tsx";

type AgendaEvent = dom.agenda.AgendaEvent;
type Forecast = dom.recurrence.Forecast;

type Spec =
  | { kind: "bill"; cardId: Id; bill: BillSummary }
  | { kind: "installment"; planId: Id; number: number }
  | { kind: "link"; forecast: Forecast; candidates: ReturnType<typeof dom.recurrence.candidates> };

/** What an entry's own button does here: its words and the command. */
export interface EntryAction {
  label: "Pagar…" | "Vincular…";
  run: () => void;
}

/** The kind of action an entry has in the calendar, from what it is and its state (no ledger needed). */
export function actionKind(event: AgendaEvent): "pay" | "link" | null {
  if (event.state === dom.agenda.EventState.DONE || !Array.isArray(event.ref)) return null;
  if (event.kind === "fatura" || event.kind === "financiamento") return "pay";
  if (event.kind === "recorrência") return "link";
  return null;
}

export interface AgendaActions {
  actionOf: (event: AgendaEvent) => EntryAction | null;
  /** The dialog, to render once on the page. */
  dialogs: ReactNode;
}

export function useAgendaActions(): AgendaActions {
  const workspace = useWorkspace();
  const ledger = workspace.ledger;
  const dialog = useDialog<Spec>();

  const payBill = (cardId: Id, month: YearMonth) => {
    const card = ledger.cards.get(cardId);
    const bill = card ? dom.cards.bills(ledger, cardId, [month])[0] : undefined;
    if (!bill) return;
    if (!bill.remaining.isPositive()) {
      notify("Esta fatura já está paga.");
      return;
    }
    dialog.show({
      kind: "bill",
      cardId,
      bill: { due: bill.cycle.due, total: bill.total, payments: bill.payments, remaining: bill.remaining },
    });
  };

  const payInstallment = (planId: Id, number: number) => {
    if (!dom.loans.plans(ledger).has(planId)) return;
    if (dom.loans.paidNumbers(ledger, planId).has(number)) {
      notify(`A parcela ${number} já está paga.`);
      return;
    }
    dialog.show({ kind: "installment", planId, number });
  };

  const link = (ruleId: Id, dueOn: IsoDate) => {
    const forecast = dom.recurrence
      .forecasts(ledger, dueOn, dueOn, workspace.today())
      .find((found) => found.ruleId === ruleId);
    if (!forecast || forecast.status === "realized" || forecast.status === "skipped") {
      notify("Esta previsão já foi resolvida.");
      return;
    }
    const candidates = dom.recurrence.candidates(ledger, forecast);
    if (!candidates.length) {
      notify("Nenhum lançamento compatível (conta, valor e data).");
      return;
    }
    dialog.show({ kind: "link", forecast, candidates });
  };

  const actionOf = (event: AgendaEvent): EntryAction | null => {
    const kind = actionKind(event);
    const ref = event.ref as unknown[];
    if (kind === "link") return { label: "Vincular…", run: () => link(ref[0] as Id, ref[1] as IsoDate) };
    if (kind !== "pay") return null;
    if (event.kind === "fatura") return { label: "Pagar…", run: () => payBill(ref[0] as Id, ref[1] as YearMonth) };
    return { label: "Pagar…", run: () => payInstallment(ref[1] as Id, ref[2] as number) };
  };

  const spec = dialog.spec;
  let dialogs: ReactNode = null;
  if (spec?.kind === "bill") {
    const card = ledger.cards.get(spec.cardId);
    dialogs = card ? (
      <BillPaymentDialog
        key={dialog.key}
        open={dialog.open}
        onClose={dialog.close}
        card={card}
        bill={spec.bill}
        onDone={() => notify(`Pagamento da fatura de ${card.name} registrado.`)}
      />
    ) : null;
  } else if (spec?.kind === "installment") {
    const plan = dom.loans.plans(ledger).get(spec.planId);
    const item = dom.loans.planSchedule(ledger, spec.planId).find((i) => i.number === spec.number);
    dialogs =
      plan && item ? (
        <PayInstallmentDialog
          key={dialog.key}
          open={dialog.open}
          onClose={dialog.close}
          plan={plan}
          item={item}
          onDone={() => notify(`Parcela ${spec.number} registrada: amortização, juros e encargos separados.`)}
        />
      ) : null;
  } else if (spec?.kind === "link") {
    dialogs = (
      <RecurrenceLinkDialog
        key={dialog.key}
        open={dialog.open}
        onClose={dialog.close}
        forecast={spec.forecast}
        candidates={spec.candidates}
        onDone={() => notify("Previsão vinculada ao lançamento.")}
      />
    );
  }
  return { actionOf, dialogs };
}
