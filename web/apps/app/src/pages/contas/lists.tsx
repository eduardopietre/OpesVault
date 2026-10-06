/**
 * The three plain lists of Contas e cartões (desktop `AccountsPage._list_tab`): Cartões, Categorias and
 * Integrantes. Each is a table with its commands above; a double click or Enter edits the row.
 */
import { AccountType, type Id } from "@opesvault/domain";
import { Button, type DataColumn, notify } from "@opesvault/ui";
import { useState } from "react";
import { useLedger, useWorkspace } from "../../data/react.tsx";
import { CardDialog } from "../../dialogs/accounts_card.tsx";
import { CategoryDialog } from "../../dialogs/accounts_category.tsx";
import { MemberDialog } from "../../dialogs/accounts_member.tsx";
import { DeductibleDialog } from "../../dialogs/deductible.tsx";
import { useGoTo } from "../../data/navigation.ts";
import {
  cardRows,
  categoryRows,
  cents,
  memberRows,
  money,
  type CardRow,
  type CategoryRow,
  type MemberRow,
} from "./rows.ts";
import { type TabReveal, EditButton, Empty, ListTable, Toolbar, useDialog, useTabReveal } from "./parts.tsx";

// ── cards ────────────────────────────────────────

const CARD_COLUMNS: DataColumn<CardRow>[] = [
  { id: "name", header: "Cartão", cell: (r) => r.name, sortValue: (r) => r.name, grow: 2, width: 160 },
  { id: "holder", header: "Portador", cell: (r) => r.holder, sortValue: (r) => r.holder, grow: 1, width: 120 },
  { id: "last4", header: "Final", cell: (r) => r.last4, sortValue: (r) => r.last4, width: 80 },
  {
    id: "closing",
    header: "Fechamento",
    cell: (r) => `dia ${r.closing}`,
    sortValue: (r) => r.closing,
    align: "end",
    width: 110,
    priority: 2,
  },
  {
    id: "due",
    header: "Vencimento",
    cell: (r) => `dia ${r.due}`,
    sortValue: (r) => r.due,
    align: "end",
    width: 110,
  },
  {
    id: "open",
    header: "Fatura em aberto",
    cell: (r) => money(r.open),
    sortValue: (r) => cents(r.open),
    align: "end",
    width: 150,
  },
];

export function CardsTab({ reveal }: { reveal?: TabReveal<Id> | null }) {
  const ledger = useWorkspace().ledger;
  const go = useGoTo();
  const rows = useLedger(cardRows);
  const [pick, setPick] = useState<Id | null>(null);
  const dialog = useDialog<{ id: Id | null }>();
  useTabReveal(reveal, setPick);
  const selected = rows.find((r) => r.id === pick) ?? null;

  const edit = (id: Id | null = pick) => {
    if (id === null || !ledger.cards.has(id)) {
      notify("Selecione um cartão.");
      return;
    }
    dialog.show({ id });
  };

  return (
    <div className="flex flex-col gap-4">
      <Toolbar label="Comandos dos cartões">
        <EditButton variant="primary" onClick={() => dialog.show({ id: null })}>
          Novo cartão…
        </EditButton>
        <EditButton onClick={() => edit()}>Editar…</EditButton>
        <Button
          onClick={() => {
            if (!selected) notify("Selecione um cartão.");
            else go("livro", { ref: `conta:${ledger.cards.get(selected.id)?.liability_account_id ?? ""}` });
          }}
        >
          Ver lançamentos
        </Button>
      </Toolbar>
      {rows.length ? (
        <ListTable
          label="Cartões"
          rows={rows}
          columns={CARD_COLUMNS}
          getRowId={(r) => r.id}
          selectedId={selected?.id ?? null}
          onSelect={setPick}
          onActivate={(id) => edit(id)}
        />
      ) : (
        <Empty title="Nenhum cartão">
          Cadastre o cartão com os dias de fechamento e vencimento: as compras entram na fatura certa e o pagamento é
          feito na aba Faturas.
        </Empty>
      )}
      {dialog.spec ? (
        <CardDialog
          key={dialog.key}
          open={dialog.open}
          onClose={dialog.close}
          {...(dialog.spec.id ? { card: ledger.cards.get(dialog.spec.id)! } : {})}
          onDone={(card, created) => {
            setPick(card.id);
            notify(created ? "Cartão cadastrado." : "Cartão salvo.");
          }}
        />
      ) : null}
    </div>
  );
}

// ── categories ───────────────────────────────────

const CATEGORY_COLUMNS: DataColumn<CategoryRow>[] = [
  { id: "name", header: "Categoria", cell: (r) => r.name, sortValue: (r) => r.name, grow: 2, width: 180 },
  { id: "kind", header: "Tipo", cell: (r) => r.kind, sortValue: (r) => r.kind, width: 100 },
  {
    id: "parent",
    header: "Dentro de",
    cell: (r) => r.parent,
    sortValue: (r) => r.parent,
    grow: 1,
    width: 140,
  },
  {
    id: "deductible",
    header: "Dedutível",
    cell: (r) => r.deductible,
    sortValue: (r) => r.deductible,
    grow: 1,
    width: 160,
  },
];

export function CategoriesTab() {
  const ledger = useWorkspace().ledger;
  const rows = useLedger(categoryRows);
  const [pick, setPick] = useState<Id | null>(null);
  const dialog = useDialog<{ kind: "new" } | { kind: "deductible"; id: Id }>();
  const selected = rows.find((r) => r.id === pick) ?? null;

  const markDeductible = (id: Id | null = pick) => {
    if (id === null || !ledger.accounts.has(id)) {
      notify("Selecione uma categoria.");
      return;
    }
    if (ledger.account(id).type !== AccountType.EXPENSE) {
      notify("Só categorias de despesa podem ser dedutíveis.");
      return;
    }
    dialog.show({ kind: "deductible", id });
  };

  return (
    <div className="flex flex-col gap-4">
      <Toolbar label="Comandos das categorias">
        <EditButton variant="primary" onClick={() => dialog.show({ kind: "new" })}>
          Nova categoria…
        </EditButton>
        <EditButton onClick={() => markDeductible()}>Dedutível no IR…</EditButton>
      </Toolbar>
      {rows.length ? (
        <ListTable
          label="Categorias"
          rows={rows}
          columns={CATEGORY_COLUMNS}
          getRowId={(r) => r.id}
          selectedId={selected?.id ?? null}
          onSelect={setPick}
          onActivate={(id) => markDeductible(id)}
          max={14}
        />
      ) : (
        <Empty title="Nenhuma categoria">Categorias de receita e de despesa classificam os lançamentos.</Empty>
      )}
      {dialog.spec?.kind === "new" ? (
        <CategoryDialog
          key={dialog.key}
          open={dialog.open}
          onClose={dialog.close}
          onDone={(category) => {
            setPick(category.id);
            notify("Categoria criada.");
          }}
        />
      ) : null}
      {dialog.spec?.kind === "deductible" ? (
        <DeductibleDialog
          key={dialog.key}
          open={dialog.open}
          onClose={dialog.close}
          categoryId={dialog.spec.id}
          onDone={(kind) => notify(kind ? "Categoria marcada como dedutível." : "A categoria deixou de ser dedutível.")}
        />
      ) : null}
    </div>
  );
}

// ── members ──────────────────────────────────────

const MEMBER_COLUMNS: DataColumn<MemberRow>[] = [
  { id: "name", header: "Integrante", cell: (r) => r.name, sortValue: (r) => r.name, grow: 2, width: 180 },
  { id: "role", header: "Papel", cell: (r) => r.role, sortValue: (r) => r.role, width: 130 },
  { id: "status", header: "Situação", cell: (r) => r.status, sortValue: (r) => r.status, width: 110 },
];

export function MembersTab() {
  const ledger = useWorkspace().ledger;
  const rows = useLedger(memberRows);
  const [pick, setPick] = useState<Id | null>(null);
  const dialog = useDialog<{ id: Id | null }>();
  const selected = rows.find((r) => r.id === pick) ?? null;

  const edit = (id: Id | null = pick) => {
    if (id === null || !ledger.members.has(id)) {
      notify("Selecione um integrante.");
      return;
    }
    dialog.show({ id });
  };

  return (
    <div className="flex flex-col gap-4">
      <Toolbar label="Comandos dos integrantes">
        <EditButton variant="primary" onClick={() => dialog.show({ id: null })}>
          Novo integrante…
        </EditButton>
        <EditButton onClick={() => edit()}>Editar…</EditButton>
      </Toolbar>
      {rows.length ? (
        <ListTable
          label="Integrantes"
          rows={rows}
          columns={MEMBER_COLUMNS}
          getRowId={(r) => r.id}
          selectedId={selected?.id ?? null}
          onSelect={setPick}
          onActivate={(id) => edit(id)}
        />
      ) : (
        <Empty title="Nenhum integrante">
          Cadastre quem participa das finanças do projeto: titulares e dependentes.
        </Empty>
      )}
      {dialog.spec ? (
        <MemberDialog
          key={dialog.key}
          open={dialog.open}
          onClose={dialog.close}
          {...(dialog.spec.id ? { member: ledger.members.get(dialog.spec.id)! } : {})}
          onDone={(member, created) => {
            setPick(member.id);
            notify(created ? "Integrante adicionado." : "Integrante salvo.");
          }}
        />
      ) : null}
    </div>
  );
}
