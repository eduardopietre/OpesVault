/**
 * The three plain lists of Contas e cartões (desktop `AccountsPage._list_tab`): Cartões, Categorias and
 * Integrantes. Each is a table with its commands above; a double click or Enter edits the row.
 */
import { AccountType, dom, type Id, type LedgerAccount } from "@opesvault/domain";
import { Button, Switch, confirm, notify, type MenuEntry } from "@opesvault/ui";
import { useState } from "react";
import { useAct, useLedger, useWorkspace } from "../../data/react.tsx";
import { useUndo } from "../../shell/undo.tsx";
import { plural } from "../../data/text.ts";
import { CardDialog } from "../../dialogs/accounts_card.tsx";
import { CategoryDialog, MergeCategoryDialog, RenameCategoryDialog } from "../../dialogs/accounts_category.tsx";
import { MemberDialog } from "../../dialogs/accounts_member.tsx";
import { DeductibleDialog } from "../../dialogs/deductible.tsx";
import { useGoTo } from "../../data/navigation.ts";
import { cardRows, categoryRows, memberRows, type CardRow, type CategoryRow, type MemberRow } from "./rows.ts";
import { type TabReveal, EditButton, Empty, ListTable, Toolbar, useTabReveal } from "../../components/list_parts.tsx";
import type { TierColumn } from "../../components/tier_columns.ts";
import { useDialog } from "../../data/dialog.ts";
import { cents, moneyOr } from "../../data/money.ts";
import { accountRef } from "../livro/rows.ts";
import { lockEntries, useLock } from "../../data/read_only.ts";

// ── cards ────────────────────────────────────────

const CARD_COLUMNS: TierColumn<CardRow>[] = [
  { id: "name", header: "Cartão", cell: (r) => r.name, sortValue: (r) => r.name, grow: 2, width: 160, tier: 1 },
  { id: "holder", header: "Portador", cell: (r) => r.holder, sortValue: (r) => r.holder, grow: 1, width: 120, tier: 2 },
  { id: "last4", header: "Final", cell: (r) => r.last4, sortValue: (r) => r.last4, width: 70, tier: 3 },
  {
    id: "closing",
    header: "Fechamento",
    cell: (r) => `dia ${r.closing}`,
    sortValue: (r) => r.closing,
    align: "end",
    width: 110,
    tier: 4,
  },
  {
    id: "due",
    header: "Vencimento",
    cell: (r) => `dia ${r.due}`,
    sortValue: (r) => r.due,
    align: "end",
    width: 100,
    tier: 1,
  },
  {
    id: "open",
    header: "Fatura em aberto",
    cell: (r) => moneyOr(r.open),
    sortValue: (r) => cents(r.open),
    align: "end",
    width: 140,
    tier: 1,
  },
];

export function CardsTab({ reveal }: { reveal?: TabReveal<Id> | null }) {
  const ledger = useWorkspace().ledger;
  const go = useGoTo();
  const { locked } = useLock();
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
  /** A card's context menu: editing it and its entries. */
  const rowMenu = (row: CardRow): MenuEntry[] =>
    lockEntries(
      [
        { id: "edit", label: "Editar…", onSelect: () => edit(row.id) },
        { kind: "separator", id: "s1" },
        {
          id: "entries",
          label: "Ver lançamentos",
          onSelect: () => go("livro", { ref: accountRef(ledger.cards.get(row.id)?.liability_account_id ?? "") }),
        },
      ],
      locked,
      ["entries"],
    );

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
            else go("livro", { ref: accountRef(ledger.cards.get(selected.id)?.liability_account_id ?? "") });
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
          rowMenu={rowMenu}
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

const CATEGORY_COLUMNS: TierColumn<CategoryRow>[] = [
  { id: "name", header: "Categoria", cell: (r) => r.name, sortValue: (r) => r.name, grow: 2, width: 180, tier: 1 },
  { id: "kind", header: "Tipo", cell: (r) => r.kind, sortValue: (r) => r.kind, width: 100, tier: 1 },
  {
    id: "parent",
    header: "Dentro de",
    cell: (r) => r.parent || "—",
    sortValue: (r) => r.parent,
    grow: 1,
    width: 140,
    tier: 3,
  },
  {
    id: "deductible",
    header: "Dedutível",
    cell: (r) => r.deductible || "—",
    sortValue: (r) => r.deductible,
    grow: 1,
    width: 160,
    tier: 2,
  },
  {
    id: "status",
    header: "Situação",
    cell: (r) => (r.archived ? "Arquivada" : "Ativa"),
    sortValue: (r) => (r.archived ? 1 : 0),
    width: 100,
    tier: 2,
  },
];

type CategoryDialogSpec =
  { kind: "new" } | { kind: "deductible"; id: Id } | { kind: "rename"; id: Id } | { kind: "merge"; id: Id };

export function CategoriesTab() {
  const workspace = useWorkspace();
  const ledger = workspace.ledger;
  const act = useAct();
  const { undo } = useUndo();
  const { locked } = useLock();
  const [withArchived, setWithArchived] = useState(false);
  const rows = useLedger((l) => categoryRows(l, withArchived), String(withArchived));
  const [pick, setPick] = useState<Id | null>(null);
  const dialog = useDialog<CategoryDialogSpec>();
  const selected = rows.find((r) => r.id === pick) ?? null;

  /** The category of the row (or of the selection), or a notice asking to select one. */
  const need = (id: Id | null): LedgerAccount | null => {
    const found = id === null ? undefined : ledger.accounts.get(id);
    if (found === undefined) notify("Selecione uma categoria.");
    return found ?? null;
  };

  const markDeductible = (id: Id | null = pick) => {
    const category = need(id);
    if (category === null) return;
    if (category.type !== AccountType.EXPENSE) {
      notify("Só categorias de despesa podem ser dedutíveis.");
      return;
    }
    dialog.show({ kind: "deductible", id: category.id });
  };

  const rename = (id: Id | null = pick) => {
    const category = need(id);
    if (category) dialog.show({ kind: "rename", id: category.id });
  };

  const merge = (id: Id | null = pick) => {
    const category = need(id);
    if (category === null) return;
    if (category.archived) {
      notify("Reative a categoria antes de mesclá-la.");
      return;
    }
    dialog.show({ kind: "merge", id: category.id });
  };

  /** Archiving hides a category from the choices; its entries and reports stay. Reversible, so no question. */
  const toggleArchived = (id: Id | null = pick) => {
    const category = need(id);
    if (category === null) return;
    const archiving = !category.archived;
    const done = act((l) => dom.categories.setArchived(l, category.id, archiving), {
      label: archiving ? "arquivar categoria" : "reativar categoria",
    });
    if (done === undefined) return;
    if (archiving && !withArchived) setPick(null);
    notify(archiving ? `Categoria “${category.name}” arquivada.` : `Categoria “${category.name}” reativada.`, {
      action: { label: "Desfazer", run: undo },
    });
  };

  /** The merge, once a target is chosen: asks first, saying how many entries move, then one undo step. */
  const runMerge = async (sourceId: Id, targetId: Id) => {
    const source = ledger.account(sourceId);
    const target = ledger.account(targetId);
    const { operations } = dom.categories.previewMerge(ledger, sourceId, targetId);
    const ok = await confirm({
      title: `Mesclar “${source.name}” em “${target.name}”?`,
      text: `${operations ? `${plural(operations, "lançamento passa", "lançamentos passam")} para “${target.name}”` : "Nenhum lançamento a mover"}, com subcategorias, orçamentos, recorrências e regras. “${source.name}” fica arquivada. Dá para desfazer logo em seguida.`,
      confirmLabel: "Mesclar",
      danger: true,
    });
    if (!ok) return;
    const result = act((l) => dom.categories.mergeCategories(l, sourceId, targetId), {
      label: "mesclar categorias",
    });
    if (result === undefined) return;
    setPick(targetId);
    notify(
      `“${source.name}” mesclada em “${target.name}”: ${plural(result.operations, "lançamento movido", "lançamentos movidos")}.`,
      { action: { label: "Desfazer", run: undo } },
    );
  };

  /** A category's commands: rename it, mark it deductible (expense only); merging and archiving last. */
  const rowMenu = (row: CategoryRow): MenuEntry[] =>
    lockEntries(
      [
        { id: "rename", label: "Renomear…", onSelect: () => rename(row.id) },
        ...(ledger.accounts.get(row.id)?.type === AccountType.EXPENSE
          ? [{ id: "deductible", label: "Dedutível no IR…", onSelect: () => markDeductible(row.id) }]
          : []),
        { kind: "separator" as const, id: "s1" },
        { id: "archive", label: row.archived ? "Reativar" : "Arquivar", onSelect: () => toggleArchived(row.id) },
        ...(row.archived
          ? []
          : [{ id: "merge", label: "Mesclar com outra…", danger: true, onSelect: () => merge(row.id) }]),
      ],
      locked,
    );

  return (
    <div className="flex flex-col gap-4">
      <Toolbar label="Comandos das categorias">
        <EditButton variant="primary" onClick={() => dialog.show({ kind: "new" })}>
          Nova categoria…
        </EditButton>
        <EditButton onClick={() => rename()}>Renomear…</EditButton>
        <EditButton onClick={() => markDeductible()}>Dedutível no IR…</EditButton>
        <EditButton onClick={() => toggleArchived()}>
          {selected ? (selected.archived ? "Reativar" : "Arquivar") : "Arquivar ou reativar"}
        </EditButton>
        <EditButton onClick={() => merge()}>Mesclar…</EditButton>
        <Switch label="Mostrar arquivadas" checked={withArchived} onCheckedChange={setWithArchived} />
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
          rowMenu={rowMenu}
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
      {dialog.spec?.kind === "rename" && ledger.accounts.has(dialog.spec.id) ? (
        <RenameCategoryDialog
          key={dialog.key}
          open={dialog.open}
          onClose={dialog.close}
          category={ledger.account(dialog.spec.id)}
          onDone={(category) => notify(`Categoria renomeada para “${category.name}”.`)}
        />
      ) : null}
      {dialog.spec?.kind === "merge" && ledger.accounts.has(dialog.spec.id) ? (
        <MergeCategoryDialog
          key={dialog.key}
          open={dialog.open}
          onClose={dialog.close}
          category={ledger.account(dialog.spec.id)}
          onChoose={(targetId) => {
            const sourceId = dialog.spec?.kind === "merge" ? dialog.spec.id : null;
            if (sourceId !== null) void runMerge(sourceId, targetId);
          }}
        />
      ) : null}
    </div>
  );
}

// ── members ──────────────────────────────────────

const MEMBER_COLUMNS: TierColumn<MemberRow>[] = [
  { id: "name", header: "Integrante", cell: (r) => r.name, sortValue: (r) => r.name, grow: 2, width: 180, tier: 1 },
  { id: "role", header: "Papel", cell: (r) => r.role, sortValue: (r) => r.role, width: 130, tier: 1 },
  { id: "status", header: "Situação", cell: (r) => r.status, sortValue: (r) => r.status, width: 110, tier: 1 },
];

export function MembersTab() {
  const ledger = useWorkspace().ledger;
  const { locked } = useLock();
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
  /** A member's context menu: editing them. */
  const rowMenu = (row: MemberRow): MenuEntry[] =>
    lockEntries([{ id: "edit", label: "Editar…", onSelect: () => edit(row.id) }], locked);

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
          rowMenu={rowMenu}
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
