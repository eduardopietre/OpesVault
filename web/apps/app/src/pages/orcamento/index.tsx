/**
 * Orçamento (desktop `ui/pages/budget_page.py`): planned, actual by competence and remaining per expense
 * category and month, the plan over time, and the month against the recent average and a year ago.
 */
import { Dec, charts, dom, formatBrl, queries, ymAdd, ymOf, ymStr, type YearMonth } from "@opesvault/domain";
import {
  Button,
  ChartPanel,
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
  formatDecimalBR,
  formatMonth,
  notify,
  useMediaQuery,
  useMotionPreset,
  type DataColumn,
} from "@opesvault/ui";
import { CircleAlert, CircleCheck, TriangleAlert } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useRef, useState } from "react";
import { BudgetDialog } from "../../dialogs/budget_dialog.tsx";
import { BudgetGridDialog } from "../../dialogs/budget_grid_dialog.tsx";
import {
  SUGGESTION_MONTHS,
  applyGrid,
  averageSpending,
  editableAmount,
  expenseCategoryOptions,
  gridRows,
  type GridChange,
  type GridRow,
} from "../../dialogs/budget_logic.ts";
import { useAct, useLedger, useWorkspace } from "../../data/react.tsx";
import { useSharedMonth } from "../../data/month.ts";
import { useGoTo, useReveal } from "../../data/navigation.ts";
import { useUndo } from "../../shell/undo.tsx";
import { toChartData } from "../../data/chart_data.ts";
import { STATE_LABELS, cents, categoryRef, parseCategoryRef, plural, summaryLine, usedPercent } from "./rows.ts";

type Row = dom.budget.BudgetRow;

const HISTORY_MONTHS = 6;
const MONTHS_AHEAD = 12;
const LOCKED = "Outra aba ou outro aparelho está editando este projeto. Atualize para editar.";

const money = (value: Dec) => formatBrl(value);
const lower = (month: YearMonth) => formatMonth(month);

interface OneDialog {
  key: number;
  categoryId: string | null;
  month: YearMonth;
  amount: string;
}

interface GridDialog {
  key: number;
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

const COLUMNS: DataColumn<Row>[] = [
  { id: "category", header: "Categoria", cell: (row) => row.name, sortValue: (row) => row.name, grow: 2, width: 160 },
  {
    id: "planned",
    header: "Planejado",
    cell: (row) => money(row.planned),
    sortValue: (row) => cents(row.planned),
    align: "end",
    width: 130,
  },
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
  const phone = useMediaQuery("(max-width: 639px)");
  const [month, chooseMonth] = useSharedMonth();
  const monthKey = ymStr(month);
  const previous = ymAdd(month, -1);
  const locked = workspace.readOnly;
  const lockTip = locked ? LOCKED : undefined;
  const tableBox = useRef<HTMLDivElement>(null);

  const status = useLedger((ledger) => dom.budget.status(ledger, month), monthKey);
  const [pick, setPick] = useState<string | null>(null);
  const selected = status.rows.find((row) => row.categoryId === pick) ?? null;

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

  const [one, setOne] = useState<OneDialog | null>(null);
  const [oneOpen, setOneOpen] = useState(false);
  const [grid, setGrid] = useState<GridDialog | null>(null);
  const [gridOpen, setGridOpen] = useState(false);
  const counter = useRef(0);

  const remaining = status.totalPlanned.sub(status.totalActual);
  const today = ymOf(workspace.today());

  // ── actions ─────────────────────────────────────

  /** The one-value dialog: a given category is edited, without one the user chooses it. */
  const define = (categoryId: string | null, at: YearMonth = month) => {
    const line = categoryId ? dom.budget.lineFor(workspace.ledger, categoryId, at) : null;
    setOne({ key: ++counter.current, categoryId, month: at, amount: line ? editableAmount(line.amount) : "" });
    setOneOpen(true);
  };

  const saveOne = (categoryId: string, amount: Dec): boolean => {
    const at = one?.month ?? month;
    const saved = act((ledger) => dom.budget.setBudget(ledger, categoryId, at, amount), {
      done: `Orçamento de ${lower(at)} atualizado.`,
      label: `orçamento de ${lower(at)}`,
    });
    return saved !== undefined;
  };

  /** Every category of the month in one grid: one dialog, one undo step. */
  const defineMonth = () => {
    const spending = queries.expensesByCategory(workspace.ledger, month, month);
    setGrid({ key: ++counter.current, month, rows: gridRows(workspace.ledger, month, previous, spending) });
    setGridOpen(true);
  };

  // The empty month's next step: a plan from the average spending of the months before it.
  const suggestion = useLedger((ledger) => averageSpending(ledger, month), monthKey);
  const previousPlanned = useLedger((ledger) => dom.budget.linesOf(ledger, previous).length, monthKey);
  const suggestMonth = () => {
    const spending = queries.expensesByCategory(workspace.ledger, month, month);
    const first = ymAdd(month, -SUGGESTION_MONTHS);
    setGrid({
      key: ++counter.current,
      month,
      rows: gridRows(workspace.ledger, month, previous, spending, suggestion),
      note: `Sugestão: a média do gasto de cada categoria de ${lower(first)} a ${lower(previous)}. Confira, ajuste e salve; nada é gravado antes disso.`,
    });
    setGridOpen(true);
  };

  const saveGrid = (changes: readonly GridChange[]): boolean => {
    const at = grid?.month ?? month;
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

  const needsSelection = (): string | null => {
    if (selected) return selected.categoryId;
    notify("Selecione uma categoria na tabela.");
    return null;
  };

  const editSelected = () => {
    const id = needsSelection();
    if (id) define(id);
  };

  const removeSelected = () => {
    const id = needsSelection();
    if (!id) return;
    act((ledger) => dom.budget.removeBudget(ledger, id, month), { label: "remover categoria do orçamento" });
    notify("Categoria removida do orçamento.", { action: { label: "Desfazer", run: undo } });
    setPick(null);
  };

  const seeEntries = () => {
    const id = needsSelection();
    if (id) goTo("livro", { ref: categoryRef(id, month) });
  };

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
        <Button variant="primary" onClick={defineMonth} disabled={locked} title={lockTip}>
          Orçamento do mês…
        </Button>
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
    { label: "Restante", value: remaining, ...(remaining.isNegative() ? { tone: "negative" as const } : {}) },
    { label: "Gasto fora do plano", value: status.unbudgeted, note: "Despesas do mês em categorias sem orçamento" },
  ];

  const tableHeight = phone ? "none" : `${Math.min(status.rows.length, 16) * 36 + 38}px`;

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
              columns={COLUMNS}
              getRowId={(row) => row.categoryId}
              selectedId={selected?.categoryId ?? null}
              onSelect={setPick}
              onActivate={(id) => {
                setPick(id);
                if (!locked) define(id);
              }}
              height={tableHeight}
            />
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
                  <Button size="sm" onClick={editSelected} disabled={locked} title={lockTip}>
                    Alterar valor…
                  </Button>
                  <Button size="sm" onClick={removeSelected} disabled={locked} title={lockTip} tone="negative">
                    Remover do orçamento
                  </Button>
                  <Button size="sm" onClick={seeEntries}>
                    Ver lançamentos
                  </Button>
                </motion.div>
              ) : null}
            </AnimatePresence>
          </>
        ) : (
          <div className="rounded-xl border border-dashed border-separator-strong bg-window/40">
            <EmptyState
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
                    <Button variant="primary" onClick={suggestMonth} disabled={locked} title={lockTip}>
                      Criar a partir dos últimos {SUGGESTION_MONTHS} meses…
                    </Button>
                  ) : null}
                  {previousPlanned ? (
                    <Button
                      variant={suggestion.size ? "secondary" : "primary"}
                      onClick={copyPrevious}
                      disabled={locked}
                      title={lockTip}
                    >
                      Copiar do mês anterior
                    </Button>
                  ) : null}
                  <Button
                    variant={suggestion.size || previousPlanned ? "secondary" : "primary"}
                    onClick={defineMonth}
                    disabled={locked}
                    title={lockTip}
                  >
                    Definir o mês…
                  </Button>
                </>
              }
            />
          </div>
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

      {one ? (
        <BudgetDialog
          key={one.key}
          open={oneOpen}
          onOpenChange={setOneOpen}
          monthLabel={lower(one.month)}
          options={expenseCategoryOptions(workspace.ledger)}
          categoryId={one.categoryId}
          initialAmount={one.amount}
          onSave={saveOne}
        />
      ) : null}
      {grid ? (
        <BudgetGridDialog
          key={grid.key}
          open={gridOpen}
          onOpenChange={setGridOpen}
          monthLabel={lower(grid.month)}
          previousLabel={lower(ymAdd(grid.month, -1))}
          rows={grid.rows}
          note={grid.note}
          onSave={saveGrid}
        />
      ) : null}
    </div>
  );
}
