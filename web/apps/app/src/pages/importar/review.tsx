/**
 * The conference of one document (desktop `ui/pages/imports/review.py` and the middle pane of `page.py`): what
 * the document says (facts, the check of each total, warnings), the account or card it belongs to, the layout
 * when none was recognized, and the items it was read into, each with the category the family would give it.
 * Extracted data is not approved data (docs/00 §4.1): nothing becomes an operation until the person approves it,
 * item by item or the ready ones together, with a reason when the approval is partial or the total diverges.
 * Every command that changes the project is one `act()`: one undo step.
 */
import { AccountSubtype, DomainError, importing, type Id } from "@opesvault/domain";
import {
  Badge,
  Button,
  DataTable,
  ElidedText,
  MenuButton,
  Select,
  notify,
  useElementWidth,
  useMotionPreset,
  type DataColumn,
  type MenuEntry,
  type SelectOption,
} from "@opesvault/ui";
import { AnimatePresence, motion } from "motion/react";
import { Check, ExternalLink, FileSearch, Pencil, ScanSearch, Sparkles, TriangleAlert } from "lucide-react";
import { useCallback, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useGoTo } from "../../data/navigation.ts";
import { useLedger, useWorkspace } from "../../data/react.tsx";
import { liquidAccounts } from "../../dialogs/account_choices.ts";
import { ImportItemDialog } from "../../dialogs/import_item.tsx";
import { RuleDialog } from "../../dialogs/rule_dialog.tsx";
import { useUndo } from "../../shell/undo.tsx";
import type { ImportAi } from "./ai.tsx";
import { actionName } from "../../data/action_names.ts";
import { useReasonPrompt } from "./prompts.tsx";
import type { ImportQueue } from "./queue.tsx";
import {
  DEFAULT_TARGET,
  day,
  factsLine,
  isOpen,
  itemRows,
  money,
  needsLayout,
  targetOptions,
  verdicts,
  type ItemRow,
} from "./rows.ts";

const { BatchStatus, ItemKind, ItemStatus } = importing.importModel;

/** Below this width the items are cards: the columns that always show need about 550 px. */
const CARDS_BELOW = 560;
const NO_SELECTION = "Selecione um item da lista.";
const READ_ONLY = "Outra aba ou aparelho está editando este projeto; aqui só leitura.";

const STATUS_TONE: Record<string, "neutral" | "accent" | "positive" | "negative" | "warning"> = {
  [ItemStatus.NEEDS_REVIEW]: "warning",
  [ItemStatus.READY]: "accent",
  [ItemStatus.APPROVED]: "positive",
  [ItemStatus.REJECTED]: "neutral",
  [ItemStatus.DUPLICATE]: "neutral",
};

export interface ReviewProps {
  batchId: Id;
  selected: Id | null;
  onSelect: (id: Id | null) => void;
  queue: ImportQueue;
  ai: ImportAi;
}

interface RuleOffer {
  itemId: Id;
  category: string;
  pattern: string;
}

export function Review({ batchId, selected, onSelect, queue, ai }: ReviewProps) {
  const workspace = useWorkspace();
  const goTo = useGoTo();
  const { undo } = useUndo();
  const preset = useMotionPreset();
  const readOnly = workspace.readOnly;
  const prompts = useReasonPrompt();
  const table = useRef<HTMLDivElement | null>(null);
  const [measure, tableWidth] = useElementWidth<HTMLDivElement>();
  const attachTable = useCallback(
    (node: HTMLDivElement | null) => {
      table.current = node;
      measure(node);
    },
    [measure],
  );
  // A card list (a narrow room) cannot hold controls inside its cards: the category of the selected item is
  // chosen in a strip above the list instead of in each card.
  const cards = tableWidth > 0 && tableWidth < CARDS_BELOW;

  const batch = useLedger((ledger) => importing.pipeline.batches(ledger).get(batchId) ?? null, batchId);
  const rows = useLedger((ledger) => itemRows(ledger, batchId), batchId);
  const optionsByKind = useLedger((ledger) => {
    const kinds = Object.values(ItemKind);
    return new Map(kinds.map((kind) => [kind, targetOptions(ledger, kind)] as const));
  });
  const targets = useLedger(
    (ledger) => {
      const card = batch?.doc_type === importing.importModel.DocType.CARD_STATEMENT;
      const options: SelectOption[] = card
        ? [...ledger.cards.values()].map((c) => ({ id: `card:${c.id}`, label: c.name }))
        : liquidAccounts(ledger).map((a) => ({ ...a, id: `account:${a.id}` }));
      return options;
    },
    `${batchId}:${batch?.doc_type ?? ""}`,
  );

  const [editing, setEditing] = useState<ItemRow | null>(null);
  const [ruling, setRuling] = useState<ItemRow | null>(null);
  const [offer, setOffer] = useState<RuleOffer | null>(null);
  const [layout, setLayout] = useState<string | null>(null);

  const parsers = useMemo(
    () => importing.parsers.PARSERS.filter((p) => batch !== null && p.doc_format === batch.doc_format),
    [batch],
  );

  if (batch === null) return null;
  const current = rows.find((row) => row.id === selected) ?? null;
  const open = rows.filter((row) => isOpen(row.item));
  const approvable = !needsLayout(batch) && batch.status !== BatchStatus.REJECTED && open.length > 0;
  const targetValue = batch.card_id ? `card:${batch.card_id}` : batch.account_id ? `account:${batch.account_id}` : null;
  const layoutId = layout ?? batch.candidates.find((id) => parsers.some((p) => p.id === id)) ?? parsers[0]?.id ?? null;

  // ── commands ───────────────────────────────────

  /** After acting on an item, the next one is selected, so the review goes on from the keyboard. */
  const advance = (from: Id) => {
    const index = rows.findIndex((row) => row.id === from);
    const next = rows[Math.min(index + 1, rows.length - 1)];
    onSelect(next ? next.id : null);
    requestAnimationFrame(() => table.current?.querySelector<HTMLElement>('[role="grid"],[role="listbox"]')?.focus());
  };

  /** Runs a change; a refusal (a `DomainError`) is told to the person and nothing changes. */
  const attempt = <T,>(action: () => T, done?: string): T | undefined => {
    try {
      const result = action();
      if (done) notify(done);
      return result;
    } catch (error) {
      if (error instanceof DomainError) {
        notify(error.message, { tone: "negative" });
        return undefined;
      }
      throw error;
    }
  };

  const changeTarget = (value: string) => {
    const [kind, id] = value.split(":") as ["account" | "card", Id];
    attempt(() =>
      workspace.act((ledger) =>
        importing.pipeline.setBatchTarget(
          ledger,
          batch.id,
          kind === "account" ? id : null,
          kind === "card" ? id : null,
        ),
      ),
    );
  };

  const chooseLayout = () => {
    if (layoutId !== null) void queue.reparse(batch.id, layoutId);
  };

  const setTarget = (itemId: Id, target: Id | null) => {
    const done = attempt(() =>
      workspace.act((ledger) => importing.pipeline.correctItem(ledger, itemId, "target_account_id", target)),
    );
    if (done === undefined) return;
    // The moment a rule saves time: right after a category was picked by hand.
    const ledger = workspace.ledger;
    const item = importing.pipeline.items(ledger).get(itemId);
    const account = item?.target_account_id ? ledger.accounts.get(item.target_account_id) : undefined;
    if (!item || !account || account.subtype !== AccountSubtype.CATEGORY) {
      setOffer(null);
      return;
    }
    setOffer({ itemId, category: account.name, pattern: importing.rules.suggestPattern(item.description) });
  };

  /** One approval: with a reason when the document's total does not match or when only some items go. */
  const approve = async (ids: Id[] | null): Promise<boolean> => {
    let divergence: string | null = null;
    if (batch.reconciliations.some((r) => r.ok === false)) {
      divergence = await prompts.ask({
        title: "Total divergente — aceitar como pendência documentada",
        confirmLabel: "Aceitar e aprovar",
        description: "O total do documento não confere com os itens. A divergência aceita fica registrada no lote.",
      });
      if (divergence === null) return false;
    }
    let partial: string | null = null;
    if (ids !== null && ids.length < open.length) {
      partial = await prompts.ask({
        title: "Aprovação parcial",
        confirmLabel: "Aprovar",
        description: "Os demais itens continuam pendentes. O motivo fica registrado no lote.",
      });
      if (partial === null) return false;
    }
    const result = attempt(() =>
      workspace.act(
        (ledger) =>
          importing.pipeline.approve(ledger, batch.id, ids, { acceptDivergence: divergence, partialReason: partial }),
        ids === null ? "aprovar a importação" : actionName("aprovar", ids.length, "item importado", "itens importados"),
      ),
    );
    if (result === undefined) return false;
    notify(`${result.created} operação(ões) criada(s), ${result.linked} evidência(s) vinculada(s).`, {
      action: { label: "Desfazer", run: undo },
    });
    return true;
  };

  const approveReady = () => {
    if (readOnly || !approvable) return;
    void approve(null);
  };

  const approveSelected = async () => {
    if (readOnly) return;
    if (!current) return notify(NO_SELECTION);
    if (await approve([current.id])) advance(current.id);
  };

  const correct = () => {
    if (readOnly) return;
    if (!current) return notify(NO_SELECTION);
    setEditing(current);
  };

  const keepSeparate = async () => {
    if (readOnly) return;
    if (!current) return notify(NO_SELECTION);
    const id = current.id;
    const reason = await prompts.ask({
      title: "Manter como lançamento separado",
      confirmLabel: "Manter separado",
      description: "O item deixa de ser tratado como repetição e vira um lançamento novo ao ser aprovado.",
    });
    if (reason === null) return;
    if (
      attempt(
        () =>
          workspace.act((ledger) => importing.pipeline.keepSeparate(ledger, id, reason), "manter item separado") ??
          true,
      )
    ) {
      advance(id);
    }
  };

  const reject = async () => {
    if (readOnly) return;
    if (!current) return notify(NO_SELECTION);
    const id = current.id;
    const reason = await prompts.ask({
      title: "Rejeitar item",
      confirmLabel: "Rejeitar",
      description: "O item não vira lançamento. O motivo fica registrado.",
    });
    if (reason === null) return;
    if (
      attempt(
        () =>
          workspace.act((ledger) => importing.pipeline.rejectItems(ledger, [id], reason), "rejeitar item importado") ??
          true,
      )
    ) {
      advance(id);
    }
  };

  const createRule = (row: ItemRow | null) => {
    if (readOnly) return;
    if (!row) return notify("Selecione um item para criar a regra a partir dele.");
    setRuling(row);
  };

  const seeInBook = () => {
    const id = current?.item.operation_id ?? current?.item.duplicate_of ?? null;
    if (id) goTo("livro", { ref: id });
  };

  const focusCategory = () => {
    if (!current) return;
    const scope = cards ? document.querySelector("[data-selected-category]") : table.current;
    scope
      ?.querySelector<HTMLElement>(
        cards ? '[role="combobox"]' : `[data-row-id="${CSS.escape(current.id)}"] [role="combobox"]`,
      )
      ?.click();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    // dialogs are portals: their keys reach here through React, not through the page
    if (!(event.target instanceof Node) || !event.currentTarget.contains(event.target)) return;
    const mod = event.ctrlKey || event.metaKey;
    if (mod && event.key === "Enter") {
      event.preventDefault();
      if (event.shiftKey) approveReady();
      else void approveSelected();
      return;
    }
    const grid = table.current?.querySelector('[role="grid"],[role="listbox"]');
    if (event.target !== grid || mod || event.altKey) return;
    const keys: Record<string, () => void> = {
      F2: correct,
      Delete: () => void reject(),
      m: () => void keepSeparate(),
      r: () => createRule(current),
      c: focusCategory,
    };
    const action = keys[event.key];
    if (action) {
      event.preventDefault();
      action();
    }
  };

  // ── the items ──────────────────────────────────

  // The description leads: it is the title of the card on a narrow screen, and the row is told apart by it.
  const columns: DataColumn<ItemRow>[] = [
    {
      id: "description",
      header: "Descrição",
      cell: (row) => <ElidedText>{row.description}</ElidedText>,
      sortValue: (row) => row.description,
      grow: 3,
      width: 140,
    },
    {
      id: "status",
      header: "Situação",
      cell: (row) => <Badge tone={STATUS_TONE[row.item.status] ?? "neutral"}>{row.status}</Badge>,
      sortValue: (row) => row.status,
      width: 120,
    },
    {
      id: "date",
      header: "Data",
      cell: (row) => day(row.date),
      sortValue: (row) => row.date ?? "",
      width: 108,
      priority: 2,
    },
    { id: "kind", header: "Tipo", cell: (row) => row.kind, sortValue: (row) => row.kind, width: 120, priority: 3 },
    {
      id: "amount",
      header: "Valor",
      cell: (row) => money(row.amount),
      sortValue: (row) => row.amount?.toFixed() ?? null,
      align: "end",
      width: 104,
    },
    {
      id: "target",
      header: "Categoria",
      cell: (row) =>
        row.editable && !cards ? (
          <Select
            label={`Categoria ou conta de ${row.description}`}
            hideLabel
            options={optionsByKind.get(row.item.kind) ?? []}
            value={row.targetId ?? DEFAULT_TARGET}
            onChange={(id) => setTarget(row.id, id === DEFAULT_TARGET ? null : id)}
            disabled={readOnly}
            className="w-40"
          />
        ) : (
          <ElidedText>{row.targetName}</ElidedText>
        ),
      sortValue: (row) => row.targetName,
      grow: 2,
      width: 184,
    },
    {
      id: "notes",
      header: "Observações",
      cell: (row) => <ElidedText>{row.notes || "—"}</ElidedText>,
      grow: 2,
      width: 180,
      priority: 3,
    },
  ];

  const checks = verdicts(batch);
  const readOnlyTip = readOnly ? READ_ONLY : undefined;
  const moreEntries: MenuEntry[] = [
    {
      id: "keep-separate",
      label: "Manter separado…",
      shortcut: "M",
      onSelect: () => void keepSeparate(),
      disabled: readOnly || current?.item.status !== ItemStatus.DUPLICATE,
    },
    {
      id: "create-rule",
      label: "Criar regra a partir do item…",
      shortcut: "R",
      onSelect: () => createRule(current),
      disabled: readOnly,
    },
    { kind: "separator", id: "sep" },
    {
      id: "reject",
      label: "Rejeitar item…",
      shortcut: "Del",
      danger: true,
      onSelect: () => void reject(),
      disabled: readOnly,
    },
  ];
  const aiCount = ai.client !== null ? ai.pendingCount(batch.id) : 0;
  const linkTo = current?.item.operation_id ?? current?.item.duplicate_of ?? null;

  return (
    <div className="flex min-w-0 flex-col gap-3" onKeyDown={onKeyDown}>
      <header className="flex min-w-0 flex-col gap-1">
        <h2 className="text-headline font-semibold">
          <ElidedText>{documentName(workspace, batch.document_id)}</ElidedText>
        </h2>
        <p className="text-body text-secondary">{factsLine(batch)}</p>
        {checks.length ? (
          <ul aria-label="Conferência dos totais" className="flex flex-col gap-1">
            {checks.map((check) => (
              <li key={check.label} className="flex flex-wrap items-center gap-x-2 gap-y-1 text-caption text-secondary">
                <span>
                  {check.label}: documento {check.expected}, calculado {check.computed}
                </span>
                <Badge tone={check.tone}>{check.verdict}</Badge>
              </li>
            ))}
          </ul>
        ) : null}
        {batch.unmapped_lines ? (
          <p className="text-caption text-secondary">
            {batch.unmapped_lines} linha(s) não mapeada(s) preservadas no original.
          </p>
        ) : null}
        {batch.warnings.length ? (
          <ul aria-label="Avisos do documento" className="flex flex-col gap-1">
            {batch.warnings.map((warning) => (
              <li key={warning} className="flex items-start gap-1.5 text-caption text-warning">
                <TriangleAlert aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
                <span>Atenção: {warning}</span>
              </li>
            ))}
          </ul>
        ) : null}
      </header>

      <div className="flex flex-wrap items-end gap-x-4 gap-y-2">
        <Select
          label="Conta ou cartão"
          options={targets}
          value={targetValue}
          onChange={changeTarget}
          placeholder="(escolha)"
          disabled={readOnly}
          className="w-full min-w-48 tablet:w-72"
        />
        {needsLayout(batch) ? (
          <div className="flex w-full min-w-0 flex-wrap items-end gap-2 tablet:w-auto">
            <Select
              label="Layout"
              options={parsers.map((p) => ({ id: p.id, label: `${p.institution} — ${p.product} (${p.id})` }))}
              value={layoutId}
              onChange={setLayout}
              placeholder="(escolha)"
              disabled={readOnly || queue.busy}
              className="w-full min-w-48 tablet:w-80"
            />
            <Button onClick={chooseLayout} disabled={readOnly || queue.busy || layoutId === null} title={readOnlyTip}>
              Usar layout
            </Button>
          </div>
        ) : null}
      </div>

      <div role="toolbar" aria-label="Comandos da revisão" className="flex flex-wrap items-center gap-2">
        <Button
          variant="primary"
          icon={<Check />}
          onClick={approveReady}
          disabled={readOnly || !approvable}
          title={readOnlyTip ?? "Cria os lançamentos dos itens prontos (Ctrl+Shift+Enter)"}
        >
          Aprovar prontos
        </Button>
        <Button
          onClick={() => void approveSelected()}
          disabled={readOnly || !current || !approvable}
          title={readOnlyTip ?? "Ctrl+Enter"}
        >
          Aprovar selecionado
        </Button>
        <Button
          icon={<Pencil />}
          onClick={correct}
          disabled={readOnly || !current}
          title={readOnlyTip ?? "F2 ou Enter"}
        >
          Corrigir…
        </Button>
        {ai.client !== null ? (
          <Button
            icon={<Sparkles />}
            onClick={() => ai.suggest(batch.id)}
            disabled={readOnly || !aiCount || ai.run.running || queue.busy}
            title={
              aiCount
                ? `${ai.client.model} no Ollama local: sugere categorias para os itens sem categoria; nada é aprovado sozinho`
                : "Todos os itens deste documento já têm categoria"
            }
          >
            {aiCount ? `Sugerir com IA (${aiCount})` : "Sugerir com IA"}
          </Button>
        ) : null}
        {linkTo ? (
          <Button variant="ghost" icon={<ExternalLink />} onClick={seeInBook}>
            Ver no Livro
          </Button>
        ) : null}
        <MenuButton label="Mais" items={moreEntries} />
      </div>

      <AnimatePresence initial={false}>
        {offer ? (
          <motion.div
            key="offer"
            role="status"
            initial={preset.enter.initial}
            animate={preset.enter.animate}
            exit={preset.enter.exit}
            transition={preset.enter.transition}
            className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg bg-accent-soft px-3 py-2"
          >
            <span className="min-w-0 flex-1 basis-56 text-body">
              Usar sempre “{offer.category}” para descrições com “{offer.pattern}”?
            </span>
            <Button
              size="sm"
              variant="primary"
              disabled={readOnly}
              onClick={() => {
                const row = rows.find((r) => r.id === offer.itemId) ?? null;
                setOffer(null);
                createRule(row);
              }}
            >
              Criar regra…
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setOffer(null)}>
              Agora não
            </Button>
          </motion.div>
        ) : null}
      </AnimatePresence>

      {cards && current?.editable ? (
        <div data-selected-category="" className="rounded-lg border border-separator bg-raised p-3">
          <Select
            label={`Categoria ou conta de ${current.description}`}
            options={optionsByKind.get(current.item.kind) ?? []}
            value={current.targetId ?? DEFAULT_TARGET}
            onChange={(id) => setTarget(current.id, id === DEFAULT_TARGET ? null : id)}
            disabled={readOnly}
          />
          <div className="mt-2">
            <Button
              size="sm"
              variant="ghost"
              icon={<ScanSearch />}
              onClick={() =>
                document.getElementById("importar-original")?.scrollIntoView({ block: "start", behavior: "smooth" })
              }
            >
              Ver no original
            </Button>
          </div>
        </div>
      ) : null}

      <div ref={attachTable} className="min-w-0">
        <DataTable
          label="Itens extraídos"
          layout={cards ? "cards" : "table"}
          rows={rows}
          columns={columns}
          getRowId={(row) => row.id}
          selectedId={current?.id ?? null}
          onSelect={onSelect}
          onActivate={() => correct()}
          rowHeight={48}
          height="max(22rem, calc(100dvh - 24rem))"
          cardTitle={(row) => <ElidedText>{row.description}</ElidedText>}
          empty={
            <div className="flex flex-col items-center gap-2 px-4 py-10 text-center">
              <FileSearch aria-hidden="true" className="size-7 text-secondary" />
              <p className="text-body font-medium">Nenhum item extraído deste documento</p>
              <p className="max-w-md text-body text-secondary">
                {needsLayout(batch)
                  ? "Escolha o layout acima para ler o documento de novo, ou registre os lançamentos à mão no Livro financeiro."
                  : "O arquivo foi guardado, mas nada foi lido dele."}
              </p>
            </div>
          }
        />
      </div>

      {editing ? (
        <ImportItemDialog
          open
          item={editing.item}
          onClose={() => setEditing(null)}
          onDone={() => notify("Item corrigido.", { action: { label: "Desfazer", run: undo } })}
        />
      ) : null}
      {ruling ? (
        <RuleDialog
          open
          description={ruling.description}
          targetId={ruling.item.target_account_id}
          accountId={batch.account_id}
          fromItem={ruling.id}
          onClose={() => setRuling(null)}
          onDone={(_rule, changed) =>
            notify(`Regra criada. ${changed} item(ns) pendente(s) recategorizado(s).`, {
              action: { label: "Desfazer", run: undo },
            })
          }
        />
      ) : null}
      {prompts.dialog}
    </div>
  );
}

function documentName(workspace: ReturnType<typeof useWorkspace>, documentId: Id): string {
  return workspace.session.documents.find((d) => d.meta.id === documentId)?.meta.original_name ?? "Documento";
}
