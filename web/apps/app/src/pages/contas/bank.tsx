/**
 * Contas bancárias (desktop `accounts/bank.py`): each bank account with its holders, its parts (checking,
 * savings) and the investments held there; the composition of the selected one, values on a date and the
 * investments' characteristics. One holder or two (a joint account), kept through `dom.banking`.
 */
import { confirm, Collapsible, MenuButton, notify } from "@opesvault/ui";
import { dom, type Id } from "@opesvault/domain";
import { useState } from "react";
import { useAct, useLedger, useWorkspace } from "../../data/react.tsx";
import { BankAccountDialog } from "../../dialogs/bank_account.tsx";
import { InvestmentDialog } from "../../dialogs/bank_investment.tsx";
import { ValuesDialog } from "../../dialogs/bank_values.tsx";
import { useUndo } from "../../shell/undo.tsx";
import { type TabReveal, EditButton, Empty, ListTable, Toolbar, useTabReveal } from "../../components/list_parts.tsx";
import type { TierColumn } from "../../components/tier_columns.ts";
import { bankRows, partRows, whereLine, type BankRow, type PartRow } from "./rows.ts";
import { useDialog } from "../../data/dialog.ts";
import { useLock } from "../../data/read_only.ts";

const { banking } = dom;

const COLUMNS: TierColumn<BankRow>[] = [
  { id: "name", header: "Conta", cell: (r) => r.name, sortValue: (r) => r.name, grow: 2, width: 130, tier: 1 },
  { id: "bank", header: "Banco", cell: (r) => r.bank, sortValue: (r) => r.bank, grow: 2, width: 140, tier: 1 },
  { id: "branch", header: "Agência", cell: (r) => r.branch, width: 72, tier: 5 },
  { id: "number", header: "Conta nº", cell: (r) => r.number, width: 110, tier: 5 },
  {
    id: "holders",
    header: "Titulares",
    cell: (r) => r.holders,
    sortValue: (r) => r.holders,
    grow: 2,
    width: 190,
    tier: 2,
  },
  { id: "checking", header: "Corrente", cell: (r) => r.checking, align: "end", width: 120, tier: 3 },
  { id: "savings", header: "Poupança", cell: (r) => r.savings, align: "end", width: 110, tier: 4 },
  { id: "investments", header: "Investimentos", cell: (r) => r.investments, align: "end", width: 125, tier: 3 },
  {
    id: "total",
    header: "Total",
    cell: (r) => r.total,
    sortValue: (r) => r.totalCents,
    align: "end",
    width: 125,
    tier: 1,
  },
];

const PART_COLUMNS: TierColumn<PartRow>[] = [
  { id: "label", header: "Item", cell: (r) => r.label, grow: 2, width: 150, tier: 1 },
  { id: "irpf", header: "Tipo no IRPF", cell: (r) => r.irpf, grow: 2, width: 200, tier: 5 },
  { id: "yield", header: "Rentabilidade", cell: (r) => r.yield, grow: 1, width: 125, tier: 2 },
  { id: "maturity", header: "Vencimento", cell: (r) => r.maturity, width: 110, tier: 3 },
  { id: "tax", header: "Tributação", cell: (r) => r.tax, grow: 1, width: 140, tier: 5 },
  { id: "today", header: "Valor hoje", cell: (r) => r.today, align: "end", width: 125, tier: 1 },
  {
    id: "lastBank",
    header: "Último valor do banco",
    cell: (r) => r.lastBank,
    align: "end",
    grow: 1,
    width: 235,
    tier: 4,
  },
];

type Spec =
  | { kind: "bank"; id: Id | null }
  | { kind: "values"; id: Id }
  | { kind: "investment"; bankId: Id | null; positionId: Id | null };

/** A link to this tab: a bank account to select, or the new investment form (Investimentos' empty page). */
export interface BankReveal {
  bankId: Id | null;
  newInvestment: boolean;
}

export function BankTab({ reveal }: { reveal?: TabReveal<BankReveal> | null }) {
  const workspace = useWorkspace();
  const ledger = workspace.ledger;
  const today = workspace.today();
  const { undo } = useUndo();
  const { locked } = useLock();
  const act = useAct();
  const rows = useLedger((l) => bankRows(l, today), today);
  const [pick, setPick] = useState<Id | null>(null);
  const [part, setPart] = useState<Id | null>(null);
  const dialog = useDialog<Spec>();
  const selected = rows.find((r) => r.id === pick) ?? rows[0] ?? null;
  const item = selected ? (banking.bankAccounts(ledger).get(selected.id) ?? null) : null;
  const parts = useLedger(
    (l) => (selected ? partRows(l, banking.bankAccounts(l).get(selected.id)!, today) : []),
    `${selected?.id ?? ""}|${today}`,
  );
  const chosenPart = parts.find((p) => p.id === part) ?? null;

  const add = () => {
    if (ledger.members.size === 0) {
      notify("Cadastre o titular na aba Integrantes antes.");
      return;
    }
    dialog.show({ kind: "bank", id: null });
  };

  useTabReveal(reveal, ({ bankId, newInvestment }) => {
    if (bankId) setPick(bankId);
    if (!newInvestment || locked) return;
    // The investment is held at a bank account: without one, that comes first.
    const at = bankId ?? selected?.id ?? null;
    if (at === null) {
      if (ledger.members.size === 0) {
        notify("Cadastre o titular na aba Integrantes; depois, a conta bancária e o investimento.");
        return;
      }
      notify("Cadastre primeiro a conta bancária onde o investimento fica; depois, use Novo investimento….");
      dialog.show({ kind: "bank", id: null });
      return;
    }
    dialog.show({ kind: "investment", bankId: at, positionId: null });
  });
  const edit = (id: Id | null = item?.id ?? null) => {
    if (id === null) {
      notify("Selecione uma conta bancária.");
      return;
    }
    dialog.show({ kind: "bank", id });
  };
  const recordValues = () => {
    if (!item) {
      notify("Escolha a conta bancária.");
      return;
    }
    if (banking.valuesAt(ledger, item.id, today).length === 0) {
      notify("Esta conta não tem corrente, poupança nem investimentos ainda.");
      return;
    }
    dialog.show({ kind: "values", id: item.id });
  };
  const editInvestment = (id: Id | null = chosenPart?.kind === "investment" ? chosenPart.id : null) => {
    const found = parts.find((p) => p.id === id);
    if (!found || found.kind !== "investment") {
      notify("Escolha um investimento na composição.");
      return;
    }
    dialog.show({ kind: "investment", bankId: null, positionId: found.id });
  };
  const archive = async () => {
    if (!item) {
      notify("Selecione uma conta bancária.");
      return;
    }
    const ok = await confirm({
      title: "Encerrar esta conta bancária?",
      text: "Ela sai da lista; as contas e os lançamentos continuam no livro e podem ser arquivados em Contas.",
      confirmLabel: "Encerrar",
      danger: true,
    });
    if (!ok) return;
    act((l) => banking.archive(l, item.id), { label: "encerrar conta bancária" });
    setPick(null);
    notify("Conta bancária encerrada.", { action: { label: "Desfazer", run: undo } });
  };

  return (
    <div className="flex flex-col gap-4">
      <Toolbar label="Comandos das contas bancárias">
        <EditButton variant="primary" onClick={add}>
          Nova conta bancária…
        </EditButton>
        <EditButton onClick={() => edit()}>Editar…</EditButton>
        <EditButton onClick={recordValues}>Valores em uma data…</EditButton>
        <EditButton onClick={() => dialog.show({ kind: "investment", bankId: item?.id ?? null, positionId: null })}>
          Novo investimento…
        </EditButton>
        <MenuButton
          label="Mais"
          items={[
            { id: "archive", label: "Encerrar conta bancária…", onSelect: () => void archive(), disabled: locked },
          ]}
        />
      </Toolbar>

      {rows.length ? (
        <>
          <ListTable
            label="Contas bancárias"
            rows={rows}
            columns={COLUMNS}
            getRowId={(r) => r.id}
            selectedId={selected?.id ?? null}
            onSelect={(id) => {
              setPick(id);
              setPart(null);
            }}
            onActivate={(id) => edit(id)}
          />
          {item ? (
            <Collapsible
              title="Composição"
              prefKey="contas/bancarias_composicao"
              description={whereLine(ledger, item)}
              actions={
                <EditButton variant="ghost" size="sm" onClick={() => editInvestment()}>
                  Características…
                </EditButton>
              }
            >
              {parts.length ? (
                <ListTable
                  label="Composição da conta bancária"
                  rows={parts}
                  columns={PART_COLUMNS}
                  getRowId={(r) => r.id}
                  selectedId={chosenPart?.id ?? null}
                  onSelect={setPart}
                  onActivate={(id) => editInvestment(id)}
                  max={12}
                />
              ) : (
                <p className="rounded-lg border border-dashed border-separator-strong px-4 py-6 text-center text-body text-secondary">
                  Esta conta ainda não tem corrente, poupança nem investimentos. Edite a conta para incluir as partes ou
                  use Novo investimento.
                </p>
              )}
            </Collapsible>
          ) : null}
        </>
      ) : (
        <Empty title="Nenhuma conta bancária">
          Cadastre banco, agência, conta e titulares; a conta pode ter corrente, poupança e investimentos, em qualquer
          combinação.
        </Empty>
      )}

      {dialog.spec?.kind === "bank" ? (
        <BankAccountDialog
          key={dialog.key}
          open={dialog.open}
          onClose={dialog.close}
          {...(dialog.spec.id ? { item: banking.bankAccounts(ledger).get(dialog.spec.id)! } : {})}
          onDone={(saved, created) => {
            setPick(saved.id);
            notify(created ? "Conta bancária cadastrada." : "Conta bancária salva.");
          }}
        />
      ) : null}
      {dialog.spec?.kind === "values" ? (
        <ValuesDialog
          key={dialog.key}
          open={dialog.open}
          onClose={dialog.close}
          bankId={dialog.spec.id}
          onDone={() => notify("Valores registrados.")}
        />
      ) : null}
      {dialog.spec?.kind === "investment" ? (
        <InvestmentDialog
          key={dialog.key}
          open={dialog.open}
          onClose={dialog.close}
          bankId={dialog.spec.bankId}
          positionId={dialog.spec.positionId}
          onDone={(profile, created) => {
            setPart(profile.position_id);
            notify(created ? "Investimento cadastrado." : "Características salvas.");
          }}
        />
      ) : null}
    </div>
  );
}
