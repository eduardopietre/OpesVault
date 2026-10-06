/**
 * Faturas (desktop `accounts/bills.py`): a card's bills around today, the chart of them and paying the
 * selected one (docs/04 §5). The oldest bill that still has a balance is selected, so "Pagar…" is ready
 * without a click; a payment after the due date settles the overdue bill first.
 */
import { charts, dom, ymStr, type Id, type YearMonth } from "@opesvault/domain";
import { Badge, type BadgeTone, Button, ChartView, Collapsible, Select, formatBrDate, notify } from "@opesvault/ui";
import { useState } from "react";
import { useLedger, useWorkspace } from "../../data/react.tsx";
import { cardItems } from "../../dialogs/account_choices.ts";
import { BillPaymentDialog, type BillSummary } from "../../dialogs/bill_payment.tsx";
import { toChartData } from "../../data/chart_data.ts";
import {
  type TabReveal,
  Empty,
  ListTable,
  Toolbar,
  useDialog,
  useLock,
  useTabReveal,
} from "../../components/list_parts.tsx";
import type { TierColumn } from "../../components/tier_columns.ts";
import { billRows, cents, defaultBill, money, type BillRow } from "./rows.ts";

const { cards } = dom;

export interface BillReveal {
  cardId: Id;
  month: YearMonth | null;
  pay: boolean;
}

const TONES: Record<dom.cards.BillStatus, BadgeTone> = {
  [cards.BillStatus.OPEN]: "neutral",
  [cards.BillStatus.CLOSED]: "accent",
  [cards.BillStatus.PAID]: "positive",
  [cards.BillStatus.PARTIAL]: "warning",
  [cards.BillStatus.OVERDUE]: "negative",
};

const COLUMNS: TierColumn<BillRow>[] = [
  {
    id: "due",
    header: "Vencimento",
    cell: (r) => formatBrDate(r.due),
    sortValue: (r) => r.due,
    width: 108,
    tier: 1,
  },
  {
    id: "closing",
    header: "Fechamento",
    cell: (r) => formatBrDate(r.closing),
    sortValue: (r) => r.closing,
    width: 108,
    tier: 5,
  },
  {
    id: "charges",
    header: "Lançamentos",
    cell: (r) => money(r.charges),
    sortValue: (r) => cents(r.charges),
    align: "end",
    width: 100,
    tier: 4,
  },
  {
    id: "installments",
    header: "Parcelas",
    cell: (r) => money(r.installments),
    sortValue: (r) => cents(r.installments),
    align: "end",
    width: 92,
    tier: 4,
  },
  {
    id: "credits",
    header: "Créditos",
    cell: (r) => money(r.credits),
    sortValue: (r) => cents(r.credits),
    align: "end",
    width: 92,
    tier: 4,
  },
  {
    id: "total",
    header: "Total",
    cell: (r) => money(r.total),
    sortValue: (r) => cents(r.total),
    align: "end",
    width: 100,
    tier: 1,
  },
  {
    id: "paid",
    header: "Pago",
    cell: (r) => money(r.paid),
    sortValue: (r) => cents(r.paid),
    align: "end",
    width: 100,
    tier: 2,
  },
  {
    id: "remaining",
    header: "Saldo",
    cell: (r) => money(r.remaining),
    sortValue: (r) => cents(r.remaining),
    align: "end",
    width: 100,
    tier: 1,
  },
  {
    id: "document",
    header: "Documento",
    cell: (r) => r.document,
    sortValue: (r) => r.document,
    align: "end",
    width: 130,
    tier: 3,
  },
  {
    id: "status",
    header: "Situação",
    cell: (r) => <Badge tone={TONES[r.status]}>{r.statusLabel}</Badge>,
    sortValue: (r) => r.statusLabel,
    grow: 1,
    width: 150,
    tier: 1,
  },
];

type Pay = { cardId: Id; summary: BillSummary };

/** The bill of a card in a month, even outside the window the table shows. */
function summaryOf(bill: dom.cards.Bill): BillSummary {
  return { due: bill.cycle.due, total: bill.total, payments: bill.payments, remaining: bill.remaining };
}

export function BillsTab({ reveal }: { reveal?: TabReveal<BillReveal> | null }) {
  const workspace = useWorkspace();
  const ledger = workspace.ledger;
  const today = workspace.today();
  const { locked, tip } = useLock();
  const options = cardItems(ledger);
  const [cardPick, setCardPick] = useState<Id | null>(null);
  const [pick, setPick] = useState<string | null>(null);
  const dialog = useDialog<Pay>();
  const cardId = cardPick !== null && ledger.cards.has(cardPick) ? cardPick : (options[0]?.id ?? null);
  const card = cardId ? (ledger.cards.get(cardId) ?? null) : null;

  const rows = useLedger((l) => (cardId ? billRows(l, cardId, today) : []), `${cardId ?? ""}|${today}`);
  const selected = rows.find((r) => r.id === pick) ?? defaultBill(rows);
  const chart = useLedger(
    (l) =>
      cardId && rows.length
        ? toChartData(
            charts.data.cardBillsHistory(
              l,
              cardId,
              rows.map((r) => r.month),
            ),
          )
        : null,
    `${cardId ?? ""}|${rows.map((r) => r.id).join(",")}`,
  );

  const payable = selected?.remaining.isPositive() ?? false;

  const pay = (
    bill: BillSummary | null = selected
      ? { due: selected.due, total: selected.total, payments: selected.paid, remaining: selected.remaining }
      : null,
  ) => {
    if (!card || !bill) {
      notify("Selecione uma fatura.");
      return;
    }
    if (!bill.remaining.isPositive()) {
      notify("Esta fatura já está paga.");
      return;
    }
    dialog.show({ cardId: card.id, summary: bill });
  };

  useTabReveal(reveal, (value) => {
    if (!ledger.cards.has(value.cardId)) return;
    setCardPick(value.cardId);
    const month = value.month;
    const list = billRows(ledger, value.cardId, today);
    const target = month ? list.find((r) => r.id === ymStr(month)) : defaultBill(list);
    setPick(target?.id ?? null);
    if (!value.pay) return;
    if (target) pay({ due: target.due, total: target.total, payments: target.paid, remaining: target.remaining });
    else if (month) pay(summaryOf(cards.bills(ledger, value.cardId, [month])[0]!));
    else notify("Esta fatura já está paga.");
  });

  if (!card || cardId === null) {
    return (
      <Empty title="Nenhum cartão">
        Cadastre um cartão na aba Cartões para acompanhar as faturas e pagar cada uma delas aqui.
      </Empty>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <Toolbar label="Comandos das faturas">
        <div className="w-full max-w-64 min-w-48">
          <Select
            label="Cartão"
            options={options}
            value={cardId}
            onChange={(id) => {
              setCardPick(id);
              setPick(null);
            }}
          />
        </div>
        <div className="flex items-end self-end">
          <Button
            variant="primary"
            onClick={() => pay()}
            disabled={!payable || locked}
            title={locked ? tip : "Registra o pagamento da fatura selecionada"}
          >
            Pagar…
          </Button>
        </div>
      </Toolbar>

      {rows.length ? (
        <>
          {chart ? (
            <Collapsible title="Faturas mês a mês" prefKey="contas/faturas_grafico">
              <ChartView chart={chart} height={240} />
              {chart.note ? <p className="mt-2 text-caption text-secondary">{chart.note}</p> : null}
            </Collapsible>
          ) : null}
          <ListTable
            label="Faturas do cartão"
            rows={rows}
            columns={COLUMNS}
            getRowId={(r) => r.id}
            selectedId={selected?.id ?? null}
            onSelect={setPick}
            onActivate={(id) => {
              setPick(id);
              const row = rows.find((r) => r.id === id);
              if (row) pay({ due: row.due, total: row.total, payments: row.paid, remaining: row.remaining });
            }}
            max={13}
            cardTitle={(r) => `Vence em ${formatBrDate(r.due)}`}
          />
        </>
      ) : (
        <Empty title="Sem faturas por perto">
          {card.name} não tem compras, pagamentos nem documento nos últimos e próximos seis meses. As compras no cartão
          entram na fatura do ciclo em que foram feitas.
        </Empty>
      )}

      {dialog.spec ? (
        <BillPaymentDialog
          key={dialog.key}
          open={dialog.open}
          onClose={dialog.close}
          card={ledger.cards.get(dialog.spec.cardId)!}
          bill={dialog.spec.summary}
          onDone={() => notify(`Pagamento da fatura de ${card.name} registrado.`)}
        />
      ) : null}
    </div>
  );
}
