/**
 * Visão geral: the month at a glance (desktop `ui/pages/overview_page.py` and `ui/alerts_panel.py`).
 * What needs attention leads (every notice goes to the place and action where it is solved), then cash,
 * competence result and net worth, the accounts and the spending, the indicators, the comparison with
 * previous months and the months side by side. The month can be closed (with a reason when items are
 * pending) and reopened (always with a reason); the report of the month is printed from here.
 */
import { charts, dom, formatDateBr, newId, ymAdd, ymLastDay, ymStr, type Id, type YearMonth } from "@opesvault/domain";
import {
  Adaptive,
  Button,
  ChartPanel,
  Collapsible,
  MonthPicker,
  PageHeader,
  Section,
  Select,
  formatMonth,
  menuButton,
  useMotionPreset,
  usePreferences,
  type SelectOption,
} from "@opesvault/ui";
import { useNavigate } from "@tanstack/react-router";
import { AnimatePresence, motion } from "motion/react";
import { CalendarCheck, Lock, LockOpen } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { toChartData } from "../../data/chart_data.ts";
import { filterRef, type Link } from "../../data/links.ts";
import { chooseMonth, useSharedMonth } from "../../data/month.ts";
import { useGoTo } from "../../data/navigation.ts";
import { useAct, useLedger, useWorkspace } from "../../data/react.tsx";
import type { Workspace } from "../../data/workspace.ts";
import { OverviewReasonDialog } from "../../dialogs/overview_reason.tsx";
import { AlertsPanel } from "./alerts_panel.tsx";
import { FigureCard, Money, toneOf } from "./figures.tsx";
import {
  SUMMARY_MONTHS,
  balanceRows,
  categoryRows,
  comparisonRows,
  indicatorRows,
  latestActivityMonth,
  monthFigures,
} from "./rows.ts";
import { BalancesTable, CategoriesTable, ComparisonTable } from "./tables.tsx";

/** The device preference holding the opening in which the panel was hidden. */
export const ALERTS_HIDDEN_KEY = "visao-geral/avisos-ocultos";

/** Each opening of the project is one "next opening": the panel hidden in one comes back in the next. */
const openings = new WeakMap<Workspace, string>();
function openingOf(workspace: Workspace): string {
  let token = openings.get(workspace);
  if (token === undefined) {
    token = newId();
    openings.set(workspace, token);
  }
  return token;
}

/** The months already placed on the latest activity (once per opening, so a month the user picks stays). */
const placed = new WeakSet<Workspace>();

const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** What blocks closing the month: a notice of the domain, with the place where it is solved when there is one. */
function pendingLink(item: string): Link | null {
  if (item.includes("importado")) return { page: "importar", label: "Revisar" };
  if (item.includes("previsão") || item.includes("previsões")) return { page: "recorrencias", label: "Ver previsões" };
  return null;
}

export function Page() {
  const workspace = useWorkspace();
  const act = useAct();
  const go = useGoTo();
  const navigate = useNavigate();
  const preferences = usePreferences();
  const preset = useMotionPreset();
  const [month, setMonth] = useSharedMonth();
  const [memberId, setMemberId] = useState<Id | null>(null);
  const [dialog, setDialog] = useState<"close" | "reopen" | null>(null);
  const today = workspace.today();
  const monthKey = ymStr(month);
  const readOnlyHint = "Este projeto está aberto só para leitura: outra aba ou aparelho está editando.";

  // Opens on the latest month with activity, not on an empty current month (once per opening).
  useEffect(() => {
    if (placed.has(workspace)) return;
    placed.add(workspace);
    const latest = latestActivityMonth(workspace.ledger, today);
    if (latest) chooseMonth(latest);
  }, [workspace, today]);

  const members = useLedger((ledger) => [...ledger.members.values()].filter((m) => m.active), "members");
  const memberOptions = useMemo<SelectOption[]>(
    () => [{ id: "", label: "Projeto inteiro" }, ...members.map((m) => ({ id: m.id, label: m.name }))],
    [members],
  );
  const memberValid = memberId !== null && members.some((m) => m.id === memberId) ? memberId : null;

  const key = `${monthKey}|${memberValid ?? ""}`;
  const alerts = useLedger((ledger) => dom.alerts.alerts(ledger, today), today);
  const figures = useLedger((ledger) => monthFigures(ledger, month, memberValid), key);
  const balances = useLedger((ledger) => balanceRows(ledger, month, memberValid), key);
  const categories = useLedger((ledger) => categoryRows(ledger, month, memberValid), key);
  const comparison = useLedger((ledger) => comparisonRows(ledger, month), monthKey);
  const indicators = useLedger((ledger) => indicatorRows(ledger, month), monthKey);
  const closed = useLedger((ledger) => dom.periods.isClosed(ledger, month), monthKey);
  const pending = useLedger((ledger) => dom.periods.pendingItems(ledger, month), monthKey);
  const chart = useLedger(
    (ledger) => toChartData(charts.data.monthlySummary(ledger, ymAdd(month, -(SUMMARY_MONTHS - 1)), month)),
    monthKey,
  );

  // The attention panel, hidden until the project is opened again.
  const opening = openingOf(workspace);
  const [hidden, setHidden] = useState(() => preferences.get(ALERTS_HIDDEN_KEY) === opening);
  const hide = () => {
    preferences.set(ALERTS_HIDDEN_KEY, opening);
    setHidden(true);
  };
  const show = () => {
    preferences.set(ALERTS_HIDDEN_KEY, null);
    setHidden(false);
  };

  const monthName = capitalize(formatMonth(month));
  const openOperations = (accountId: string) => go("livro", { ref: filterRef(accountId, month, memberValid) });
  const goLink = (link: Link) =>
    go(link.page, { ...(link.ref ? { ref: link.ref } : {}), ...(link.act ? { act: link.act } : {}) });

  const closeMonth = (note: string | null) =>
    act((ledger) => dom.periods.closeMonth(ledger, month, note), `${monthName} fechado.`);
  const reopenMonth = (reason: string) =>
    act((ledger) => dom.periods.reopenMonth(ledger, month, reason), `${monthName} reaberto.`);
  const askClose = () => {
    if (pending.length) setDialog("close");
    else closeMonth(null);
  };

  const printReport = () =>
    void navigate({
      to: "/imprimir/relatorio-mensal",
      search: { m: monthKey, ...(memberValid ? { membro: memberValid } : {}), imprimir: "1" },
    });

  const readOnly = workspace.readOnly;
  const showAlerts = alerts.length > 0 && !hidden;
  const hiddenNote = alerts.length > 0 && hidden;
  const railEmpty = !showAlerts && !hiddenNote && pending.length === 0;
  const whose = memberValid === null ? "de todas as contas" : "das contas de que é titular (conjuntas inteiras)";

  const rail = (
    <div className="flex min-w-0 flex-col gap-6">
      <AnimatePresence initial={false}>
        {showAlerts ? (
          <motion.div key="alerts" {...preset.enter} layout="position">
            <AlertsPanel alerts={alerts} onGo={goLink} onHide={hide} />
          </motion.div>
        ) : null}
        {hiddenNote ? (
          <motion.p
            key="hidden"
            {...preset.enter}
            className="flex flex-wrap items-center gap-2 text-body text-secondary"
          >
            {alerts.length} {alerts.length === 1 ? "aviso oculto" : "avisos ocultos"} até a próxima abertura.
            <Button size="sm" variant="ghost" onClick={show}>
              Mostrar avisos
            </Button>
          </motion.p>
        ) : null}
      </AnimatePresence>
      {pending.length ? (
        <motion.section
          {...preset.enter}
          aria-label="Antes de fechar o mês"
          className="min-w-0 rounded-xl border border-separator bg-raised p-4 shadow-sm"
        >
          <h2 className="flex items-center gap-2 text-headline font-semibold text-text">
            <CalendarCheck aria-hidden="true" className="size-4 text-warning" />
            Antes de fechar o mês
          </h2>
          <p className="mt-0.5 text-caption text-secondary">
            Resolva, ou feche com uma justificativa que fica no histórico.
          </p>
          <ul className="mt-3 flex flex-col gap-2">
            {pending.map((item) => {
              const link = pendingLink(item);
              return (
                <li key={item} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                  <span className="min-w-0 text-body text-warning">{item}</span>
                  {link ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-label={`${link.label}: ${item}`}
                      onClick={() => goLink(link)}
                    >
                      {link.label}
                    </Button>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </motion.section>
      ) : null}
    </div>
  );

  const main = (
    <div className="flex min-w-0 flex-col gap-6">
      <Adaptive at={720} columns="1fr 1fr" gap={24}>
        <FigureCard
          index={0}
          title="Caixa"
          caption="O que entrou e saiu das contas. Transferências entre contas próprias não contam."
          figures={[
            { label: "Entradas", value: <Money value={figures.inflow} /> },
            { label: "Saídas", value: <Money value={figures.outflow} /> },
            { label: "Saldo do mês", value: <Money value={figures.net} />, tone: toneOf(figures.net) },
          ]}
        />
        <FigureCard
          index={1}
          title="Resultado por competência"
          caption="Despesas no mês em que aconteceram, inclusive no cartão."
          figures={[
            { label: "Receitas", value: <Money value={figures.income} /> },
            { label: "Despesas", value: <Money value={figures.expense} /> },
            { label: "Resultado", value: <Money value={figures.result} />, tone: toneOf(figures.result) },
          ]}
        />
      </Adaptive>
      <FigureCard
        index={2}
        title="Patrimônio no fim do mês"
        caption={`Saldos ${whose} em ${formatDateBr(ymLastDay(month))}.`}
        figures={[
          { label: "Ativos", value: <Money value={figures.assets} /> },
          { label: "Passivos", value: <Money value={figures.liabilities} /> },
          { label: "Patrimônio líquido", value: <Money value={figures.worth} />, tone: toneOf(figures.worth) },
        ]}
      />
      <Adaptive at={720} columns="1fr 1fr" gap={24}>
        <Section title="Saldos das contas">
          <BalancesTable rows={balances} onOpen={openOperations} />
        </Section>
        <Section title="Despesas por categoria">
          <CategoriesTable rows={categories} onOpen={openOperations} />
        </Section>
      </Adaptive>
      <Collapsible title="Indicadores" prefKey="visao-geral/indicadores">
        <dl className="grid grid-cols-[repeat(auto-fit,minmax(13rem,1fr))] gap-x-6 gap-y-4">
          {indicators.map((indicator) => (
            <div key={indicator.key} className="min-w-0">
              <dt className="text-caption text-secondary">{indicator.label}</dt>
              <dd
                className={`mt-1 text-figure font-semibold tracking-[-0.02em] ${indicator.negative ? "text-negative" : "text-text"}`}
              >
                {indicator.text}
              </dd>
              <dd className="mt-0.5 text-caption text-secondary">{indicator.detail}</dd>
            </div>
          ))}
        </dl>
      </Collapsible>
      <Collapsible
        title="Comparado aos meses anteriores"
        prefKey="visao-geral/comparacao"
        description="Competência. Meses antes do início dos registros não entram na média. Abaixo dos totais, as categorias que mais subiram."
        actions={
          <Button size="sm" variant="ghost" onClick={() => go("relatorios", { ref: "comparison" })}>
            Comparação completa
          </Button>
        }
      >
        <ComparisonTable rows={comparison} onOpen={openOperations} />
      </Collapsible>
    </div>
  );

  const readOnlyWrap = (button: ReactNode) =>
    readOnly ? (
      <span title={readOnlyHint} className="inline-flex">
        {button}
      </span>
    ) : (
      button
    );

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Visão geral"
        context={closed ? "Mês fechado" : "Mês aberto"}
        actions={
          <>
            {menuButton("Mais", [
              { id: "report", label: "Relatório do mês em PDF…", onSelect: printReport },
              {
                id: "comparison",
                label: "Comparação completa (Relatórios)",
                onSelect: () => go("relatorios", { ref: "comparison" }),
              },
            ])}
            {closed
              ? readOnlyWrap(
                  <Button icon={<LockOpen />} disabled={readOnly} onClick={() => setDialog("reopen")}>
                    Reabrir mês…
                  </Button>,
                )
              : null}
          </>
        }
        primary={
          closed
            ? undefined
            : readOnlyWrap(
                <Button variant="primary" icon={<Lock />} disabled={readOnly} onClick={askClose}>
                  Fechar mês…
                </Button>,
              )
        }
      >
        {members.length > 1 ? (
          <div className="w-44">
            <Select
              label="Visão de"
              hideLabel
              options={memberOptions}
              value={memberValid ?? ""}
              onChange={(id) => setMemberId(id === "" ? null : id)}
            />
          </div>
        ) : null}
        <MonthPicker value={month} onChange={(next: YearMonth) => setMonth(next)} />
      </PageHeader>

      {railEmpty ? (
        main
      ) : (
        <Adaptive at={1300} columns="5fr 2fr" firstRight gap={32}>
          {rail}
          {main}
        </Adaptive>
      )}
      {/* The months side by side use the whole width: seven columns of values need the room. */}
      <ChartPanel chart={chart} prefKey="visao-geral/meses" height={280} columns="1fr 1fr" at={1400} />

      <OverviewReasonDialog
        open={dialog === "close"}
        onOpenChange={(open) => setDialog(open ? "close" : null)}
        title="Fechar com pendências"
        description={
          <>
            <span className="block">{monthName} ainda tem:</span>
            <ul className="mt-1 list-disc pl-5">
              {pending.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </>
        }
        label="Justificativa (fica no histórico)"
        confirmLabel="Fechar mês"
        onConfirm={(reason) => closeMonth(reason)}
      />
      <OverviewReasonDialog
        open={dialog === "reopen"}
        onOpenChange={(open) => setDialog(open ? "reopen" : null)}
        title="Reabrir mês"
        description={`${monthName} volta a aceitar alterações.`}
        label="Motivo (fica no histórico)"
        confirmLabel="Reabrir mês"
        onConfirm={reopenMonth}
      />
    </div>
  );
}
