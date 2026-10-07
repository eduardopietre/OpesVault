/**
 * Todas as contas (desktop `accounts/ledger_accounts.py`): every account and card liability with its balance,
 * then the selected account's balance over the months and its checks against the bank statement. A check is
 * the balance the bank shows on a date; a difference is shown, never adjusted by itself.
 */
import { charts, dom, ymAdd, ymOf, type Id } from "@opesvault/domain";
import { Button, ChartPanel, Collapsible, notify } from "@opesvault/ui";
import { useState } from "react";
import { useGoTo } from "../../data/navigation.ts";
import { useLedger, useWorkspace } from "../../data/react.tsx";
import { AccountDialog } from "../../dialogs/accounts_account.tsx";
import { BalanceCheckDialog } from "../../dialogs/balance_check.tsx";
import { toChartData } from "../../data/chart_data.ts";
import {
  type TabReveal,
  EditButton,
  Empty,
  ListTable,
  Toolbar,
  Warn,
  useTabReveal,
} from "../../components/list_parts.tsx";
import type { TierColumn } from "../../components/tier_columns.ts";
import { accountRows, checkRows, type AccountRow, type CheckRow } from "./rows.ts";
import { useDialog } from "../../data/dialog.ts";
import { cents, moneyOr } from "../../data/money.ts";
import { accountRef } from "../livro/rows.ts";

const HISTORY_MONTHS = 12;

const CHECKS_NOTE =
  "Saldo informado a partir do extrato, comparado ao saldo do aplicativo na mesma data. Uma diferença indica lançamento faltando ou errado; nada é ajustado sozinho.";

export interface AccountReveal {
  accountId: Id;
  /** Also open the checks (a balance that differs from the bank). */
  checks: boolean;
}

const COLUMNS: TierColumn<AccountRow>[] = [
  { id: "name", header: "Conta", cell: (r) => r.name, sortValue: (r) => r.name, grow: 2, width: 150, tier: 1 },
  { id: "type", header: "Tipo", cell: (r) => r.type, sortValue: (r) => r.type, grow: 1, width: 130, tier: 2 },
  {
    id: "institution",
    header: "Instituição",
    cell: (r) => r.institution || "—",
    sortValue: (r) => r.institution,
    grow: 1,
    width: 130,
    tier: 4,
  },
  {
    id: "holders",
    header: "Titulares",
    cell: (r) => r.holders || "—",
    sortValue: (r) => r.holders,
    grow: 1,
    width: 120,
    tier: 3,
  },
  {
    id: "balance",
    header: "Saldo",
    cell: (r) => moneyOr(r.balance),
    sortValue: (r) => cents(r.balance),
    align: "end",
    width: 125,
    tier: 1,
  },
  {
    id: "checked",
    header: "Conferido com o banco",
    cell: (r) => (r.diverges ? <Warn>{r.checked}</Warn> : r.checked),
    sortValue: (r) => r.checked,
    grow: 2,
    width: 270,
    tier: 1,
  },
];

const CHECK_COLUMNS: TierColumn<CheckRow>[] = [
  { id: "on", header: "Data", cell: (r) => r.on, width: 110, tier: 1 },
  { id: "bank", header: "Banco", cell: (r) => r.bank, align: "end", width: 110, tier: 1 },
  { id: "app", header: "Aplicativo", cell: (r) => r.app, align: "end", width: 110, tier: 1 },
  {
    id: "difference",
    header: "Diferença",
    cell: (r) => (r.matches ? r.difference : <Warn>{r.difference}</Warn>),
    align: "end",
    width: 130,
    tier: 1,
  },
  { id: "note", header: "Observação", cell: (r) => r.note, grow: 2, width: 160, tier: 2 },
];

export function AccountsTab({ reveal }: { reveal?: TabReveal<AccountReveal> | null }) {
  const workspace = useWorkspace();
  const go = useGoTo();
  const today = workspace.today();
  const rows = useLedger(accountRows);
  const [pick, setPick] = useState<Id | null>(null);
  const [checksOpen, setChecksOpen] = useState(true);
  const dialog = useDialog<{ kind: "account"; id: Id | null } | { kind: "check"; id: Id }>();
  const selected = rows.find((r) => r.id === pick) ?? rows[0] ?? null;
  const selectedId = selected?.id ?? null;

  useTabReveal(reveal, (value) => {
    setPick(value.accountId);
    if (value.checks) setChecksOpen(true);
  });

  const history = useLedger(
    (ledger) => {
      if (selectedId === null || !ledger.accounts.has(selectedId)) return null;
      const end = ymOf(today);
      return toChartData(charts.data.accountBalanceHistory(ledger, selectedId, ymAdd(end, -(HISTORY_MONTHS - 1)), end));
    },
    `${selectedId ?? ""}|${today}`,
  );
  const checks = useLedger((ledger) => (selectedId === null ? [] : checkRows(ledger, selectedId)), selectedId ?? "");

  const needsAccount = (): Id | null => {
    if (selectedId === null) {
      notify("Selecione uma conta.");
      return null;
    }
    return selectedId;
  };

  return (
    <div className="flex flex-col gap-4">
      <Toolbar label="Comandos das contas">
        <EditButton variant="primary" onClick={() => dialog.show({ kind: "account", id: null })}>
          Nova conta…
        </EditButton>
        <EditButton
          onClick={() => {
            const id = needsAccount();
            if (id) dialog.show({ kind: "account", id });
          }}
        >
          Editar…
        </EditButton>
        <EditButton
          onClick={() => {
            const id = needsAccount();
            if (id) dialog.show({ kind: "check", id });
          }}
        >
          Conferir saldo…
        </EditButton>
        <Button
          onClick={() => {
            const id = needsAccount();
            if (id) go("livro", { ref: accountRef(id) });
          }}
        >
          Ver lançamentos
        </Button>
      </Toolbar>

      {rows.length ? (
        <ListTable
          label="Contas"
          rows={rows}
          columns={COLUMNS}
          getRowId={(r) => r.id}
          selectedId={selectedId}
          onSelect={setPick}
          onActivate={(id) => {
            setPick(id);
            dialog.show({ kind: "account", id });
          }}
        />
      ) : (
        <Empty title="Nenhuma conta">
          Cadastre as contas de dinheiro, de investimento e as dívidas: o saldo de cada uma vem dos lançamentos.
        </Empty>
      )}

      {selected && history ? (
        <>
          <ChartPanel chart={history} prefKey="contas/saldo" height={240} />
          <Collapsible
            title="Conferências com o banco"
            open={checksOpen}
            onOpenChange={setChecksOpen}
            description={CHECKS_NOTE}
          >
            {checks.length ? (
              <ListTable
                label="Conferências com o banco"
                rows={checks}
                columns={CHECK_COLUMNS}
                getRowId={(r) => r.id}
                max={6}
                cardTitle={(r) => r.on}
              />
            ) : (
              <p className="rounded-lg border border-dashed border-separator-strong px-4 py-6 text-center text-body text-secondary">
                Nenhuma conferência ainda. Use “Conferir saldo…” com o saldo que o banco mostra.
              </p>
            )}
          </Collapsible>
        </>
      ) : null}

      {dialog.spec?.kind === "account" ? (
        <AccountDialog
          key={dialog.key}
          open={dialog.open}
          onClose={dialog.close}
          {...(dialog.spec.id ? { account: workspace.ledger.account(dialog.spec.id) } : {})}
          onDone={(account, created) => {
            setPick(account.id);
            notify(created ? "Conta cadastrada." : "Conta salva.");
          }}
        />
      ) : null}
      {dialog.spec?.kind === "check" ? (
        <BalanceCheckDialog
          key={dialog.key}
          open={dialog.open}
          onClose={dialog.close}
          accountId={dialog.spec.id}
          onDone={(check) => {
            const found = dom.balanceChecks
              .results(workspace.ledger, check.account_id)
              .find((r) => r.check.id === check.id);
            if (found?.matches) notify("Saldo conferido: confere com o banco.");
            else if (found) {
              notify(`Saldo conferido: diferença de ${moneyOr(found.difference)}. Procure o lançamento.`, {
                tone: "warning",
              });
            }
            setChecksOpen(true);
          }}
        />
      ) : null}
    </div>
  );
}
