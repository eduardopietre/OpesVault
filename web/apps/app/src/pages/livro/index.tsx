/**
 * Livro financeiro (desktop `pages/ledger/page.py`): every operation, with search, filters, an inspector
 * beside the table and the corrections the docs allow (RF-10, RF-22).
 *
 * Layout: header (title, count, search, Exportar, Novo lançamento), one filter row with the saved filters,
 * the row commands and the local AI, then the table beside the inspector that follows the selection. The
 * table is virtualized, so tens of thousands of operations stay responsive. Row commands live in the "Ações"
 * menu and the keyboard (Enter corrects, Space marks); the inspector offers the main ones too.
 *
 * On a phone the entries come first: one toolbar row holds the search, a "Filtros" button (with the number of
 * active filters) that opens a sheet with the filters and the saved filters, and one "Mais comandos" menu with
 * the row commands, the local AI and the export. Each entry is a compact card (`LedgerCard`).
 */
import {
  AccountType,
  cashDate,
  dom,
  exporting,
  isActive,
  search,
  tax,
  ymStr,
  type Id,
  type Operation,
} from "@opesvault/domain";
import {
  Button,
  DataTable,
  EmptyState,
  IconButton,
  Inspector,
  MenuButton,
  PageHeader,
  Sheet,
  TextField,
  confirm,
  decide,
  formatBrDate,
  notify,
  parseBrDate,
  useBand,
  useElementWidth,
  usePreferences,
  useMotionPreset,
  type MenuEntry,
  saveFile,
  CSV_TYPE,
} from "@opesvault/ui";
import { AnimatePresence, motion } from "motion/react";
import {
  BookOpen,
  Download,
  Eye,
  Ellipsis,
  FileSpreadsheet,
  Filter,
  ListChecks,
  Plus,
  Search,
  SlidersHorizontal,
  Sparkles,
  Table2,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useGoTo, useReveal } from "../../data/navigation.ts";
import { useSharedMonth } from "../../data/month.ts";
import { useAct, useLedger, useWorkspace } from "../../data/react.tsx";
import { AiRunRow } from "../../dialogs/ai_review.tsx";
import { OPERATION_KINDS, type OperationKindKey } from "../../dialogs/operation.tsx";
import { isSimple } from "../../dialogs/operation_edit.tsx";
import { useLedgerAi } from "./ai.tsx";
import { COLUMN_TITLES, LedgerCard, REQUIRED_COLUMNS, ledgerColumns } from "./columns.tsx";
import { operationsCsv } from "./export.ts";
import { FilterBar, activeFilterCount, useFilterChoices } from "./filters.tsx";
import { LedgerDialogs, type DialogSpec } from "./host.tsx";
import { useDialog } from "../../data/dialog.ts";
import { OperationDetails, SelectionNote } from "./inspector.tsx";
import {
  EMPTY_FILTERS,
  filtersActive,
  monthOnly,
  parseReveal,
  stateOfSaved,
  toOperationFilter,
  type FilterState,
} from "./rows.ts";
import { monthLabel } from "../../dialogs/livro_form.tsx";
import { actionName } from "../../data/action_names.ts";
import { exportUnencrypted } from "../../data/export_file.ts";

const HIDDEN_COLUMNS_KEY = "livro/colunas-ocultas";
const EMPTY_SET: ReadonlySet<string> = new Set();

function readHidden(raw: string | null): ReadonlySet<string> {
  if (!raw) return EMPTY_SET;
  return new Set(raw.split(",").filter((id) => id && !REQUIRED_COLUMNS.has(id)));
}

export function Page() {
  const workspace = useWorkspace();
  const goTo = useGoTo();
  const act = useAct();
  const band = useBand();
  const preset = useMotionPreset();
  const preferences = usePreferences();
  const [month, chooseMonth] = useSharedMonth();
  const today = workspace.today();
  const readOnly = workspace.readOnly;

  const [filters, setFilters] = useState<FilterState>(EMPTY_FILTERS);
  const [searchText, setSearchText] = useState("");
  const searchField = useRef<HTMLInputElement>(null);
  const receiptInput = useRef<HTMLInputElement>(null);
  const [pickedRow, setPickedRow] = useState<Id | null>(null);
  const [pickedChecks, setPickedChecks] = useState<ReadonlySet<string>>(EMPTY_SET);
  const [hidden, setHidden] = useState<ReadonlySet<string>>(() => readHidden(preferences.get(HIDDEN_COLUMNS_KEY)));
  const [details, setDetails] = useState<{ band: string; open: boolean } | null>(null);
  const host = useDialog<DialogSpec>();
  const [measureTable, tableWidth] = useElementWidth<HTMLDivElement>();
  const cards = tableWidth > 0 && tableWidth < 640;
  const phone = band === "phone";
  const [filtersOpen, setFiltersOpen] = useState(false);

  // The search waits for a short pause in typing; the other choices apply at once.
  useEffect(() => {
    const timer = setTimeout(() => setFilters((f) => (f.text === searchText ? f : { ...f, text: searchText })), 250);
    return () => clearTimeout(timer);
  }, [searchText]);
  const applyFilters = useCallback((next: FilterState) => {
    setFilters(next);
    setSearchText(next.text);
  }, []);
  const reset = () => applyFilters(EMPTY_FILTERS);

  // ── data ───────────────────────────────────────

  const choices = useFilterChoices();
  const filterKey = `${JSON.stringify(filters)}|${ymStr(month)}|${today}`;
  const operations = useLedger(
    (ledger) =>
      search.findOperations(
        ledger,
        toOperationFilter(ledger, filters, month, today, (text) => parseBrDate(text) as ReturnType<typeof cashDate>),
      ),
    filterKey,
  );
  const total = useLedger((ledger) => ledger.operations.size);
  const ledger = workspace.ledger;
  const savedFilters = useLedger((l) => dom.savedFilters.saved(l));
  const active = filtersActive(filters);

  const operationOf = (id: Id | null): Operation | null => (id === null ? null : (ledger.operations.get(id) ?? null));
  // A selection that a new choice filtered out is not acted on (and comes back if the filter does).
  const shownIds = useMemo(() => new Set(operations.map((o) => o.id)), [operations]);
  const current = pickedRow !== null && shownIds.has(pickedRow) ? pickedRow : null;
  const checked = useMemo(
    () =>
      pickedChecks.size && [...pickedChecks].some((id) => !shownIds.has(id))
        ? new Set([...pickedChecks].filter((id) => shownIds.has(id)))
        : pickedChecks,
    [pickedChecks, shownIds],
  );
  const setCurrent = setPickedRow;
  const setChecked = setPickedChecks;
  const currentOp = useLedger((l) => (current === null ? null : (l.operations.get(current) ?? null)), current);
  /** The operations a command acts on: the ticked ones, or the current row. */
  const targets: Id[] = checked.size ? [...checked] : current !== null && currentOp ? [current] : [];
  const single: Operation | null = currentOp ?? (checked.size === 1 ? operationOf([...checked][0] ?? null) : null);

  // ── details panel: beside the table when wide, a sheet when not ──

  const detailsOpen = details?.band === band ? details.open : band === "wide";
  const setDetailsOpen = useCallback((open: boolean) => setDetails({ band, open }), [band]);

  const select = (id: string) => {
    setCurrent(id);
    if (band === "phone") setDetailsOpen(true); // there is no other way to see an operation on a phone
  };

  // ── commands ───────────────────────────────────

  const show = (spec: DialogSpec) => host.show(spec);
  const needOne = (): Operation | null => {
    if (single === null) {
      notify("Selecione um lançamento.");
      return null;
    }
    return single;
  };
  const editable = (): Operation | null => {
    const op = needOne();
    if (op === null) return null;
    if (!isActive(op)) {
      notify("Lançamento cancelado não pode ser corrigido.");
      return null;
    }
    return op;
  };

  const openEdit = (op?: Operation | null) => {
    const found = op ?? editable();
    if (found === null || found === undefined) return;
    if (!isActive(found)) {
      notify("Lançamento cancelado não pode ser corrigido.");
      return;
    }
    show({ kind: isSimple(ledger, found) ? "simple" : "postings", id: found.id });
  };
  const editPostings = () => {
    const op = editable();
    if (op) show({ kind: "postings", id: op.id });
  };
  const reclassify = () => {
    if (targets.length) show({ kind: "reclassify", ids: targets });
  };
  const tag = () => {
    if (targets.length) show({ kind: "tags", ids: targets });
  };
  const attach = () => {
    if (needOne()) receiptInput.current?.click();
  };
  const attachChosen = async (file: File | undefined) => {
    const op = single;
    if (!file || op === null) return;
    const bytes = new Uint8Array(await file.arrayBuffer());
    act((_ledger, session) => dom.attachments.attach(session, op.id, file.name, bytes), {
      done: "Comprovante anexado e guardado cifrado no projeto.",
      label: "anexar comprovante",
    });
  };
  /** Takes a receipt off the selected entry (one act); a file nothing else uses leaves the project with it. */
  const detachReceipt = async () => {
    const op = needOne();
    if (op === null) return;
    const receipts = dom.attachments.ofOperation(ledger, op.id);
    if (!receipts.length) {
      notify("Este lançamento não tem comprovante.");
      return;
    }
    const nameOf = (documentId: Id) =>
      workspace.session.documents.find((d) => d.meta.id === documentId)?.meta.original_name ?? "comprovante";
    let target = receipts[0]!;
    if (receipts.length === 1) {
      const ok = await confirm({
        title: "Desvincular o comprovante?",
        text: `“${nameOf(target.document_id)}” deixa de ser comprovante de “${op.description}”. Se nada mais usar o arquivo, ele sai do projeto. Dá para desfazer logo em seguida.`,
        confirmLabel: "Desvincular",
        danger: true,
      });
      if (!ok) return;
    } else {
      const choice = await decide({
        title: "Desvincular qual comprovante?",
        text: `“${op.description}” tem ${receipts.length} comprovantes. O arquivo só sai do projeto se nada mais o usar. Dá para desfazer logo em seguida.`,
        choices: receipts.map((receipt, index) => ({
          id: receipt.id,
          label: `Desvincular ${index + 1}: ${nameOf(receipt.document_id)}`,
          variant: "danger" as const,
        })),
      });
      const chosen = receipts.find((receipt) => receipt.id === choice);
      if (!chosen) return;
      target = chosen;
    }
    try {
      // Undo puts the file back with its bytes, so they must be in this tab before it can go.
      await workspace.loadDocument(target.document_id);
    } catch (error) {
      notify(error instanceof Error ? error.message : "Não foi possível desvincular o comprovante.", {
        tone: "negative",
      });
      return;
    }
    act((_ledger, session) => dom.attachments.detach(session, target.id), {
      done: "Comprovante desvinculado. Ctrl+Z desfaz.",
      label: "desvincular comprovante",
    });
  };
  const detailIncome = () => {
    const op = needOne();
    if (op === null) return;
    if (!isActive(op) || !tax.records.receivedAmount(ledger, op.id).isPositive()) {
      notify("Só receitas têm detalhamento de rendimento.");
      return;
    }
    show({ kind: "income-detail", id: op.id });
  };
  const nameMerchant = () => {
    const op = needOne();
    if (op) show({ kind: "merchant", id: op.id });
  };
  const markReviewed = () => {
    if (!targets.length) return;
    act((l) => targets.reduce((n, id) => n + dom.anomalies.markReviewed(l, id), 0), {
      done: `${targets.length} lançamento(s) conferido(s); avisos de duplicidade ou valor silenciados.`,
      label: actionName("conferir", targets.length, "lançamento", "lançamentos"),
    });
  };
  const reimbursement = () => {
    const op = needOne();
    if (op) show({ kind: "reimbursement", id: op.id });
  };
  const reverse = () => {
    const op = needOne();
    if (op) show({ kind: "reverse", id: op.id });
  };
  const showHistory = () => {
    const op = needOne();
    if (op) show({ kind: "history", id: op.id });
  };
  const cancel = () => {
    const op = needOne();
    if (op) show({ kind: "cancel", id: op.id });
  };
  const checkBalance = () => {
    const op = single;
    const accounts = (op ? op.postings.map((p) => p.account_id) : []).filter((id) => {
      const type = ledger.accounts.get(id)?.type;
      return type === AccountType.ASSET || type === AccountType.LIABILITY;
    });
    const unique = [...new Set(accounts)];
    const filtered = filters.account !== null && unique.includes(filters.account) ? filters.account : unique[0];
    if (filtered === undefined) {
      notify("Este lançamento não toca uma conta ou um cartão: escolha um que toque, ou filtre por uma conta.");
      return;
    }
    show({ kind: "balance", accountId: filtered, choices: unique });
  };
  const checkFilteredBalance = () => {
    const id = filters.account;
    const type = id ? ledger.accounts.get(id)?.type : undefined;
    if (id && (type === AccountType.ASSET || type === AccountType.LIABILITY)) {
      show({ kind: "balance", accountId: id, choices: [id] });
    }
  };
  const deductible = () => {
    const op = needOne();
    if (op === null) return;
    const category = op.postings.find((p) => {
      const account = ledger.accounts.get(p.account_id);
      return account?.type === AccountType.EXPENSE && p.amount.isPositive();
    });
    if (!category) {
      notify("Só despesas com categoria podem ser dedutíveis.");
      return;
    }
    show({ kind: "deductible", categoryId: category.account_id });
  };
  const selectAllShown = () => setChecked(new Set(operations.map((o) => o.id)));
  const check = (id: string, value: boolean) =>
    setChecked((set) => {
      const next = new Set(set);
      if (value) next.add(id);
      else next.delete(id);
      return next;
    });

  const rowCommands: MenuEntry[] = [
    {
      id: "select-all",
      label: `Marcar os ${operations.length} exibidos`,
      onSelect: selectAllShown,
      disabled: !operations.length,
    },
    {
      id: "toggle-mark",
      label: current !== null && checked.has(current) ? "Desmarcar este lançamento" : "Marcar este lançamento",
      onSelect: () => current !== null && check(current, !checked.has(current)),
      disabled: current === null,
    },
    { id: "clear", label: "Limpar marcação", onSelect: () => setChecked(EMPTY_SET), disabled: !checked.size },
    { kind: "separator", id: "sep0" },
    { id: "edit", label: "Corrigir…", onSelect: () => openEdit(), shortcut: "Enter", disabled: readOnly || !single },
    { id: "postings", label: "Corrigir partidas…", onSelect: editPostings, disabled: readOnly || !single },
    { id: "reclassify", label: "Reclassificar…", onSelect: reclassify, disabled: readOnly || !targets.length },
    { id: "tags", label: "Marcadores…", onSelect: tag, disabled: readOnly || !targets.length },
    { id: "attach", label: "Anexar comprovante…", onSelect: attach, disabled: readOnly || !single },
    {
      id: "detach",
      label: "Desvincular comprovante…",
      onSelect: () => void detachReceipt(),
      disabled: readOnly || !single,
    },
    { id: "income", label: "Detalhar rendimento (IR)…", onSelect: detailIncome, disabled: readOnly || !single },
    { id: "merchant", label: "Nomear estabelecimento…", onSelect: nameMerchant, disabled: readOnly || !single },
    { id: "reimbursement", label: "Reembolso a receber…", onSelect: reimbursement, disabled: readOnly || !single },
    {
      id: "reviewed",
      label: "Está certo (silenciar aviso)",
      onSelect: markReviewed,
      disabled: readOnly || !targets.length,
    },
    { id: "reverse", label: "Estornar…", onSelect: reverse, disabled: readOnly || !single },
    { id: "history", label: "Histórico", onSelect: showHistory, disabled: !single },
    { kind: "separator", id: "sep1" },
    { id: "balance", label: "Conferir saldo da conta…", onSelect: checkBalance, disabled: readOnly || !single },
    {
      id: "deductible",
      label: "Marcar categoria como dedutível…",
      onSelect: deductible,
      disabled: readOnly || !single,
    },
    ...(filters.tag !== null
      ? [
          {
            id: "rename-tag",
            label: `Renomear o marcador “${filters.tag}”…`,
            onSelect: () => show({ kind: "rename-tag", tag: filters.tag as string }),
            disabled: readOnly,
          } satisfies MenuEntry,
        ]
      : []),
    { kind: "separator", id: "sep2" },
    { id: "cancel", label: "Cancelar lançamento…", onSelect: cancel, danger: true, disabled: readOnly || !single },
  ];

  // ── the local AI: the ticked operations (two or more), or everything the filters show ──
  const ai = useLedgerAi(
    () => {
      if (checked.size >= 2) {
        return { ids: [...checked], label: `${checked.size} lançamentos selecionados` };
      }
      return {
        ids: operations.map((o) => o.id),
        label: `${operations.length} ${operations.length === 1 ? "lançamento exibido" : "lançamentos exibidos"}`,
      };
    },
    (review) => host.show({ kind: "ai", review }),
  );

  const aiEntries: MenuEntry[] = [
    { id: "ai-categories", label: "Sugerir categorias…", onSelect: ai.suggestCategories, disabled: readOnly },
    {
      id: "ai-names",
      label: "Sugerir nomes de estabelecimentos…",
      onSelect: ai.suggestNames,
      disabled: readOnly,
    },
  ];

  // ── filters saved in the project ───────────────

  const saveCurrentFilter = () => {
    if (filters.period === "custom") {
      notify("Período personalizado não é salvo. Escolha um período com nome.");
      return;
    }
    show({ kind: "save-filter", filter: filters });
  };
  const savedEntries: MenuEntry[] = [
    { id: "save", label: "Salvar filtro atual…", onSelect: saveCurrentFilter, disabled: readOnly },
    ...(savedFilters.length
      ? ([
          { kind: "separator", id: "sep-a" },
          ...savedFilters.map((f): MenuEntry => ({
            id: `apply-${f.id}`,
            label: f.name,
            onSelect: () => {
              applyFilters(stateOfSaved(ledger, f));
              if (f.period === "month") chooseMonth(month);
              notify(`Filtro “${f.name}” aplicado.`);
            },
          })),
          { kind: "separator", id: "sep-b" },
          ...savedFilters.map((f): MenuEntry => ({
            id: `delete-${f.id}`,
            label: `Excluir “${f.name}”`,
            danger: true,
            disabled: readOnly,
            onSelect: () => {
              workspace.act((l) => dom.savedFilters.deleteFilter(l, f.id), "excluir filtro salvo");
              notify("Filtro excluído. Ctrl+Z desfaz.");
            },
          })),
        ] satisfies MenuEntry[])
      : []),
  ];

  // ── export ─────────────────────────────────────

  const exportCsv = async (everything: boolean) => {
    const rows = everything ? [...ledger.operations.values()] : operations;
    if (!rows.length) {
      notify("Não há lançamentos para exportar com estes filtros.");
      return;
    }
    await exportUnencrypted({
      title: "Exportar sem criptografia?",
      text: `${exporting.WARNING} O arquivo CSV (${rows.length} lançamento(s)) vai para a pasta de downloads deste aparelho.`,
      confirmLabel: "Exportar CSV",
      save: () => {
        const bytes = everything ? exporting.ledgerCsv(ledger) : operationsCsv(ledger, rows);
        saveFile(everything ? "livro-completo.csv" : "livro-filtrado.csv", bytes, CSV_TYPE);
      },
    });
  };

  // ── columns ────────────────────────────────────

  const columnChoices: MenuEntry[] = COLUMN_TITLES.map(([id, title]) => ({
    id: `col-${id}`,
    label: `${hidden.has(id) ? "Mostrar" : REQUIRED_COLUMNS.has(id) ? "Sempre visível:" : "Ocultar"} ${title}`,
    disabled: REQUIRED_COLUMNS.has(id),
    onSelect: () => {
      const next = new Set(hidden);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      setHidden(next);
      preferences.set(HIDDEN_COLUMNS_KEY, next.size ? [...next].join(",") : null);
    },
  }));
  const columns = useMemo(
    () => ledgerColumns({ ledger, checked, onCheck: check, hidden, readOnly, cards }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `ledger` is stable; `operations` follows its changes
    [operations, checked, hidden, cards],
  );

  // ── coming from other pages (docs/16 §5) ───────

  useReveal((ref, action) => {
    if (ref === undefined) {
      if (action === "novo") show({ kind: "new", op: "expense" });
      return;
    }
    const target = parseReveal(ref);
    const base: FilterState = { ...EMPTY_FILTERS };
    switch (target.kind) {
      case "category":
        chooseMonth(target.month);
        applyFilters({ ...base, period: "month", account: target.id, withChildren: true });
        setCurrent(null);
        setChecked(EMPTY_SET);
        break;
      case "filter":
        if (target.month) chooseMonth(target.month);
        applyFilters({
          ...base,
          account: target.id,
          member: target.member,
          ...(target.month
            ? { period: "month" as const }
            : target.range
              ? { period: "custom" as const, start: formatBrDate(target.range[0]), end: formatBrDate(target.range[1]) }
              : {}),
        });
        setCurrent(null);
        setChecked(EMPTY_SET);
        break;
      case "account":
        applyFilters({ ...base, account: target.id });
        setCurrent(null);
        setChecked(EMPTY_SET);
        break;
      case "tag":
        applyFilters({ ...base, tag: target.id });
        setCurrent(null);
        setChecked(EMPTY_SET);
        break;
      case "operation": {
        const op = workspace.ledger.operations.get(target.id);
        if (!op) {
          notify("Esse lançamento não existe mais.");
          return;
        }
        applyFilters(base);
        setChecked(EMPTY_SET);
        setCurrent(op.id);
        setDetailsOpen(true);
        if (action === "editar") openEdit(op);
        break;
      }
    }
    if (action === "novo") show({ kind: "new", op: "expense" });
  });

  // ── keyboard: "/" searches, Space marks the current row ──

  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "/" || event.ctrlKey || event.metaKey || event.altKey) return;
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))
      ) {
        return;
      }
      if (document.querySelector("dialog[open]")) return;
      event.preventDefault();
      searchField.current?.focus();
      searchField.current?.select();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const onTableKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (
      event.key === " " &&
      current !== null &&
      event.target === event.currentTarget.querySelector('[role="grid"],[role="listbox"]')
    ) {
      event.preventDefault();
      check(current, !checked.has(current));
    }
  };

  // ── render ─────────────────────────────────────

  const count = operations.length;
  const context = active
    ? `${count} de ${total} ${total === 1 ? "lançamento" : "lançamentos"}`
    : `${total} ${total === 1 ? "lançamento" : "lançamentos"}`;
  const newEntries: MenuEntry[] = (Object.keys(OPERATION_KINDS) as OperationKindKey[]).map((kind) => ({
    id: `new-${kind}`,
    label: OPERATION_KINDS[kind],
    onSelect: () => show({ kind: "new", op: kind }),
    disabled: readOnly,
  }));
  const exportEntries: MenuEntry[] = [
    {
      id: "csv-shown",
      label: "Lançamentos exibidos (CSV)",
      onSelect: () => void exportCsv(false),
      icon: <FileSpreadsheet />,
    },
    { id: "csv-all", label: "Livro completo (CSV)", onSelect: () => void exportCsv(true), icon: <FileSpreadsheet /> },
  ];

  const balanceFiltered =
    filters.account !== null &&
    [AccountType.ASSET, AccountType.LIABILITY].some((t) => ledger.accounts.get(filters.account as Id)?.type === t);
  const filterCount = activeFilterCount(filters);
  /** The phone's one overflow menu: the row commands, the local AI and the export, in labelled groups. */
  const phoneEntries: MenuEntry[] = [
    { kind: "label", id: "label-actions", label: "Ações" },
    ...rowCommands,
    ...(balanceFiltered
      ? [
          {
            id: "balance-filtered",
            label: "Conferir saldo da conta filtrada…",
            onSelect: checkFilteredBalance,
            disabled: readOnly,
          } satisfies MenuEntry,
        ]
      : []),
    ...(ai.client !== null
      ? [
          { kind: "separator", id: "sep-ai" } as const,
          { kind: "label", id: "label-ai", label: "IA local" } as const,
          ...aiEntries,
        ]
      : []),
    { kind: "separator", id: "sep-export" },
    { kind: "label", id: "label-export", label: "Exportar" },
    ...exportEntries,
  ];

  const searchBox = (
    <TextField
      ref={searchField}
      label="Buscar lançamentos"
      hideLabel
      type="search"
      value={searchText}
      onChange={setSearchText}
      placeholder={phone ? "Buscar" : "Buscar descrição ou observação"}
      title="Buscar (tecla /)"
      adornment={<Search />}
      className={phone ? "min-w-0 flex-1" : undefined}
      fieldClassName={phone ? "w-full" : "w-full tablet:w-80 tablet:shrink-0"}
      autoComplete="off"
      onKeyDown={(event) => {
        if (event.key === "Escape" && searchText) {
          event.stopPropagation();
          setSearchText("");
        }
      }}
    />
  );

  const empty =
    total === 0 ? (
      <EmptyState
        icon={<BookOpen />}
        title="Nenhum lançamento ainda"
        description="Importe uma fatura ou um extrato em “Importar e revisar”, ou registre uma operação em Novo lançamento."
        actions={
          <Button variant="primary" onClick={() => goTo("importar")}>
            Importar e revisar
          </Button>
        }
      />
    ) : monthOnly(filters) ? (
      <EmptyState
        icon={<Table2 />}
        title={`Nenhum lançamento em ${monthLabel(month).toLowerCase()}`}
        description="Veja todo o período ou escolha outro mês."
        actions={<Button onClick={reset}>Ver todo o período</Button>}
      />
    ) : (
      <EmptyState
        icon={<Filter />}
        title="Nenhum lançamento com estes filtros"
        description="Ajuste a busca ou limpe os filtros."
        actions={<Button onClick={reset}>Limpar filtros</Button>}
      />
    );

  const renderDetails = (withMenu: boolean) => (
    <div className="flex flex-col gap-3">
      {currentOp && checked.size < 2 ? (
        <OperationDetails
          ledger={ledger}
          operation={currentOp}
          today={today}
          readOnly={readOnly}
          onEdit={() => openEdit(currentOp)}
          onAttach={attach}
          {...(withMenu
            ? { moreActions: <MenuButton label="Mais ações" icon={<ListChecks />} items={rowCommands} /> }
            : {})}
          onOpenReceipt={(documentId) => show({ kind: "receipt", documentId })}
        />
      ) : (
        <SelectionNote selected={checked.size > 1 ? checked.size : currentOp ? 1 : 0} />
      )}
    </div>
  );

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Livro financeiro"
        context={context}
        primary={<MenuButton label="Novo lançamento" variant="primary" icon={<Plus />} items={newEntries} />}
        actions={
          phone ? null : (
            <>
              {searchBox}
              <MenuButton label="Exportar" icon={<Download />} items={exportEntries} />
            </>
          )
        }
      />

      {phone ? (
        <div role="toolbar" aria-label="Busca e comandos do livro" className="-mt-1 flex items-center gap-2">
          {searchBox}
          <Button
            icon={<SlidersHorizontal />}
            onClick={() => setFiltersOpen(true)}
            aria-haspopup="dialog"
            aria-label={filterCount ? `Filtros (${filterCount} ${filterCount === 1 ? "ativo" : "ativos"})` : "Filtros"}
          >
            Filtros
            {filterCount ? (
              <span
                aria-hidden="true"
                className="-mr-1 inline-grid h-5 min-w-5 place-items-center rounded-full bg-accent-fill px-1.5 text-caption font-semibold text-accent-text"
              >
                {filterCount}
              </span>
            ) : null}
          </Button>
          <MenuButton
            label="Mais comandos"
            items={phoneEntries}
            trigger={<IconButton label="Mais comandos" icon={<Ellipsis />} variant="secondary" />}
          />
        </div>
      ) : (
        <FilterBar
          filters={filters}
          onChange={(next) => setFilters(next)}
          month={month}
          onMonth={chooseMonth}
          choices={choices}
          onReset={reset}
        >
          <MenuButton label="Filtros salvos" icon={<Filter />} items={savedEntries} />
          <MenuButton label="Ações" icon={<ListChecks />} items={rowCommands} />
          {cards ? null : <MenuButton label="Colunas" icon={<Table2 />} items={columnChoices} />}
          {ai.client !== null ? <MenuButton label="IA local" icon={<Sparkles />} items={aiEntries} /> : null}
          {balanceFiltered ? (
            <Button variant="ghost" onClick={checkFilteredBalance} disabled={readOnly}>
              Conferir saldo da conta
            </Button>
          ) : null}
          <Button
            variant="ghost"
            icon={<Eye />}
            aria-pressed={detailsOpen}
            onClick={() => setDetailsOpen(!detailsOpen)}
            title="Mostrar ou ocultar detalhes"
          >
            Detalhes
          </Button>
        </FilterBar>
      )}

      <AnimatePresence initial={false}>
        {ai.run.running ? (
          <motion.div
            key="ai-run"
            initial={preset.fade.initial}
            animate={preset.fade.animate}
            exit={preset.fade.exit}
            transition={preset.fade.transition}
          >
            <AiRunRow run={ai.run} />
          </motion.div>
        ) : null}
      </AnimatePresence>

      <div className="flex min-w-0 items-stretch">
        <div ref={measureTable} className="flex min-w-0 flex-1 flex-col gap-2" onKeyDown={onTableKey}>
          <AnimatePresence initial={false}>
            {checked.size > 0 ? (
              <motion.div
                key="marked"
                initial={preset.fade.initial}
                animate={preset.fade.animate}
                exit={preset.fade.exit}
                transition={preset.fade.transition}
                className="flex flex-wrap items-center gap-2 rounded-lg bg-accent-soft px-3 py-1.5"
                role="status"
              >
                <span className="text-body font-medium">
                  {checked.size} {checked.size === 1 ? "marcado" : "marcados"}
                </span>
                {checked.size < operations.length ? (
                  <Button size="sm" variant="ghost" onClick={selectAllShown}>
                    Marcar os {operations.length} exibidos
                  </Button>
                ) : null}
                <Button size="sm" variant="ghost" onClick={() => setChecked(EMPTY_SET)}>
                  Limpar marcação
                </Button>
              </motion.div>
            ) : null}
          </AnimatePresence>
          <DataTable
            label="Lançamentos"
            rows={operations}
            columns={columns}
            getRowId={(op) => op.id}
            selectedId={current}
            onSelect={select}
            onActivate={(id) => openEdit(operationOf(id))}
            height="max(22rem, calc(100dvh - 20rem))"
            renderCard={(op) => <LedgerCard ledger={ledger} op={op} />}
            cardHeight={66}
            empty={empty}
          />
        </div>
        <Inspector open={detailsOpen} onOpenChange={setDetailsOpen} title="Detalhes do lançamento">
          {renderDetails(band !== "wide")}
        </Inspector>
      </div>

      {phone ? (
        <Sheet open={filtersOpen} onOpenChange={setFiltersOpen} title="Filtros" side="bottom">
          <div className="flex flex-col gap-4 px-4 pb-4">
            <FilterBar
              layout="sheet"
              filters={filters}
              onChange={(next) => setFilters(next)}
              month={month}
              onMonth={chooseMonth}
              choices={choices}
              onReset={reset}
            >
              <MenuButton label="Filtros salvos" icon={<Filter />} items={savedEntries} align="start" />
            </FilterBar>
            <Button variant="primary" className="w-full" onClick={() => setFiltersOpen(false)}>
              {count === 1 ? "Ver 1 lançamento" : `Ver ${count} lançamentos`}
            </Button>
          </div>
        </Sheet>
      ) : null}

      <Sheet
        open={detailsOpen && (band === "tablet" || band === "phone")}
        onOpenChange={setDetailsOpen}
        title="Detalhes do lançamento"
        side={band === "phone" ? "bottom" : "right"}
      >
        <div className="px-4 pb-4">{renderDetails(true)}</div>
      </Sheet>

      <input
        ref={receiptInput}
        type="file"
        aria-label="Escolher o comprovante"
        accept=".pdf,.png,.jpg,.jpeg,application/pdf,image/png,image/jpeg"
        className="sr-only"
        tabIndex={-1}
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          void attachChosen(file);
        }}
      />

      <LedgerDialogs
        host={host}
        onCreated={(id) => {
          if (id === null) return;
          // The new entry may be outside the filters: show it, so the person sees where it went.
          setCurrent(id);
          const op = workspace.ledger.operations.get(id);
          if (
            op &&
            !search.matches(
              toOperationFilter(workspace.ledger, filters, month, today, (t) => parseBrDate(t) as never),
              op,
            )
          ) {
            applyFilters(EMPTY_FILTERS);
          }
        }}
      />
    </div>
  );
}
