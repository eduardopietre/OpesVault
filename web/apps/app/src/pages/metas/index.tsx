/**
 * Metas (desktop `ui/pages/goals_page.py`, docs/09 §1.3 C): savings and net-worth goals with progress, the
 * amount still needed per month, the recent pace and the evolution of the selected goal (chart and the same
 * values in a table). A goal reads values the ledger already has; it never moves money.
 */
import { charts, dom, formatBrl, ymOf } from "@opesvault/domain";
import {
  ChartPanel,
  DataTable,
  ElidedText,
  EmptyState,
  Figure,
  MenuButton,
  PageHeader,
  notify,
  useElementWidth,
  useMotionPreset,
  fitHeight,
  usePhone,
} from "@opesvault/ui";
import { Goal as GoalIcon } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useMemo, useRef, useState } from "react";
import { toChartData } from "../../data/chart_data.ts";
import { useLedger, useWorkspace } from "../../data/react.tsx";
import { useReveal } from "../../data/navigation.ts";
import { GoalDialog } from "../../dialogs/goal_dialog.tsx";
import { ReasonDialog } from "../../dialogs/livro_prompts.tsx";
import { goalColumns } from "./columns.tsx";
import { goalExample, goalRows, reachedLabel, summaryLine, type GoalExample } from "./rows.ts";
import { EditButton } from "../../components/list_parts.tsx";
import { useLock } from "../../data/read_only.ts";
import { useDialog } from "../../data/dialog.ts";
import { moneyOr, dateOr } from "../../data/money.ts";

type Goal = dom.goals.Goal;

interface EditState {
  goal: Goal | null;
  /** A new goal that starts from the example (the empty page's "Definir uma meta…"). */
  example?: GoalExample;
}

export function Page() {
  const workspace = useWorkspace();
  const preset = useMotionPreset();
  const phone = usePhone();
  const [measure, tableWidth] = useElementWidth<HTMLElement>();
  const columns = useMemo(() => goalColumns(tableWidth), [tableWidth]);
  const { locked } = useLock();
  const today = workspace.today();

  const rows = useLedger((ledger) => goalRows(ledger, today), today);
  // Like the desktop, a goal is always selected when there is one: the first until the person picks another.
  const [pick, setPick] = useState<string | null>(null);
  const selected = rows.find((row) => row.id === pick) ?? rows[0] ?? null;
  const chart = useLedger(
    (ledger) => (selected ? toChartData(charts.data.goalChart(ledger, selected.id, ymOf(today), today)) : null),
    `${selected?.id ?? ""}|${today}`,
  );

  const edit = useDialog<EditState>();
  const archiveDialog = useDialog<Goal>();
  const detail = useRef<HTMLDivElement>(null);
  const archive = archiveDialog.spec;

  const openEdit = (goal: Goal | null) => {
    edit.show({ goal });
  };
  const openExample = () => {
    edit.show({ goal: null, example: goalExample(workspace.ledger, today) });
  };

  const editSelected = () => {
    if (!selected) {
      notify("Selecione uma meta.");
      return;
    }
    openEdit(selected.goal);
  };

  const archiveSelected = () => {
    if (!selected) {
      notify("Selecione uma meta.");
      return;
    }
    archiveDialog.show(selected.goal);
  };

  // A link from another page: the goal opens, selected, with its chart; "editar" also opens the form.
  useReveal((ref, action) => {
    const row = rows.find((r) => r.id === ref);
    if (!row) return;
    setPick(row.id);
    requestAnimationFrame(() => detail.current?.scrollIntoView({ block: "nearest", behavior: "smooth" }));
    if (action === "editar" && !locked) openEdit(row.goal);
  });

  const newButton = (primary: boolean) => (
    <EditButton variant={primary ? "primary" : "secondary"} onClick={() => openEdit(null)}>
      Nova meta…
    </EditButton>
  );

  const p = selected?.progress ?? null;
  const figures = p
    ? [
        {
          label: "Falta por mês",
          value: moneyOr(p.neededPerMonth),
          note: p.monthsLeft === null ? "Sem prazo" : `${p.monthsLeft} mês(es) até o prazo`,
        },
        { label: "Ritmo recente", value: moneyOr(p.pace), note: "Média por mês nos últimos meses com registros" },
        { label: "Alcança em", value: reachedLabel(p.reachedOnPace), note: "Se o ritmo recente continuar" },
        { label: "Prazo", value: dateOr(selected?.goal.target_date ?? null) },
      ]
    : [];

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Metas"
        context={summaryLine(rows.map((r) => r.goal))}
        primary={newButton(true)}
        actions={
          <MenuButton
            label="Mais"
            items={[
              { id: "edit", label: "Editar meta…", onSelect: editSelected, disabled: locked },
              { id: "archive", label: "Arquivar ou reativar…", onSelect: archiveSelected, disabled: locked },
            ]}
          />
        }
      />

      {rows.length === 0 ? (
        <EmptyState
          framed
          icon={<GoalIcon />}
          title="Nenhuma meta"
          description="Defina uma meta de patrimônio ou de saldo para acompanhar quanto falta e em que ritmo o projeto chega lá. Comece pelo exemplo de uma reserva de emergência e ajuste os valores."
          actions={
            <>
              <EditButton variant="primary" onClick={openExample}>
                Definir uma meta…
              </EditButton>
              <EditButton onClick={() => openEdit(null)}>Começar do zero…</EditButton>
            </>
          }
        />
      ) : (
        <>
          <section ref={measure} aria-label="Metas do projeto" className="min-w-0">
            <DataTable
              label="Metas"
              rows={rows}
              columns={columns}
              getRowId={(row) => row.id}
              selectedId={selected?.id ?? null}
              onSelect={setPick}
              onActivate={(id) => {
                setPick(id);
                const row = rows.find((r) => r.id === id);
                if (row && !locked) openEdit(row.goal);
              }}
              height={fitHeight(rows.length, 8, phone)}
            />
            <p className="mt-3 text-caption text-secondary">
              Por mês: quanto falta dividido pelos meses até o prazo. Ritmo recente: quanto o valor mudou por mês, em
              média, nos últimos meses com registros. “—” quando não há prazo ou dados.
            </p>
          </section>

          <AnimatePresence initial={false} mode="wait">
            {selected ? (
              <motion.div key={selected.id} ref={detail} {...preset.enter} className="flex min-w-0 flex-col gap-4">
                <div className="flex flex-wrap items-center gap-2 rounded-lg bg-accent-soft px-3 py-2">
                  <div className="min-w-0 flex-1 basis-48">
                    <div className="flex min-w-0 items-baseline gap-1 text-body">
                      <span className="shrink-0 text-secondary">Selecionada:</span>
                      <ElidedText className="font-semibold">{selected.goal.name}</ElidedText>
                    </div>
                    <div className="text-caption text-secondary">
                      {formatBrl(selected.progress.current)} de {formatBrl(selected.goal.target)}
                    </div>
                  </div>
                  <EditButton size="sm" onClick={editSelected}>
                    Editar meta…
                  </EditButton>
                  <EditButton size="sm" onClick={archiveSelected}>
                    {selected.goal.archived ? "Reativar…" : "Arquivar…"}
                  </EditButton>
                </div>
                <div className="grid grid-cols-2 gap-3 medium:grid-cols-4">
                  {figures.map((figure) => (
                    <div
                      key={figure.label}
                      className="min-w-0 rounded-xl border border-separator bg-raised px-4 py-3 shadow-sm max-tablet:px-3 max-tablet:[&_.text-figure]:text-headline"
                    >
                      <Figure
                        label={figure.label}
                        value={figure.value}
                        {...(figure.note ? { note: figure.note } : {})}
                      />
                    </div>
                  ))}
                </div>
                {chart ? <ChartPanel chart={chart} prefKey="metas" height={260} /> : null}
              </motion.div>
            ) : null}
          </AnimatePresence>
        </>
      )}

      {edit.spec ? (
        <GoalDialog
          key={edit.key}
          open={edit.open}
          onClose={edit.close}
          goal={edit.spec.goal}
          example={edit.spec.example ?? null}
          onDone={(goal, created) => {
            setPick(goal.id);
            notify(created ? "Meta criada." : "Meta atualizada.");
          }}
        />
      ) : null}
      {archive ? (
        <ReasonDialog
          key={archiveDialog.key}
          open={archiveDialog.open}
          onClose={archiveDialog.close}
          title={archive.archived ? "Reativar meta" : "Arquivar meta"}
          confirmLabel={archive.archived ? "Reativar" : "Arquivar"}
          description={
            archive.archived
              ? `“${archive.name}” volta à lista de metas ativas.`
              : `“${archive.name}” sai da lista de metas ativas, mas continua no histórico.`
          }
          onSubmit={(reason) => {
            const goal = archive;
            workspace.act(
              (ledger) => dom.goals.updateGoal(ledger, { ...goal, archived: !goal.archived }, reason),
              goal.archived ? "reativar meta" : "arquivar meta",
            );
            notify(goal.archived ? "Meta reativada." : "Meta arquivada.");
          }}
        />
      ) : null}
    </div>
  );
}
