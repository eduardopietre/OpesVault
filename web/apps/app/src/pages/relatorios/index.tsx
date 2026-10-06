/**
 * Relatórios (desktop `ui/pages/reports_page.py` and `ui/chart_panel.py`): the required charts of docs/07 §4,
 * each with the table of its values in the same page, their filters, the origin of a chosen point
 * ("Ver lançamentos" in the Livro), the image of the chart and the year-end closing as a printable report.
 *
 * A link from another page opens a report by key (`ref`): see `reports.ts`.
 */
import { ymAdd, ymOf, ymStr, type YearMonth } from "@opesvault/domain";
import {
  Button,
  ChartPanel,
  EmptyState,
  MonthPicker,
  PageHeader,
  Select,
  confirm,
  notify,
  useMediaQuery,
  useMotionPreset,
} from "@opesvault/ui";
import { useNavigate } from "@tanstack/react-router";
import { Download, FileText, ImageDown, ListTree } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useMemo, useRef, useState } from "react";
import { toChartData } from "../../data/chart_data.ts";
import { useSharedMonth } from "../../data/month.ts";
import { useGoTo, useReveal } from "../../data/navigation.ts";
import { useLedger, useWorkspace } from "../../data/react.tsx";
import { downloadFile } from "../livro/export.ts";
import { ReportList } from "./report_list.tsx";
import {
  DEFAULT_PERIOD,
  HINT,
  MONTHLY,
  PERIODS,
  REPORTS,
  SCOPES,
  buildChart,
  csvFileName,
  firstColumnTitle,
  inspect,
  isEmpty,
  isReportKey,
  ledgerRef,
  scopeChoices,
  subtitle,
  valuesCsv,
  type Params,
  type ReportKey,
} from "./reports.ts";

/** Reports that do not read the shared month (they start today or look at everything). */
const WITHOUT_MONTH: ReadonlySet<ReportKey> = new Set(["composition", "tags", "projected_balance"]);

const EMPTY_TEXT =
  "Nada registrado para este relatório, com o período e os filtros escolhidos. Os lançamentos, as contas e os planos do projeto alimentam os gráficos.";

export function Page() {
  const workspace = useWorkspace();
  const goTo = useGoTo();
  const navigate = useNavigate();
  const preset = useMotionPreset();
  const wide = useMediaQuery("(min-width: 1024px)");
  const [month, chooseMonth] = useSharedMonth();
  const [key, setKey] = useState<ReportKey>("in_out");
  const [months, setMonths] = useState(DEFAULT_PERIOD);
  const [scope, setScope] = useState<string | null>(null);
  const [picked, setPicked] = useState<{ chart: object; index: number } | null>(null);
  const exportImage = useRef<(() => boolean) | null>(null);
  const detail = useRef<HTMLDivElement>(null);

  const today = workspace.today();
  const monthKey = ymStr(month);
  const params: Params = { end: month, months, scope, today };

  const choices = useLedger((ledger) => scopeChoices(ledger, key, month), `${key}|${monthKey}`);
  const chart = useLedger(
    (ledger) => buildChart(ledger, key, params),
    `${key}|${monthKey}|${months}|${scope}|${today}`,
  );
  const data = useMemo(() => toChartData(chart), [chart]);
  const empty = isEmpty(chart);
  const shown = picked && picked.chart === chart ? inspect(chart, picked.index) : null;
  const link = picked && picked.chart === chart ? ledgerRef(workspace.ledger, key, chart, picked.index, params) : null;
  const scopeValue = choices && choices.options.some((o) => o.id === scope) ? scope : (choices?.fallback ?? null);

  const selectReport = (next: ReportKey) => {
    setKey(next);
    setScope(null);
    setPicked(null);
  };
  const onMonth = (next: YearMonth) => {
    chooseMonth({ year: next.year, month: next.month });
    // the year of the closing and of the deductibles follows the month
    if (SCOPES[key] === "year") setScope(null);
  };

  // A link from another page: the report by its key, brought into view.
  useReveal((ref) => {
    if (!isReportKey(ref)) return;
    selectReport(ref);
    requestAnimationFrame(() => detail.current?.scrollIntoView({ block: "start", behavior: "smooth" }));
  });

  const seeOperations = () => {
    if (link) goTo("livro", { ref: link });
  };

  const askImage = async () => {
    if (empty) return;
    const ok = await confirm({
      title: "Exportar imagem sem criptografia?",
      text: "A imagem será gravada fora do projeto, na pasta de downloads deste aparelho, sem criptografia.",
      confirmLabel: "Exportar",
    });
    if (!ok) return;
    if (exportImage.current?.()) notify("Imagem do gráfico gerada. Guarde-a com cuidado: ela não é cifrada.");
    else notify("Abra a seção do gráfico para exportar a imagem.");
  };

  const askValues = async () => {
    if (empty) return;
    const ok = await confirm({
      title: "Exportar valores sem criptografia?",
      text: "O arquivo CSV será gravado fora do projeto, na pasta de downloads deste aparelho, sem criptografia.",
      confirmLabel: "Exportar",
    });
    if (!ok) return;
    downloadFile(csvFileName(key), new TextEncoder().encode(valuesCsv(chart)), "text/csv;charset=utf-8");
    notify("Arquivo CSV gerado. Guarde-o com cuidado: ele não é cifrado.");
  };

  const year = Number((scopeValue && SCOPES[key] === "year" ? scopeValue : null) ?? month.year);
  const printYear = () =>
    void navigate({ to: "/imprimir/relatorio-anual", search: { ano: String(year), imprimir: "1" } });

  const label = REPORTS.find((report) => report.key === key)?.label ?? "";
  const maxMonth = ymAdd(ymOf(today), 12);

  const filters = (
    <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Filtros do relatório">
      {choices ? (
        <Select
          label={choices.label}
          hideLabel
          className="w-full tablet:w-56"
          options={choices.options}
          value={scopeValue}
          onChange={(id) => {
            setScope(id);
            setPicked(null);
          }}
        />
      ) : null}
      {MONTHLY.has(key) ? (
        <Select
          label="Período"
          hideLabel
          className="w-full tablet:w-48"
          options={PERIODS}
          value={String(months)}
          onChange={(id) => {
            setMonths(Number(id));
            setPicked(null);
          }}
        />
      ) : null}
    </div>
  );

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Relatórios"
        context={subtitle(key, params) || label}
        {...(key === "annual"
          ? {
              primary: (
                <Button
                  variant="primary"
                  icon={<FileText />}
                  onClick={printYear}
                  title="Material de apoio à declaração"
                >
                  Relatório anual (PDF)…
                </Button>
              ),
            }
          : {})}
        actions={
          <Button icon={<ImageDown />} onClick={() => void askImage()} disabled={empty}>
            Exportar imagem…
          </Button>
        }
      >
        {WITHOUT_MONTH.has(key) ? null : (
          <MonthPicker value={month} onChange={onMonth} max={{ year: maxMonth.year, month: maxMonth.month }} />
        )}
      </PageHeader>

      <div className={`grid min-w-0 gap-6 ${wide ? "grid-cols-[14rem_minmax(0,1fr)]" : "grid-cols-1"}`}>
        {wide ? (
          <ReportList reports={REPORTS} current={key} onChoose={selectReport} />
        ) : (
          <Select
            label="Relatório"
            options={REPORTS.map((report) => ({ id: report.key, label: report.label }))}
            value={key}
            onChange={(id) => isReportKey(id) && selectReport(id)}
          />
        )}

        <div ref={detail} className="flex min-w-0 scroll-mt-4 flex-col gap-4">
          {choices !== null || MONTHLY.has(key) ? filters : null}

          <div className="flex flex-wrap items-start gap-3 rounded-xl border border-separator bg-raised px-4 py-3">
            <div
              className="min-w-0 flex-1 basis-60"
              aria-live="polite"
              aria-label="Dados do ponto selecionado"
              role="group"
            >
              <AnimatePresence initial={false} mode="wait">
                {shown ? (
                  <motion.div key={`${key}-${picked?.index}`} {...preset.enter} className="text-body">
                    <p className="font-semibold">{shown.title}</p>
                    {shown.values.map((line) => (
                      <p key={line} className="tabular-nums">
                        {line}
                      </p>
                    ))}
                    {shown.details.map((line) => (
                      <p key={line} className="text-caption text-secondary">
                        {line}
                      </p>
                    ))}
                  </motion.div>
                ) : (
                  <motion.p key="hint" {...preset.enter} className="text-caption text-secondary">
                    {HINT}
                  </motion.p>
                )}
              </AnimatePresence>
            </div>
            <Button
              icon={<ListTree />}
              onClick={seeOperations}
              disabled={link === null}
              title="Os lançamentos por trás do ponto, no Livro financeiro"
            >
              Ver lançamentos
            </Button>
          </div>

          {empty ? (
            <div className="rounded-xl border border-dashed border-separator-strong bg-window/40">
              <EmptyState title="Sem dados neste relatório" description={EMPTY_TEXT} />
            </div>
          ) : (
            <motion.div key={key} {...preset.enter}>
              <ChartPanel
                chart={data}
                prefKey={`relatorios/${key}`}
                height={320}
                firstColumn={firstColumnTitle(chart)}
                exportRef={exportImage}
                onSelect={(index) => setPicked(index === null ? null : { chart, index })}
                valuesActions={
                  <Button
                    size="sm"
                    variant="ghost"
                    icon={<Download className="size-4" />}
                    onClick={() => void askValues()}
                    title="Grava a tabela em CSV, fora do projeto"
                  >
                    Exportar valores…
                  </Button>
                }
              />
            </motion.div>
          )}
        </div>
      </div>
    </div>
  );
}
