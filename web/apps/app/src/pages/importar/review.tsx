/**
 * The conference of one document (desktop `ui/pages/imports/review.py` and the middle pane of `page.py`): what
 * the document says (facts, the check of each total, warnings), the account or card it belongs to, the layout
 * when none was recognized, and the items it was read into, each with the category the family would give it.
 * Extracted data is not approved data (docs/00 §4.1): nothing becomes an operation until the person approves it,
 * item by item, the marked ones (a checkbox or Space on the list) or the ready ones together, with a reason when
 * the approval is partial or the total diverges.
 * Every command that changes the project is one `act()`: one undo step.
 */
import { AccountSubtype, DomainError, importing, type Id } from "@opesvault/domain";
import {
  Badge,
  Button,
  Checkbox,
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
import { useLedger, useNotifyDone, useWorkspace } from "../../data/react.tsx";
import { liquidAccounts } from "../../dialogs/account_choices.ts";
import { ImportItemDialog } from "../../dialogs/import_item.tsx";
import { RuleDialog } from "../../dialogs/rule_dialog.tsx";
import { forSelected } from "../../components/list_parts.tsx";
import { plural } from "../../data/text.ts";
import type { ImportAi } from "./ai.tsx";
import { actionName } from "../../data/action_names.ts";
import { useReasonPrompt } from "./prompts.tsx";
import type { ImportQueue } from "./queue.tsx";
import {
  DEFAULT_TARGET,
  factsLine,
  isOpen,
  itemRows,
  needsLayout,
  targetOptions,
  verdicts,
  type ItemRow,
} from "./rows.ts";
import { READ_ONLY_TIP, lockEntries } from "../../data/read_only.ts";
import { moneyOr, dateOr } from "../../data/money.ts";

const { BatchStatus, ItemKind, ItemStatus } = importing.importModel;

/** Below this width the items are cards: the columns that always show need about 550 px. */
const CARDS_BELOW = 560;
const NO_SELECTION = "Selecione um item da lista.";
const NO_MARKS: ReadonlySet<Id> = new Set();

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
  const notifyDone = useNotifyDone();
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
  const [marked, setMarked] = useState<ReadonlySet<Id>>(NO_MARKS);

  const parsers = useMemo(
    () => importing.parsers.PARSERS.filter((p) => batch !== null && p.doc_format === batch.doc_format),
    [batch],
  );

  if (batch === null) return null;
  const current = rows.find((row) => row.id === selected) ?? null;
  const open = rows.filter((row) => isOpen(row.item));
  const approvable = !needsLayout(batch) && batch.status !== BatchStatus.REJECTED && open.length > 0;
  const targetValue = batch.card_id ? `card:${batch.card_id}` : batch.account_id ? `account:${batch.account_id}` : null;
  // Only items still to decide can be marked; an item approved or rejected meanwhile drops out.
  const markedOpen = open.filter((row) => marked.has(row.id));
  const layoutId = layout ?? batch.candidates.find((id) => parsers.some((p) => p.id === id)) ?? parsers[0]?.id ?? null;

  // ── commands ───────────────────────────────────

  const mark = (id: Id, value: boolean) =>
    setMarked((set) => {
      const next = new Set(set);
      if (value) next.add(id);
      else next.delete(id);
      return next;
    });

  const toggleCurrent = () => {
    if (!current) return notify(NO_SELECTION);
    if (!isOpen(current.item)) return notify("Só os itens pendentes podem ser marcados.");
    mark(current.id, !marked.has(current.id));
  };

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
      if (done) notifyDone(done);
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
    notifyDone(
      `${plural(result.created, "operação criada", "operações criadas")}, ${plural(result.linked, "evidência vinculada", "evidências vinculadas")}.`,
    );
    return true;
  };

  const approveReady = () => {
    if (readOnly || !approvable) return;
    void approve(null);
  };

  const approveRow = async (row: ItemRow) => {
    if (await approve([row.id])) advance(row.id);
  };

  const approveSelected = async () => {
    if (readOnly) return;
    if (!current) return notify(NO_SELECTION);
    await approveRow(current);
  };

  /** Ctrl+Enter: the marked items when there are any, otherwise the selected one. */
  const approveMarkedOrSelected = async () => {
    if (readOnly) return;
    if (!markedOpen.length) return approveSelected();
    if (!approvable) return;
    if (await approve(markedOpen.map((row) => row.id))) setMarked(NO_MARKS);
  };

  const correct = () => {
    if (readOnly) return;
    if (!current) return notify(NO_SELECTION);
    setEditing(current);
  };

  const keepSeparate = async () => {
    if (readOnly) return;
    if (!current) return notify(NO_SELECTION);
    await keepRowSeparate(current);
  };

  const keepRowSeparate = async (row: ItemRow) => {
    const id = row.id;
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
        "Item mantido separado: vira um lançamento novo ao ser aprovado.",
      )
    ) {
      advance(id);
    }
  };

  const reject = async () => {
    if (readOnly) return;
    if (!current) return notify(NO_SELECTION);
    await rejectRow(current);
  };

  const rejectRow = async (row: ItemRow) => {
    const id = row.id;
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
        "Item rejeitado: não vira lançamento.",
      )
    ) {
      advance(id);
    }
  };

  /** The marked items rejected together: one reason for all of them, and one undo step. */
  const rejectMarked = async () => {
    if (readOnly || !markedOpen.length) return;
    const ids = markedOpen.map((row) => row.id);
    const many = ids.length === 1 ? "1 item" : `${ids.length} itens`;
    const reason = await prompts.ask({
      title: `Rejeitar ${many}`,
      confirmLabel: `Rejeitar ${many}`,
      description: "Os itens marcados não viram lançamentos. O mesmo motivo fica registrado em todos.",
    });
    if (reason === null) return;
    const done = attempt(
      () =>
        workspace.act(
          (ledger) => importing.pipeline.rejectItems(ledger, ids, reason),
          actionName("rejeitar", ids.length, "item importado", "itens importados"),
        ) ?? true,
    );
    if (done === undefined) return;
    setMarked(NO_MARKS);
    notifyDone(`${plural(ids.length, "item rejeitado", "itens rejeitados")}.`);
  };

  const createRule = (row: ItemRow | null) => {
    if (readOnly) return;
    if (!row) return notify("Selecione um item para criar a regra a partir dele.");
    setRuling(row);
  };

  /** The operation an item became, or the one it repeats. */
  const bookOf = (row: ItemRow | null): Id | null => row?.item.operation_id ?? row?.item.duplicate_of ?? null;

  const seeInBook = (row: ItemRow | null = current) => {
    const id = bookOf(row);
    if (id) goTo("livro", { ref: id });
  };

  /**
   * An item's context menu: the review's commands on that item (with their shortcuts), the operation in the
   * Livro, and Rejeitar apart and in red, through the same reason. An approved item only creates a rule or
   * opens its operation.
   */
  const rowMenu = (row: ItemRow): MenuEntry[] => {
    const pending = isOpen(row.item);
    const approved = row.item.status === ItemStatus.APPROVED;
    const book = bookOf(row);
    const entries: MenuEntry[] = [
      ...(pending && approvable
        ? [{ id: "approve", label: "Aprovar", shortcut: "Ctrl+Enter", onSelect: () => void approveRow(row) }]
        : []),
      ...(!approved ? [{ id: "correct", label: "Corrigir…", shortcut: "F2", onSelect: () => setEditing(row) }] : []),
      ...(row.item.status === ItemStatus.DUPLICATE
        ? [{ id: "keep-separate", label: "Manter separado…", shortcut: "M", onSelect: () => void keepRowSeparate(row) }]
        : []),
      { id: "create-rule", label: "Criar regra a partir do item…", shortcut: "R", onSelect: () => setRuling(row) },
      ...(book
        ? [
            { kind: "separator", id: "s1" } as const,
            { id: "book", label: "Ver no Livro", onSelect: () => seeInBook(row) },
          ]
        : []),
      ...(pending
        ? [
            { kind: "separator", id: "s2" } as const,
            {
              id: "reject",
              label: "Rejeitar item…",
              shortcut: "Del",
              danger: true,
              onSelect: () => void rejectRow(row),
            },
          ]
        : []),
    ];
    return lockEntries(entries, readOnly, ["book"]);
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
      else void approveMarkedOrSelected();
      return;
    }
    const grid = table.current?.querySelector('[role="grid"],[role="listbox"]');
    if (event.target !== grid || mod || event.altKey) return;
    const keys: Record<string, () => void> = {
      " ": toggleCurrent,
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
  const markBox = (row: ItemRow) => (
    // The checkbox is not the row: ticking must not move the current row or open the correction.
    <span
      className="inline-flex"
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
    >
      <Checkbox
        label={<span className="sr-only">Marcar {row.description}</span>}
        checked={marked.has(row.id) && isOpen(row.item)}
        onCheckedChange={(value) => mark(row.id, value)}
        disabled={!isOpen(row.item)}
      />
    </span>
  );

  const columns: DataColumn<ItemRow>[] = [
    // On a phone each item is a card whose title carries the checkbox.
    ...(cards ? [] : [{ id: "mark", header: "Marcar", cell: markBox, width: 72 }]),
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
      cell: (row) => dateOr(row.date),
      sortValue: (row) => row.date ?? "",
      width: 108,
      priority: 2,
    },
    { id: "kind", header: "Tipo", cell: (row) => row.kind, sortValue: (row) => row.kind, width: 120, priority: 3 },
    {
      id: "amount",
      header: "Valor",
      cell: (row) => moneyOr(row.amount),
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
  const readOnlyTip = readOnly ? READ_ONLY_TIP : undefined;
  const moreEntries: MenuEntry[] = [
    {
      id: "keep-separate",
      label: "Manter separado…",
      shortcut: "M",
      onSelect: () => void keepSeparate(),
      ...(current && current.item.status !== ItemStatus.DUPLICATE && !readOnly
        ? { disabled: true, reason: "Só um item marcado como repetição pode ser mantido separado." }
        : forSelected(current, NO_SELECTION, readOnly)),
    },
    {
      id: "create-rule",
      label: "Criar regra a partir do item…",
      shortcut: "R",
      onSelect: () => createRule(current),
      ...forSelected(current, NO_SELECTION, readOnly),
    },
    { kind: "separator", id: "sep" },
    {
      id: "reject",
      label: "Rejeitar item…",
      shortcut: "Del",
      danger: true,
      onSelect: () => void reject(),
      ...forSelected(current, NO_SELECTION, readOnly),
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
            {plural(batch.unmapped_lines, "linha não mapeada preservada", "linhas não mapeadas preservadas")} no
            original.
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
        {markedOpen.length ? (
          <Button
            onClick={() => void approveMarkedOrSelected()}
            disabled={readOnly || !approvable}
            title={readOnlyTip ?? "Ctrl+Enter"}
          >
            {`Aprovar marcados (${markedOpen.length})`}
          </Button>
        ) : null}
        {markedOpen.length ? (
          <Button variant="danger" onClick={() => void rejectMarked()} disabled={readOnly} title={readOnlyTip}>
            Rejeitar marcados…
          </Button>
        ) : (
          <Button
            onClick={() => void approveSelected()}
            disabled={readOnly || !current || !approvable}
            title={readOnlyTip ?? "Ctrl+Enter"}
          >
            Aprovar selecionado
          </Button>
        )}
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
          <Button variant="ghost" icon={<ExternalLink />} onClick={() => seeInBook()}>
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
          rowMenu={rowMenu}
          rowMenuLabel={(row) => `Ações de ${row.description}`}
          onActivate={() => correct()}
          rowHeight={48}
          height="max(22rem, calc(100dvh - 24rem))"
          cardTitle={(row) => (
            <span className="flex min-w-0 items-center gap-2">
              {markBox(row)}
              <ElidedText>{row.description}</ElidedText>
            </span>
          )}
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
          onDone={() => notifyDone("Item corrigido.")}
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
            notifyDone(
              `Regra criada. ${plural(changed, "item pendente recategorizado", "itens pendentes recategorizados")}.`,
            )
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
