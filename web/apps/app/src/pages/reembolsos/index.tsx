/**
 * Reembolsos e acertos (desktop `ui/pages/sharing_page.py`): money others will pay back, and who owes whom
 * inside the project, with the expenses that form each balance and the settlements already recorded.
 */
import { dom, formatBrl, formatDateBr, type Dec, type Id, type IsoDate } from "@opesvault/domain";
import {
  Adaptive,
  Button,
  Collapsible,
  DataTable,
  ElidedText,
  EmptyState,
  Figure,
  NumberTicker,
  PageHeader,
  formatDecimalBR,
  notify,
  useMotionPreset,
  type DataColumn,
} from "@opesvault/ui";
import { Ban, CircleCheck, Clock, Hourglass } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useMemo, useRef, useState, type ReactNode } from "react";
import { useAct, useLedger, useWorkspace } from "../../data/react.tsx";
import { useGoTo, useReveal } from "../../data/navigation.ts";
import { TableBox } from "../../data/table_box.tsx";
import { OverviewReasonDialog } from "../../dialogs/overview_reason.tsx";
import { SharingReceiveDialog } from "../../dialogs/sharing_receive.tsx";
import { SharingSettleDialog } from "../../dialogs/sharing_settle.tsx";
import {
  cents,
  findReimbursement,
  sharesOf,
  sharingView,
  summaryLine,
  type BalanceRow,
  type ReimbursementRow,
  type SettlementRow,
  type ShareRow,
} from "./rows.ts";

const LOCKED = "Outra aba ou outro aparelho está editando este projeto. Atualize para editar.";
const money = (value: Dec) => formatBrl(value);
const day = (date: IsoDate | null) => (date ? formatDateBr(date) : "—");

const STATE_VIEW = {
  pending: { icon: <Clock aria-hidden="true" className="size-4 shrink-0" />, tone: "text-warning" },
  partial: { icon: <Hourglass aria-hidden="true" className="size-4 shrink-0" />, tone: "text-warning" },
  received: { icon: <CircleCheck aria-hidden="true" className="size-4 shrink-0" />, tone: "text-positive" },
  denied: { icon: <Ban aria-hidden="true" className="size-4 shrink-0" />, tone: "text-negative" },
} as const;

/** The state in words with a shape, never by color alone. */
function StateLabel({ row }: { row: ReimbursementRow }) {
  const view = STATE_VIEW[row.state];
  return (
    <span className={`inline-flex min-w-0 items-center gap-1.5 font-medium ${view.tone}`}>
      {view.icon}
      <span className="truncate">{dom.sharing.STATE_LABELS[row.state]}</span>
    </span>
  );
}

const text = (value: string) => <ElidedText>{value}</ElidedText>;

const REIMBURSEMENT_COLUMNS: DataColumn<ReimbursementRow>[] = [
  { id: "date", header: "Data", cell: (r) => day(r.date), sortValue: (r) => r.date ?? "", width: 112, priority: 2 },
  {
    id: "description",
    header: "Lançamento",
    cell: (r) => text(r.description),
    sortValue: (r) => r.description,
    grow: 2,
    width: 140,
  },
  { id: "payer", header: "Quem reembolsa", cell: (r) => text(r.payer), sortValue: (r) => r.payer, grow: 1, width: 130 },
  {
    id: "expected",
    header: "Esperado",
    cell: (r) => money(r.expected),
    sortValue: (r) => cents(r.expected),
    align: "end",
    width: 120,
  },
  {
    id: "received",
    header: "Recebido",
    cell: (r) => money(r.received),
    sortValue: (r) => cents(r.received),
    align: "end",
    width: 110,
  },
  {
    id: "state",
    header: "Situação",
    cell: (r) => <StateLabel row={r} />,
    sortValue: (r) => dom.sharing.STATE_LABELS[r.state],
    width: 190,
  },
];

const BALANCE_COLUMNS: DataColumn<BalanceRow>[] = [
  { id: "debtor", header: "Quem deve", cell: (r) => text(r.debtor), sortValue: (r) => r.debtor, grow: 1, width: 110 },
  {
    id: "creditor",
    header: "Para quem",
    cell: (r) => text(r.creditor),
    sortValue: (r) => r.creditor,
    grow: 1,
    width: 110,
  },
  {
    id: "amount",
    header: "Valor",
    cell: (r) => money(r.amount),
    sortValue: (r) => cents(r.amount),
    align: "end",
    width: 120,
  },
  {
    id: "settled",
    header: "Já acertado",
    cell: (r) => money(r.settled),
    sortValue: (r) => cents(r.settled),
    align: "end",
    width: 110,
  },
];

const SHARE_COLUMNS: DataColumn<ShareRow>[] = [
  { id: "date", header: "Data", cell: (r) => day(r.date), sortValue: (r) => r.date ?? "", width: 112, priority: 2 },
  {
    id: "description",
    header: "Lançamento",
    cell: (r) => text(r.description),
    sortValue: (r) => r.description,
    grow: 2,
    width: 150,
  },
  {
    id: "amount",
    header: "Parte devida",
    cell: (r) => money(r.amount),
    sortValue: (r) => cents(r.amount),
    align: "end",
    width: 120,
  },
];

const HISTORY_COLUMNS: DataColumn<SettlementRow>[] = [
  { id: "date", header: "Data", cell: (r) => day(r.date), sortValue: (r) => r.date, width: 112 },
  { id: "debtor", header: "Quem pagou", cell: (r) => text(r.debtor), sortValue: (r) => r.debtor, grow: 1, width: 110 },
  {
    id: "creditor",
    header: "Para quem",
    cell: (r) => text(r.creditor),
    sortValue: (r) => r.creditor,
    grow: 1,
    width: 110,
  },
  {
    id: "amount",
    header: "Valor",
    cell: (r) => money(r.amount),
    sortValue: (r) => cents(r.amount),
    align: "end",
    width: 120,
  },
  {
    id: "note",
    header: "Observação",
    cell: (r) => text(r.note),
    sortValue: (r) => r.note,
    grow: 2,
    width: 140,
  },
];

interface Opening {
  key: number;
}
interface ReceiveOpening extends Opening {
  id: Id;
}
interface SettleOpening extends Opening {
  debtorId: Id | null;
  creditorId: Id | null;
  amount: Dec | null;
}

/** The bar that names what is selected and what can be done with it. */
function SelectionBar({ label, children }: { label: string; children: ReactNode }) {
  const preset = useMotionPreset();
  return (
    <motion.div
      {...preset.enter}
      className="mt-3 flex flex-wrap items-center gap-2 rounded-lg bg-accent-soft px-3 py-2"
    >
      <div className="min-w-0 flex-1 basis-40 text-body">
        <span className="text-secondary">Selecionado: </span>
        <span className="font-semibold">
          <ElidedText className="inline-block max-w-full align-bottom">{label}</ElidedText>
        </span>
      </div>
      {children}
    </motion.div>
  );
}

export function Page() {
  const workspace = useWorkspace();
  const act = useAct();
  const goTo = useGoTo();
  const locked = workspace.readOnly;
  const lockTip = locked ? LOCKED : undefined;
  const counter = useRef(0);
  const tableBox = useRef<HTMLDivElement>(null);

  const view = useLedger((ledger) => sharingView(ledger));
  const [pickedReimbursement, setPickedReimbursement] = useState<string | null>(null);
  const [pickedBalance, setPickedBalance] = useState<string | null>(null);
  const [pickedShare, setPickedShare] = useState<string | null>(null);
  const reimbursement = view.reimbursements.find((r) => r.id === pickedReimbursement) ?? null;
  // The first balance is selected, as on the desktop, so the expenses behind it are always in view.
  const balance = view.balances.find((b) => b.id === pickedBalance) ?? view.balances[0] ?? null;
  const shares = useMemo(() => sharesOf(balance), [balance]);
  const share = shares.find((s) => s.id === pickedShare) ?? null;

  const [receive, setReceive] = useState<ReceiveOpening | null>(null);
  const [receiveOpen, setReceiveOpen] = useState(false);
  const [settle, setSettle] = useState<SettleOpening | null>(null);
  const [settleOpen, setSettleOpen] = useState(false);
  const [deny, setDeny] = useState<ReceiveOpening | null>(null);
  const [denyOpen, setDenyOpen] = useState(false);

  const needsReimbursement = (): ReimbursementRow | null => {
    if (reimbursement) return reimbursement;
    notify("Selecione um reembolso na tabela.");
    return null;
  };

  const openReceive = (row: ReimbursementRow | null = needsReimbursement()) => {
    if (!row) return;
    setReceive({ key: ++counter.current, id: row.id });
    setReceiveOpen(true);
  };

  const openDeny = () => {
    const row = needsReimbursement();
    if (!row) return;
    setDeny({ key: ++counter.current, id: row.id });
    setDenyOpen(true);
  };

  const denyIt = (reason: string) => {
    if (deny) act((ledger) => dom.sharing.deny(ledger, deny.id, reason), "Reembolso marcado como negado.");
  };

  const seeOperation = (id: Id | null | undefined) => {
    if (id) goTo("livro", { ref: id });
  };

  const openSettle = (from: BalanceRow | null = balance) => {
    setSettle({
      key: ++counter.current,
      debtorId: from?.debtorId ?? null,
      creditorId: from?.creditorId ?? null,
      amount: from?.amount ?? null,
    });
    setSettleOpen(true);
  };

  // Another screen names a reimbursement (or the expense it refunds); "receber" starts the receipt.
  useReveal((ref, action) => {
    const row = findReimbursement(view.reimbursements, ref);
    if (!row) {
      if (ref) notify("Esse reembolso não existe mais.");
      return;
    }
    setPickedReimbursement(row.id);
    requestAnimationFrame(() => tableBox.current?.scrollIntoView({ block: "nearest", behavior: "smooth" }));
    if (action === "receber" && !locked) openReceive(row);
  });

  const figures: { label: string; value: Dec; note?: string }[] = [
    { label: "A receber de reembolsos", value: view.waiting },
    { label: "Acertos pendentes no projeto", value: view.owed },
  ];

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Reembolsos e acertos" context={summaryLine(view)} />

      {view.hasContent ? (
        <>
          <div className="grid grid-cols-1 gap-3 min-[420px]:grid-cols-2">
            {figures.map((figure) => (
              <div
                key={figure.label}
                className="min-w-0 rounded-xl border border-separator bg-raised px-4 py-3 shadow-sm max-tablet:px-3 max-tablet:[&_.text-figure]:text-headline"
              >
                <Figure
                  label={figure.label}
                  value={
                    <NumberTicker
                      value={figure.value.toFixed()}
                      format={(value) => formatDecimalBR(value, { places: 2, currency: true })}
                    />
                  }
                />
              </div>
            ))}
          </div>

          {view.reimbursements.length > 0 ? (
            <div ref={tableBox}>
              <Collapsible
                title="Reembolsos"
                prefKey="acertos/reembolsos"
                description="Despesas que outra pessoa ou empresa vai devolver (plano de saúde, empresa). Marque no Livro financeiro: Ações › Reembolso a receber. O valor recebido entra como estorno das mesmas categorias, no mês do recebimento."
                actions={
                  <>
                    <Button variant="primary" onClick={() => openReceive()} disabled={locked} title={lockTip}>
                      Registrar recebimento…
                    </Button>
                    <Button onClick={openDeny} disabled={locked} title={lockTip}>
                      Negado…
                    </Button>
                    <Button onClick={() => seeOperation(needsReimbursement()?.operationId)}>Ver lançamento</Button>
                  </>
                }
              >
                <TableBox rows={view.reimbursements.length} cap={10}>
                  {(height) => (
                    <DataTable
                      label="Reembolsos"
                      rows={view.reimbursements}
                      columns={REIMBURSEMENT_COLUMNS}
                      getRowId={(r) => r.id}
                      selectedId={reimbursement?.id ?? null}
                      onSelect={setPickedReimbursement}
                      onActivate={(id) => {
                        setPickedReimbursement(id);
                        if (!locked) openReceive(view.reimbursements.find((r) => r.id === id) ?? null);
                      }}
                      cardTitle={(r) => text(r.description)}
                      height={height}
                    />
                  )}
                </TableBox>
              </Collapsible>
            </div>
          ) : null}

          {view.hasShares || view.settlements.length > 0 ? (
            <Adaptive at={1400} columns={view.settlements.length > 0 ? "1fr 1fr" : "1fr"} gap={24}>
              <Collapsible
                title="Acertos entre integrantes"
                prefKey="acertos/integrantes"
                description="Numa despesa com rateio, quem pagou adiantou a parte dos outros. Paga quem é o único titular da conta de onde saiu o dinheiro, ou o titular do cartão; conta conjunta não gera dívida entre integrantes. Registrar o acerto não movimenta dinheiro."
                actions={
                  <Button onClick={() => openSettle()} disabled={locked} title={lockTip}>
                    Registrar acerto…
                  </Button>
                }
              >
                <TableBox rows={view.balances.length} cap={8}>
                  {(height) => (
                    <DataTable
                      label="Saldos entre integrantes"
                      rows={view.balances}
                      columns={BALANCE_COLUMNS}
                      getRowId={(r) => r.id}
                      selectedId={balance?.id ?? null}
                      onSelect={(id) => {
                        setPickedBalance(id);
                        setPickedShare(null);
                      }}
                      onActivate={(id) => {
                        setPickedBalance(id);
                        if (!locked) openSettle(view.balances.find((b) => b.id === id) ?? null);
                      }}
                      cardTitle={(r) => text(`${r.debtor} deve a ${r.creditor}`)}
                      height={height}
                      empty={<p className="px-3 py-6 text-center text-body text-secondary">Ninguém deve a ninguém.</p>}
                    />
                  )}
                </TableBox>
                {balance ? (
                  <div className="mt-5">
                    <h3 className="mb-2 text-body font-semibold">
                      Despesas que formam o saldo selecionado
                      <span className="sr-only">
                        : {balance.debtor} deve a {balance.creditor}
                      </span>
                    </h3>
                    <TableBox rows={shares.length} cap={10}>
                      {(height) => (
                        <DataTable
                          label="Despesas que formam o saldo"
                          rows={shares}
                          columns={SHARE_COLUMNS}
                          getRowId={(r) => r.id}
                          selectedId={share?.id ?? null}
                          onSelect={setPickedShare}
                          onActivate={seeOperation}
                          cardTitle={(r) => text(r.description)}
                          height={height}
                        />
                      )}
                    </TableBox>
                    <AnimatePresence initial={false}>
                      {share ? (
                        <SelectionBar key="share" label={share.description}>
                          <Button size="sm" onClick={() => seeOperation(share.id)}>
                            Ver lançamento
                          </Button>
                        </SelectionBar>
                      ) : null}
                    </AnimatePresence>
                  </div>
                ) : null}
              </Collapsible>
              {view.settlements.length > 0 ? (
                <Collapsible title="Acertos registrados" prefKey="acertos/historico">
                  <TableBox rows={view.settlements.length} cap={8}>
                    {(height) => (
                      <DataTable
                        label="Acertos registrados"
                        rows={view.settlements}
                        columns={HISTORY_COLUMNS}
                        getRowId={(r) => r.id}
                        cardTitle={(r) => text(`${r.debtor} pagou a ${r.creditor}`)}
                        height={height}
                      />
                    )}
                  </TableBox>
                </Collapsible>
              ) : null}
            </Adaptive>
          ) : null}
        </>
      ) : (
        <div className="rounded-xl border border-dashed border-separator-strong bg-window/40">
          <EmptyState
            title="Nada a receber nem a acertar"
            description="Marque uma despesa como reembolsável no Livro financeiro (Ações › Reembolso a receber) ou ratear despesas entre integrantes para ver aqui quem deve a quem."
            actions={
              <>
                <Button onClick={() => openSettle(null)} disabled={locked} title={lockTip}>
                  Registrar acerto…
                </Button>
                <Button variant="primary" onClick={() => goTo("livro")}>
                  Abrir o Livro financeiro
                </Button>
              </>
            }
          />
        </div>
      )}

      {receive ? (
        <SharingReceiveDialog
          key={receive.key}
          open={receiveOpen}
          onClose={() => setReceiveOpen(false)}
          reimbursementId={receive.id}
          onDone={() => notify("Reembolso recebido: a despesa líquida foi reduzida.")}
        />
      ) : null}
      {settle ? (
        <SharingSettleDialog
          key={settle.key}
          open={settleOpen}
          onClose={() => setSettleOpen(false)}
          debtorId={settle.debtorId}
          creditorId={settle.creditorId}
          amount={settle.amount}
          onDone={() => notify("Acerto registrado.")}
        />
      ) : null}
      {deny ? (
        <OverviewReasonDialog
          key={deny.key}
          open={denyOpen}
          onOpenChange={setDenyOpen}
          title="Reembolso negado"
          description="O reembolso deixa de contar como a receber. O motivo fica no histórico."
          label="Motivo"
          confirmLabel="Marcar como negado"
          onConfirm={denyIt}
        />
      ) : null}
    </div>
  );
}
