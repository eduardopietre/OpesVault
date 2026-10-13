/**
 * Orçamento (desktop `ui/pages/budget_page.py`): planned, actual by competence and remaining per expense
 * category and month, the plan over time, and the month against the recent average and a year ago.
 */
import {
  Dec,
  charts,
  dom,
  formatBrl,
  queries,
  ymAdd,
  ymOf,
  ymStr,
  type YearMonth,
  AccountType,
} from "@opesvault/domain";
import {
  Button,
  ChartPanel,
  confirm,
  DURATION,
  DataTable,
  EASE,
  ElidedText,
  EmptyState,
  Figure,
  MenuButton,
  MonthPicker,
  NumberTicker,
  PageHeader,
  Section,
  Switch,
  formatDecimalBR,
  formatMonth,
  notify,
  useMotionPreset,
  type DataColumn,
  type MenuEntry,
  fitHeight,
  usePhone,
} from "@opesvault/ui";
import { CircleAlert, CircleCheck, CornerDownRight, TriangleAlert } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useRef, useState } from "react";
import { PlannedCell } from "./planned_cell.tsx";
import { BudgetDialog } from "../../dialogs/budget_dialog.tsx";
import { BudgetGridDialog } from "../../dialogs/budget_grid_dialog.tsx";
import {
  SUGGESTION_MONTHS,
  applyGrid,
  averageSpending,
  gridRows,
  type GridChange,
  type GridRow,
} from "../../dialogs/budget_logic.ts";
import { useAct, useLedger, useWorkspace } from "../../data/react.tsx";
import { useSharedMonth } from "../../data/month.ts";
import { useGoTo, useReveal } from "../../data/navigation.ts";
import { useUndo } from "../../shell/undo.tsx";
import { toChartData } from "../../data/chart_data.ts";
import { STATE_LABELS, categoryRef, parseCategoryRef, summaryLine, usedPercent } from "./rows.ts";
import { EditButton, usePick } from "../../components/list_parts.tsx";
import { lockEntries, useLock } from "../../data/read_only.ts";
import { useDialog } from "../../data/dialog.ts";
import { cents } from "../../data/money.ts";
import { editableMoney } from "../../dialogs/form_readers.ts";
import { categoryItems } from "../../dialogs/account_choices.ts";
import { plural } from "../../data/text.ts";

type Row = dom.budget.BudgetRow;

const HISTORY_MONTHS = 6;
const MONTHS_AHEAD = 12;

const money = (value: Dec) => formatBrl(value);
const lower = (month: YearMonth) => formatMonth(month);

interface OneDialog {
  categoryId: string | null;
  month: YearMonth;
  amount: string;
}

interface GridDialog {
  month: YearMonth;
  rows: GridRow[];
  /** Where the typed values came from (a suggestion from earlier spending). */
  note?: string;
}

/** The bar of use: its width is how much of the plan was spent (full when over), with the state's color. */
function UseBar({ row }: { row: Row }) {
  const preset = useMotionPreset();
  const share = Math.min(1, Math.max(0, row.used.toNumberForDisplay()));
  const color = row.state === "over" ? "bg-negative" : row.state === "near" ? "bg-warning" : "bg-positive";
  return (
    <span className="flex min-w-0 items-center gap-2">
      <span aria-hidden="true" className="h-1.5 w-14 shrink-0 overflow-hidden rounded-full bg-selection-inactive">
        <motion.span
          className={`block h-full origin-left rounded-full ${color}`}
          initial={preset.reduce ? { opacity: 0 } : { scaleX: 0 }}
          animate={preset.reduce ? { opacity: 1 } : { scaleX: share }}
          {...(preset.reduce ? { style: { transform: `scaleX(${share})` } } : {})}
          transition={{ duration: DURATION.slow, ease: EASE.enter }}
        />
      </span>
      <span className="tabular-nums">{usedPercent(row.used)}</span>
    </span>
  );
}

const tone = (row: Row) => (row.state === "over" ? "text-negative" : row.state === "near" ? "text-warning" : "");

const STATE_ICONS = {
  ok: <CircleCheck aria-hidden="true" className="size-4 shrink-0" />,
  near: <TriangleAlert aria-hidden="true" className="size-4 shrink-0" />,
  over: <CircleAlert aria-hidden="true" className="size-4 shrink-0" />,
} as const;

const STATE_TEXT = { ok: "text-positive", near: "text-warning", over: "text-negative" } as const;

/** The state in words with a shape, never by color alone. */
function StateLabel({ row }: { row: Row }) {
  return (
    <span className={`inline-flex min-w-0 items-center gap-1.5 font-medium ${STATE_TEXT[row.state]}`}>
      {STATE_ICONS[row.state]}
      <span className="truncate">{STATE_LABELS[row.state]}</span>
    </span>
  );
}

/** How the Planejado cell is edited in place: which row, and what to do with the typed value. */
interface PlannedEditing {
  editingId: string | null;
  locked: boolean;
  start: (id: string) => void;
  save: (id: string, amount: Dec) => boolean;
  cancel: () => void;
}

/** The leftover a category brought from the month before (only when its line carries over). */
function CarriedCell({ row }: { row: Row }) {
  if (row.carried.isZero()) return <span className="text-tertiary">—</span>;
  return <span className="money text-positive">+{money(row.carried)}</span>;
}

function columnsFor(editing: PlannedEditing): DataColumn<Row>[] {
  return [
    {
      id: "category",
      header: "Categoria",
      cell: (row) =>
        row.carryOver ? (
          <span className="inline-flex min-w-0 items-center gap-1.5">
            <span className="truncate">{row.name}</span>
            <span title="Leva a sobra para o mês seguinte" className="inline-flex shrink-0">
              <CornerDownRight aria-hidden="true" className="size-3.5 text-secondary" />
              <span className="sr-only">(leva a sobra para o mês seguinte)</span>
            </span>
          </span>
        ) : (
          row.name
        ),
      sortValue: (row) => row.name,
      grow: 2,
      width: 160,
    },
    {
      id: "planned",
      header: "Planejado",
      cell: (row) => (
        <PlannedCell
          name={row.name}
          planned={row.planned}
          editing={editing.editingId === row.categoryId}
          locked={editing.locked}
          onStart={() => editing.start(row.categoryId)}
          onSave={(amount) => editing.save(row.categoryId, amount)}
          onCancel={editing.cancel}
        />
      ),
      sortValue: (row) => cents(row.planned),
      align: "end",
      width: 140,
    },
    {
      id: "carried",
      header: "Sobra anterior",
      cell: (row) => <CarriedCell row={row} />,
      sortValue: (row) => cents(row.carried),
      align: "end",
      width: 130,
      priority: 2,
    },
    ...FIGURE_COLUMNS,
  ];
}

/** The columns after Planejado and Sobra anterior: what was spent and how it stands. */
const FIGURE_COLUMNS: DataColumn<Row>[] = [
  {
    id: "actual",
    header: "Realizado",
    cell: (row) => money(row.actual),
    sortValue: (row) => cents(row.actual),
    align: "end",
    width: 130,
  },
  {
    id: "remaining",
    header: "Restante",
    cell: (row) => <span className={tone(row)}>{money(row.remaining)}</span>,
    sortValue: (row) => cents(row.remaining),
    align: "end",
    width: 130,
  },
  {
    id: "used",
    header: "Uso",
    cell: (row) => <UseBar row={row} />,
    sortValue: (row) => cents(row.used),
    width: 140,
    grow: 1,
    priority: 2,
  },
  {
    id: "state",
    header: "Situação",
    cell: (row) => <StateLabel row={row} />,
    sortValue: (row) => STATE_LABELS[row.state],
    width: 160,
    grow: 1,
  },
];

export function Page() {
  const workspace = useWorkspace();
  const act = useAct();
  const goTo = useGoTo();
  const { undo } = useUndo();
  const preset = useMotionPreset();
  const phone = usePhone();
  const [month, chooseMonth] = useSharedMonth();
  const monthKey = ymStr(month);
  const previous = ymAdd(month, -1);
  const { locked } = useLock();
  const tableBox = useRef<HTMLDivElement>(null);

  const status = useLedger((ledger) => dom.budget.status(ledger, month), monthKey);
  const { setPick, selected, need } = usePick(status.rows, (row) => row.categoryId);

  const history = useLedger(
    (ledger) =>
      toChartData(
        charts.data.budgetHistory(ledger, ymAdd(month, -(HISTORY_MONTHS - 1)), month, selected?.categoryId ?? null),
      ),
    `${monthKey}|${selected?.categoryId ?? ""}`,
  );
  const comparison = useLedger((ledger) => {
    const chart = charts.data.categoryComparisonChart(ledger, month);
    return chart.series[0]?.points.length ? toChartData(chart) : null;
  }, monthKey);

  const one = useDialog<OneDialog>();
  const grid = useDialog<GridDialog>();

  const remaining = status.totalAvailable.sub(status.totalActual);
  const today = ymOf(workspace.today());
  const next = ymAdd(month, 1);

  // ── actions ─────────────────────────────────────

  // The Planejado cell edited in place (Enter or double click on the row); the dialog stays for the rest.
  const [editingId, setEditingId] = useState<string | null>(null);
  const startEditing = (id: string) => {
    if (locked) return;
    setPick(id);
    setEditingId(id);
  };
  const saveInline = (id: string, amount: Dec): boolean => {
    const saved = act((ledger) => dom.budget.setBudget(ledger, id, month, amount), {
      done: `Orçamento de ${lower(month)} atualizado.`,
      label: `orçamento de ${lower(month)}`,
    });
    if (saved === undefined) return false;
    setEditingId(null);
    return true;
  };
  // A short table (one row per budgeted category): its columns are rebuilt on each render.
  const columns = columnsFor({
    editingId,
    locked,
    start: startEditing,
    save: saveInline,
    cancel: () => setEditingId(null),
  });

  /** The leftover of this month goes to the next one, or stops going. Only a planned line carries over. */
  const toggleCarry = (id: string) => {
    const line = dom.budget.lineFor(workspace.ledger, id, month);
    if (line === null) {
      notify(`Defina o valor de ${lower(month)} antes de levar a sobra.`);
      return;
    }
    const carry = !line.carry_over;
    const saved = act((ledger) => dom.budget.setCarryOver(ledger, id, month, carry), {
      label: carry ? "levar a sobra ao mês seguinte" : "não levar a sobra",
    });
    if (saved === undefined) return;
    notify(
      carry
        ? `A sobra de ${lower(month)} vai para ${lower(next)}. Gasto acima do planejado não passa adiante.`
        : `A sobra de ${lower(month)} deixa de ir para ${lower(next)}.`,
      { action: { label: "Desfazer", run: undo } },
    );
  };

  /** The one-value dialog: a given category is edited, without one the user chooses it. */
  const define = (categoryId: string | null, at: YearMonth = month) => {
    const line = categoryId ? dom.budget.lineFor(workspace.ledger, categoryId, at) : null;
    one.show({ categoryId, month: at, amount: line ? editableMoney(line.amount) : "" });
  };

  const saveOne = (categoryId: string, amount: Dec): boolean => {
    const at = one.spec?.month ?? month;
    const saved = act((ledger) => dom.budget.setBudget(ledger, categoryId, at, amount), {
      done: `Orçamento de ${lower(at)} atualizado.`,
      label: `orçamento de ${lower(at)}`,
    });
    return saved !== undefined;
  };

  /** Every category of the month in one grid: one dialog, one undo step. */
  const defineMonth = () => {
    const spending = queries.expensesByCategory(workspace.ledger, month, month);
    grid.show({ month, rows: gridRows(workspace.ledger, month, previous, spending) });
  };

  // The empty month's next step: a plan from the average spending of the months before it.
  const suggestion = useLedger((ledger) => averageSpending(ledger, month), monthKey);
  const previousPlanned = useLedger((ledger) => dom.budget.linesOf(ledger, previous).length, monthKey);
  const suggestMonth = () => {
    const spending = queries.expensesByCategory(workspace.ledger, month, month);
    const first = ymAdd(month, -SUGGESTION_MONTHS);
    grid.show({
      month,
      rows: gridRows(workspace.ledger, month, previous, spending, suggestion),
      note: `Sugestão: a média do gasto de cada categoria de ${lower(first)} a ${lower(previous)}. Confira, ajuste e salve; nada é gravado antes disso.`,
    });
  };

  const saveGrid = (changes: readonly GridChange[]): boolean => {
    const at = grid.spec?.month ?? month;
    if (changes.length === 0) {
      notify("Nenhuma alteração no orçamento.");
      return true;
    }
    const changed = act((ledger) => applyGrid(ledger, at, changes), {
      done: `Orçamento de ${lower(at)}: ${plural(changes.length, "categoria alterada", "categorias alteradas")}.`,
      label: `orçamento de ${lower(at)}`,
    });
    return changed !== undefined;
  };

  const needsSelection = (): string | null => need("Selecione uma categoria na tabela.")?.categoryId ?? null;

  const editSelected = () => {
    const id = needsSelection();
    if (id) define(id);
  };

  /** A destructive action, so it asks first (the entries stay in Livro; Desfazer brings the line back). */
  const remove = async (id: string) => {
    const name = status.rows.find((r) => r.categoryId === id)?.name ?? "esta categoria";
    const ok = await confirm({
      title: `Remover “${name}” do orçamento?`,
      text: `O valor planejado de ${lower(month)} sai do orçamento; os lançamentos continuam no Livro. Dá para desfazer logo em seguida.`,
      confirmLabel: "Remover",
      danger: true,
    });
    if (!ok) return;
    act((ledger) => dom.budget.removeBudget(ledger, id, month), { label: "remover categoria do orçamento" });
    notify("Categoria removida do orçamento.", { action: { label: "Desfazer", run: undo } });
    setPick(null);
  };

  const removeSelected = () => {
    const id = needsSelection();
    if (id) void remove(id);
  };

  const entriesOf = (id: string) => goTo("livro", { ref: categoryRef(id, month) });

  const seeEntries = () => {
    const id = needsSelection();
    if (id) entriesOf(id);
  };

  /** A category's context menu: change its value, see its entries, and Remover apart and in red. */
  const rowMenu = (row: Row): MenuEntry[] =>
    lockEntries(
      [
        { id: "inline", label: "Alterar aqui", onSelect: () => startEditing(row.categoryId) },
        { id: "edit", label: "Alterar valor…", onSelect: () => define(row.categoryId) },
        {
          id: "carry",
          label: row.carryOver ? `Não levar a sobra para ${lower(next)}` : `Levar a sobra para ${lower(next)}`,
          onSelect: () => toggleCarry(row.categoryId),
        },
        { kind: "separator", id: "s1" },
        { id: "entries", label: "Ver lançamentos", onSelect: () => entriesOf(row.categoryId) },
        { kind: "separator", id: "s2" },
        { id: "remove", label: "Remover do orçamento", danger: true, onSelect: () => void remove(row.categoryId) },
      ],
      locked,
      ["entries"],
    );

  const copyPrevious = () => {
    const copied = act((ledger) => dom.budget.copyMonth(ledger, previous, month), {
      label: `copiar o orçamento de ${lower(previous)}`,
    });
    if (copied === undefined) return;
    if (copied > 0) {
      notify(`${plural(copied, "categoria copiada", "categorias copiadas")} de ${lower(previous)}.`);
    } else {
      notify(`Nada a copiar: ${lower(previous)} não tem orçamento, ou estas categorias já estão definidas neste mês.`);
    }
  };

  // A budget alert or a link from another screen: open its month with the category selected.
  useReveal((ref, action) => {
    const target = parseCategoryRef(ref);
    if (!target) return;
    const at = target.month ?? month;
    chooseMonth(at);
    setPick(target.categoryId);
    requestAnimationFrame(() => tableBox.current?.scrollIntoView({ block: "nearest", behavior: "smooth" }));
    if (action === "definir" || action === "alterar") define(target.categoryId, at);
  });

  const header = (
    <PageHeader
      title="Orçamento"
      context={summaryLine(status)}
      primary={
        <EditButton variant="primary" onClick={defineMonth}>
          Orçamento do mês…
        </EditButton>
      }
      actions={
        <MenuButton
          label="Mais"
          items={[
            { id: "define", label: "Definir valor…", onSelect: () => define(null), disabled: locked },
            { id: "copy", label: "Copiar do mês anterior", onSelect: copyPrevious, disabled: locked },
            { kind: "separator", id: "sep" },
            { id: "edit", label: "Alterar valor…", onSelect: editSelected, disabled: locked },
            { id: "remove", label: "Remover do orçamento", onSelect: removeSelected, disabled: locked, danger: true },
            { id: "entries", label: "Ver lançamentos", onSelect: seeEntries },
          ]}
        />
      }
    >
      <MonthPicker
        value={month}
        onChange={(next) => chooseMonth({ year: next.year, month: next.month })}
        max={{ year: ymAdd(today, MONTHS_AHEAD).year, month: ymAdd(today, MONTHS_AHEAD).month }}
      />
    </PageHeader>
  );

  const figures: { label: string; value: Dec; tone?: "negative"; note?: string }[] = [
    { label: "Planejado", value: status.totalPlanned },
    { label: "Realizado", value: status.totalActual },
    {
      label: "Restante",
      value: remaining,
      ...(remaining.isNegative() ? { tone: "negative" as const } : {}),
      ...(status.totalCarried.isPositive()
        ? { note: `Inclui ${money(status.totalCarried)} de sobra de ${lower(previous)}` }
        : {}),
    },
    { label: "Gasto fora do plano", value: status.unbudgeted, note: "Despesas do mês em categorias sem orçamento" },
  ];

  return (
    <div className="flex flex-col gap-6">
      {header}

      <div className="grid grid-cols-2 gap-3 medium:grid-cols-4">
        {figures.map((figure) => (
          <div
            key={figure.label}
            className="min-w-0 rounded-xl border border-separator bg-raised px-4 py-3 shadow-sm max-tablet:px-3 max-tablet:[&_.text-figure]:text-headline"
          >
            <Figure
              label={figure.label}
              {...(figure.tone ? { tone: figure.tone } : {})}
              {...(figure.note ? { note: figure.note } : {})}
              value={
                <NumberTicker
                  value={figure.value.toFixed()}
                  format={(text) => formatDecimalBR(text, { places: 2, currency: true })}
                />
              }
            />
          </div>
        ))}
      </div>

      <section aria-label="Orçamento por categoria" className="min-w-0" ref={tableBox}>
        {status.rows.length > 0 ? (
          <>
            <DataTable
              label="Orçamento por categoria"
              rows={status.rows}
              columns={columns}
              getRowId={(row) => row.categoryId}
              selectedId={selected?.categoryId ?? null}
              onSelect={(id) => {
                if (id !== editingId) setEditingId(null);
                setPick(id);
              }}
              rowMenu={rowMenu}
              rowMenuLabel={(row) => `Ações de ${row.name}`}
              onActivate={(id) => {
                setPick(id);
                startEditing(id);
              }}
              height={fitHeight(status.rows.length, 16, phone)}
            />
            <p className="mt-2 text-caption text-secondary">
              {locked
                ? "Projeto somente leitura: os valores não podem ser alterados."
                : "Enter ou duplo clique na linha (ou um clique no valor) altera o planejado na própria tabela: Enter salva, Esc cancela."}{" "}
              A sobra levada ao mês seguinte é só o que não foi gasto; gasto acima do planejado não passa adiante.
            </p>
            <AnimatePresence initial={false}>
              {selected ? (
                <motion.div
                  key="selection"
                  {...preset.enter}
                  className="mt-3 flex flex-wrap items-center gap-2 rounded-lg bg-accent-soft px-3 py-2"
                >
                  <div className="min-w-0 flex-1 basis-40 text-body">
                    <span className="text-secondary">Selecionada: </span>
                    <span className="font-semibold">
                      <ElidedText className="inline-block max-w-full align-bottom">{selected.name}</ElidedText>
                    </span>
                  </div>
                  <EditButton size="sm" onClick={editSelected}>
                    Alterar valor…
                  </EditButton>
                  <Switch
                    label={`Levar a sobra para ${lower(next)}`}
                    checked={selected.carryOver}
                    onCheckedChange={() => toggleCarry(selected.categoryId)}
                    disabled={locked}
                  />
                  <EditButton size="sm" onClick={removeSelected} tone="negative">
                    Remover do orçamento
                  </EditButton>
                  <Button size="sm" onClick={seeEntries}>
                    Ver lançamentos
                  </Button>
                </motion.div>
              ) : null}
            </AnimatePresence>
          </>
        ) : (
          <EmptyState
            framed
            title={`Sem orçamento em ${lower(month)}`}
            description={
              suggestion.size
                ? `Crie o orçamento do mês a partir dos gastos dos últimos ${SUGGESTION_MONTHS} meses: cada categoria começa com a média, e você confere antes de salvar.`
                : previousPlanned
                  ? `Copie o plano de ${lower(previous)} ou defina quanto pretende gastar por categoria.`
                  : "Defina quanto pretende gastar por categoria. O realizado vem dos lançamentos por competência: compras no cartão contam no mês em que aconteceram."
            }
            actions={
              <>
                {suggestion.size ? (
                  <EditButton variant="primary" onClick={suggestMonth}>
                    Criar a partir dos últimos {SUGGESTION_MONTHS} meses…
                  </EditButton>
                ) : null}
                {previousPlanned ? (
                  <EditButton variant={suggestion.size ? "secondary" : "primary"} onClick={copyPrevious}>
                    Copiar do mês anterior
                  </EditButton>
                ) : null}
                <EditButton
                  variant={suggestion.size || previousPlanned ? "secondary" : "primary"}
                  onClick={defineMonth}
                >
                  Definir o mês…
                </EditButton>
              </>
            }
          />
        )}
      </section>

      <ChartPanel chart={history} prefKey="orcamento/historico" height={260} />

      {comparison ? (
        <Section
          title="Comparação com os meses anteriores"
          description={`Despesas de ${lower(month)} contra a média dos três meses anteriores e o mesmo mês do ano passado.`}
        >
          <ChartPanel chart={comparison} prefKey="orcamento/comparacao" height={280} />
        </Section>
      ) : null}

      {one.spec ? (
        <BudgetDialog
          key={one.key}
          open={one.open}
          onOpenChange={(open) => !open && one.close()}
          monthLabel={lower(one.spec.month)}
          options={categoryItems(workspace.ledger, AccountType.EXPENSE)}
          categoryId={one.spec.categoryId}
          initialAmount={one.spec.amount}
          onSave={saveOne}
        />
      ) : null}
      {grid.spec ? (
        <BudgetGridDialog
          key={grid.key}
          open={grid.open}
          onOpenChange={(open) => !open && grid.close()}
          monthLabel={lower(grid.spec.month)}
          previousLabel={lower(ymAdd(grid.spec.month, -1))}
          rows={grid.spec.rows}
          note={grid.spec.note}
          onSave={saveGrid}
        />
      ) : null}
    </div>
  );
}
