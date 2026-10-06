/**
 * The month's report as a print view (`/imprimir/relatorio-mensal?m=2026-10[&membro=id][&imprimir=1]`),
 * outside the shell: the browser prints it ("Salvar como PDF"), and the same report is a file to download.
 * Drawn with React from the same data as the domain's HTML (`report.ts`); the sheet is always light, like
 * paper, whatever the theme of the screen.
 */
import { ymParse, type Id, type YearMonth } from "@opesvault/domain";
import { Button, applyTheme, cn, notify } from "@opesvault/ui";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import { ArrowLeft, FileDown, Printer } from "lucide-react";
import { useEffect, useMemo, useRef } from "react";
import { useLedger, useOptionalWorkspace } from "../../data/react.tsx";
import type { Workspace } from "../../data/workspace.ts";
import { chooseMonth, useSharedMonth } from "../../data/month.ts";
import { useTheme } from "../../theme.tsx";
import { cellText, monthlyReportData, monthlyReportFile, reportFileName, type ReportTable } from "./report.ts";
import { saveTextFile } from "../../data/save_file.ts";
import type { ReportSearch } from "./report_search.ts";

function monthOf(text: string | undefined, fallback: YearMonth): YearMonth {
  if (!text) return fallback;
  try {
    return ymParse(text);
  } catch {
    return fallback;
  }
}

export function ReportTableView({ table }: { table: ReportTable }) {
  return (
    <section className="break-inside-avoid">
      {table.title ? <h2 className="mt-6 mb-2 text-headline font-semibold text-text">{table.title}</h2> : null}
      <table className="w-full border-collapse text-body">
        <caption className="sr-only">{table.title || "Valores"}</caption>
        <thead>
          <tr className="border-b border-secondary">
            {table.headers.map((header, index) => (
              <th
                key={index}
                scope="col"
                className={cn(
                  "px-2 py-1.5 text-caption font-semibold text-secondary first:pl-0 last:pr-0",
                  table.numeric.includes(index) ? "text-right" : "text-left",
                )}
              >
                {header || <span className="sr-only">Item</span>}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {table.rows.length === 0 ? (
            <tr>
              <td colSpan={table.headers.length} className="py-2 text-secondary">
                Nada no período.
              </td>
            </tr>
          ) : (
            table.rows.map((row, rowIndex) => (
              <tr key={rowIndex} className="border-b border-separator break-inside-avoid">
                {row.map((cell, index) => (
                  <td
                    key={index}
                    className={cn(
                      "px-2 py-1.5 align-top first:pl-0 last:pr-0",
                      table.numeric.includes(index) && "text-right whitespace-nowrap tabular-nums",
                    )}
                  >
                    {cellText(cell)}
                  </td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </section>
  );
}

export function MonthlyReportPage() {
  const workspace = useOptionalWorkspace();
  // Locking the project or signing out: nothing is drawn without its project.
  return workspace ? <ReportSheet workspace={workspace} /> : null;
}

function ReportSheet({ workspace }: { workspace: Workspace }) {
  const navigate = useNavigate();
  const { theme } = useTheme();
  const [shared] = useSharedMonth();
  const search = useRouterState({ select: (state) => state.location.search as ReportSearch });
  const month = monthOf(search.m, shared);
  const memberId: Id | null = search.membro ?? null;
  const today = workspace.today();
  const data = useLedger((ledger) => monthlyReportData(ledger, month, today, memberId), `${search.m}|${memberId}`);
  const monthKey = useMemo(() => `${month.year}-${month.month}`, [month]);

  // The sheet is paper: light, whatever the screen's theme.
  useEffect(() => {
    applyTheme("light");
    return () => applyTheme(theme);
  }, [theme]);

  const print = () => {
    if (typeof window.print === "function") window.print();
  };
  // Opened from "Relatório do mês em PDF…": the print dialog comes up once the sheet is drawn.
  const asked = useRef(false);
  useEffect(() => {
    if (search.imprimir !== "1" || asked.current) return;
    asked.current = true;
    const timer = setTimeout(() => {
      print();
      void navigate({
        to: "/imprimir/relatorio-mensal",
        search: { ...(search.m ? { m: search.m } : {}), ...(search.membro ? { membro: search.membro } : {}) },
        replace: true,
      });
    }, 350);
    return () => clearTimeout(timer);
  }, [search.imprimir, search.m, search.membro, navigate]);

  const back = () => {
    chooseMonth(month);
    void navigate({ to: "/visao-geral", search: {} });
  };
  const download = () => {
    const html = monthlyReportFile(workspace.ledger, month, today, memberId);
    saveTextFile(reportFileName(month, "html"), html);
    notify(`Relatório de ${data.monthTitle} salvo como arquivo HTML.`);
  };

  return (
    <div className="min-h-dvh bg-window px-4 py-4 text-text print:min-h-0 print:bg-transparent print:p-0 tablet:px-6">
      <div className="mx-auto mb-4 flex max-w-[820px] flex-wrap items-center justify-between gap-2 print:hidden">
        <Button variant="ghost" icon={<ArrowLeft />} onClick={back}>
          Voltar à Visão geral
        </Button>
        <div className="flex flex-wrap items-center gap-2">
          <Button icon={<FileDown />} onClick={download}>
            Baixar como arquivo HTML
          </Button>
          <Button variant="primary" icon={<Printer />} onClick={print}>
            Imprimir ou salvar em PDF
          </Button>
        </div>
      </div>
      <article
        data-month={monthKey}
        className="mx-auto max-w-[820px] rounded-xl border border-separator bg-raised p-6 shadow-md print:max-w-none print:rounded-none print:border-0 print:p-0 print:shadow-none tablet:p-10"
      >
        <h1 className="text-title font-semibold tracking-[-0.01em] text-text">
          {data.project} — {data.monthTitle}
        </h1>
        <p className="mt-1 text-caption text-secondary">{data.warning}</p>
        {data.member ? (
          <p className="mt-3 text-body">
            Visão de <strong>{data.member}</strong>: lançamentos e rateios atribuídos a este integrante.
          </p>
        ) : null}
        {data.tables.map((table) => (
          <ReportTableView key={table.id} table={table} />
        ))}
        <section className="break-inside-avoid">
          <h2 className="mt-6 mb-2 text-headline font-semibold text-text">Pendências</h2>
          {data.pending.length ? (
            <ul className="list-disc pl-5 text-body">
              {data.pending.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          ) : (
            <p className="text-body">Nenhuma.</p>
          )}
        </section>
      </article>
    </div>
  );
}
