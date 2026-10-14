/**
 * Reembolsos e acertos (desktop `ui/pages/sharing_page.py`): money others will pay back, and who owes whom
 * inside the project, with the expenses that form each balance and the settlements already recorded. A new
 * reimbursement starts here too (pick the expense), and a recorded settlement can be corrected or undone.
 */
import { dom, formatBrl, type Dec, type Id } from "@opesvault/domain";
import {
  Adaptive,
  Button,
  Collapsible,
  confirm,
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
  type MenuEntry,
} from "@opesvault/ui";
import { Ban, CircleCheck, Clock, Hourglass, Plus } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useMemo, useRef, type ReactNode } from "react";
import { useAct, useLedger } from "../../data/react.tsx";
import { useGoTo, useReveal } from "../../data/navigation.ts";
import { TableBox } from "../../data/table_box.tsx";
import { OverviewReasonDialog } from "../../dialogs/overview_reason.tsx";
import { ReimbursementDialog } from "../../dialogs/reimbursement.tsx";
import { SharingReceiveDialog } from "../../dialogs/sharing_receive.tsx";
import { SharingSettleDialog } from "../../dialogs/sharing_settle.tsx";
import {
  findReimbursement,
  sharesOf,
  sharingView,
  summaryLine,
  type BalanceRow,
  type ReimbursementRow,
  type SettlementRow,
  type ShareRow,
} from "./rows.ts";
import { EditButton, usePick } from "../../components/list_parts.tsx";
import { lockEntries, useLock } from "../../data/read_only.ts";
import { useDialog } from "../../data/dialog.ts";
import { cents, dateOr } from "../../data/money.ts";

const money = (value: Dec) => formatBrl(value);

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
  { id: "date", header: "Data", cell: (r) => dateOr(r.date), sortValue: (r) => r.date ?? "", width: 112, priority: 2 },
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
  { id: "date", header: "Data", cell: (r) => dateOr(r.date), sortValue: (r) => r.date ?? "", width: 112, priority: 2 },
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
  { id: "date", header: "Data", cell: (r) => dateOr(r.date), sortValue: (r) => r.date, width: 112 },
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

interface ReceiveOpening {
  id: Id;
}
interface SettleOpening {
  debtorId: Id | null;
  creditorId: Id | null;
  amount: Dec | null;
  /** A recorded settlement to correct. */
  settlementId?: Id;
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
  const act = useAct();
  const goTo = useGoTo();
  const { locked } = useLock();
  const tableBox = useRef<HTMLDivElement>(null);

  const view = useLedger((ledger) => sharingView(ledger));
  const reimbursementPick = usePick(view.reimbursements, (r) => r.id);
  const { selected: reimbursement, setPick: setPickedReimbursement } = reimbursementPick;
  // The first balance is selected, as on the desktop, so the expenses behind it are always in view.
  const { selected: balance, setPick: setPickedBalance } = usePick(view.balances, (b) => b.id, { first: true });
  const shares = useMemo(() => sharesOf(balance), [balance]);
  const { selected: share, setPick: setPickedShare } = usePick(shares, (s) => s.id);
  const settlementPick = usePick(view.settlements, (s) => s.id);
  const { selected: settlement, setPick: setPickedSettlement } = settlementPick;

  const receiveSlot = useDialog<ReceiveOpening>();
  const settleSlot = useDialog<SettleOpening>();
  const denySlot = useDialog<ReceiveOpening>();
  const requestSlot = useDialog<true>();
  const receive = receiveSlot.spec;
  const settle = settleSlot.spec;
  const deny = denySlot.spec;

  const needsReimbursement = () => reimbursementPick.need("Selecione um reembolso na tabela.");

  const openReceive = (row: ReimbursementRow | null = needsReimbursement()) => {
    if (!row) return;
    receiveSlot.show({ id: row.id });
  };

  const openDeny = (row: ReimbursementRow | null = needsReimbursement()) => {
    if (!row) return;
    denySlot.show({ id: row.id });
  };

  const denyIt = (reason: string) => {
    if (deny) {
      act((ledger) => dom.sharing.deny(ledger, deny.id, reason), {
        done: "Reembolso marcado como negado.",
        label: "negar reembolso",
      });
    }
  };

  const seeOperation = (id: Id | null | undefined) => {
    if (id) goTo("livro", { ref: id });
  };

  const openSettle = (from: BalanceRow | null = balance) => {
    settleSlot.show({
      debtorId: from?.debtorId ?? null,
      creditorId: from?.creditorId ?? null,
      amount: from?.amount ?? null,
    });
  };

  const needsSettlement = () => settlementPick.need("Selecione um acerto na tabela Acertos registrados.");

  const openFix = (row: SettlementRow | null = needsSettlement()) => {
    if (!row) return;
    settleSlot.show({ debtorId: null, creditorId: null, amount: null, settlementId: row.id });
  };

  /** Undoes a recorded settlement, after asking: the balance between the two comes back. */
  const undoSettlement = async (row: SettlementRow | null = needsSettlement()) => {
    if (!row) return;
    const sure = await confirm({
      title: "Desfazer este acerto?",
      text: `${row.debtor} pagou ${money(row.amount)} a ${row.creditor} em ${dateOr(row.date)}. O acerto sai do projeto e o saldo entre os dois volta a contar esse valor.`,
      confirmLabel: "Desfazer acerto",
      danger: true,
    });
    if (!sure) return;
    act((ledger) => dom.sharing.removeSettlement(ledger, row.id), {
      done: "Acerto desfeito.",
      label: "desfazer acerto",
    });
    setPickedSettlement(null);
  };

  /** A recorded settlement's context menu: correct it, and undo it apart and in red. */
  const settlementMenu = (row: SettlementRow): MenuEntry[] =>
    lockEntries(
      [
        { id: "fix", label: "Corrigir acerto…", onSelect: () => openFix(row) },
        { kind: "separator", id: "s1" },
        { id: "undo", label: "Desfazer acerto…", danger: true, onSelect: () => void undoSettlement(row) },
      ],
      locked,
    );

  const seeOperationEntry = (id: Id): MenuEntry => ({
    id: "operation",
    label: "Ver lançamento",
    onSelect: () => seeOperation(id),
  });

  /** A reimbursement's context menu: receive it, see its expense, and Negado apart and in red. */
  // Only a reimbursement still waiting for money (pending or partial) can be received or denied.
  const reimbursementMenu = (row: ReimbursementRow): MenuEntry[] =>
    lockEntries(
      row.open
        ? [
            { id: "receive", label: "Registrar recebimento…", onSelect: () => openReceive(row) },
            { kind: "separator", id: "s1" },
            seeOperationEntry(row.operationId),
            { kind: "separator", id: "s2" },
            { id: "deny", label: "Negado…", danger: true, onSelect: () => openDeny(row) },
          ]
        : [seeOperationEntry(row.operationId)],
      locked,
      ["operation"],
    );

  /** A balance between members: settle it, prefilled with its pair and amount. */
  const balanceMenu = (row: BalanceRow): MenuEntry[] =>
    lockEntries([{ id: "settle", label: "Registrar acerto…", onSelect: () => openSettle(row) }], locked);

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
      <PageHeader
        title="Reembolsos e acertos"
        context={summaryLine(view)}
        primary={
          <EditButton variant="primary" icon={<Plus />} onClick={() => requestSlot.show(true)}>
            Novo reembolso…
          </EditButton>
        }
      />

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
                description="Despesas que outra pessoa ou empresa vai devolver (plano de saúde, empresa). Crie com Novo reembolso ou, no Livro financeiro, em Ações › Reembolso a receber. O valor recebido entra como estorno das mesmas categorias, no mês do recebimento."
                actions={
                  <>
                    <EditButton variant="primary" onClick={() => openReceive()}>
                      Registrar recebimento…
                    </EditButton>
                    <EditButton onClick={() => openDeny()}>Negado…</EditButton>
                    <Button onClick={() => seeOperation(needsReimbursement()?.operationId)}>Ver lançamento</Button>
                  </>
                }
              >
                <TableBox rows={view.reimbursements.length} cap={10}>
                  {(height) => (
                    <DataTable
                      label="Reembolsos"
                      search={{ text: (r) => `${r.description} ${r.payer}`, placeholder: "Buscar reembolso" }}
                      filters={[{ id: "open", label: "Só os pendentes", keep: (r) => r.open }]}
                      rows={view.reimbursements}
                      columns={REIMBURSEMENT_COLUMNS}
                      getRowId={(r) => r.id}
                      selectedId={reimbursement?.id ?? null}
                      onSelect={setPickedReimbursement}
                      rowMenu={reimbursementMenu}
                      rowMenuLabel={(r) => `Ações de ${r.description}`}
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
                actions={<EditButton onClick={() => openSettle()}>Registrar acerto…</EditButton>}
              >
                <TableBox rows={view.balances.length} cap={8}>
                  {(height) => (
                    <DataTable
                      label="Saldos entre integrantes"
                      search={{ text: (r) => `${r.debtor} ${r.creditor}`, placeholder: "Buscar integrante" }}
                      rows={view.balances}
                      columns={BALANCE_COLUMNS}
                      getRowId={(r) => r.id}
                      selectedId={balance?.id ?? null}
                      onSelect={(id) => {
                        setPickedBalance(id);
                        setPickedShare(null);
                      }}
                      rowMenu={balanceMenu}
                      rowMenuLabel={(r) => `Ações de ${r.debtor} deve a ${r.creditor}`}
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
                          rowMenu={(r) => [seeOperationEntry(r.id)]}
                          rowMenuLabel={(r) => `Ações de ${r.description}`}
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
                <Collapsible
                  title="Acertos registrados"
                  prefKey="acertos/historico"
                  description="Um acerto registrado por engano pode ser corrigido ou desfeito."
                  actions={
                    <>
                      <EditButton onClick={() => openFix()}>Corrigir acerto…</EditButton>
                      <EditButton onClick={() => void undoSettlement()}>Desfazer acerto…</EditButton>
                    </>
                  }
                >
                  <TableBox rows={view.settlements.length} cap={8}>
                    {(height) => (
                      <DataTable
                        label="Acertos registrados"
                        search={{ text: (r) => `${r.debtor} ${r.creditor} ${r.note}`, placeholder: "Buscar acerto" }}
                        rows={view.settlements}
                        columns={HISTORY_COLUMNS}
                        getRowId={(r) => r.id}
                        selectedId={settlement?.id ?? null}
                        onSelect={setPickedSettlement}
                        rowMenu={settlementMenu}
                        rowMenuLabel={(r) => `Ações do acerto de ${r.debtor} a ${r.creditor}`}
                        onActivate={(id) => {
                          setPickedSettlement(id);
                          if (!locked) openFix(view.settlements.find((s) => s.id === id) ?? null);
                        }}
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
        <EmptyState
          framed
          title="Nada a receber nem a acertar"
          description="Registre um reembolso a receber (Novo reembolso) ou rateie despesas entre integrantes no Livro financeiro para ver aqui quem deve a quem."
          actions={
            <>
              <EditButton onClick={() => openSettle(null)}>Registrar acerto…</EditButton>
              <Button variant="primary" onClick={() => goTo("livro")}>
                Abrir o Livro financeiro
              </Button>
            </>
          }
        />
      )}

      {receive ? (
        <SharingReceiveDialog
          key={`receive-${receiveSlot.key}`}
          open={receiveSlot.open}
          onClose={receiveSlot.close}
          reimbursementId={receive.id}
          onDone={() => notify("Reembolso recebido: a despesa líquida foi reduzida.")}
        />
      ) : null}
      {settle ? (
        <SharingSettleDialog
          key={`settle-${settleSlot.key}`}
          open={settleSlot.open}
          onClose={settleSlot.close}
          debtorId={settle.debtorId}
          creditorId={settle.creditorId}
          amount={settle.amount}
          settlementId={settle.settlementId ?? null}
          onDone={() => notify(settle.settlementId ? "Acerto corrigido." : "Acerto registrado.")}
        />
      ) : null}
      {requestSlot.spec ? (
        <ReimbursementDialog
          key={`request-${requestSlot.key}`}
          open={requestSlot.open}
          onClose={requestSlot.close}
          onDone={() => notify("Reembolso registrado: fica em Reembolsos até ser recebido.")}
        />
      ) : null}
      {deny ? (
        <OverviewReasonDialog
          key={`deny-${denySlot.key}`}
          open={denySlot.open}
          onOpenChange={(open) => !open && denySlot.close()}
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
