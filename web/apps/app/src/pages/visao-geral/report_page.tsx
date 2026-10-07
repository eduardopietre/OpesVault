/**
 * The month's report as a print view (`/imprimir/relatorio-mensal?m=2026-10[&membro=id][&imprimir=1]`),
 * outside the shell: the browser prints it ("Salvar como PDF"), and the same report is a file to download.
 * Drawn with React from the same data as the domain's HTML (`report.ts`); the sheet is always light, like
 * paper, whatever the theme of the screen.
 */
import { ymParse, type Id, type YearMonth } from "@opesvault/domain";
import { notify, saveFile, HTML_TYPE } from "@opesvault/ui";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import { useMemo } from "react";
import { useLedger, useOptionalWorkspace } from "../../data/react.tsx";
import type { Workspace } from "../../data/workspace.ts";
import { chooseMonth, useSharedMonth } from "../../data/month.ts";
import { monthlyReportData, monthlyReportFile, reportFileName } from "./report.ts";
import type { ReportSearch } from "./report_search.ts";
import { PrintSheet, ReportTableView } from "../../components/print_sheet.tsx";

function monthOf(text: string | undefined, fallback: YearMonth): YearMonth {
  if (!text) return fallback;
  try {
    return ymParse(text);
  } catch {
    return fallback;
  }
}

export function MonthlyReportPage() {
  const workspace = useOptionalWorkspace();
  // Locking the project or signing out: nothing is drawn without its project.
  return workspace ? <ReportSheet workspace={workspace} /> : null;
}

function ReportSheet({ workspace }: { workspace: Workspace }) {
  const navigate = useNavigate();
  const [shared] = useSharedMonth();
  const search = useRouterState({ select: (state) => state.location.search as ReportSearch });
  const month = monthOf(search.m, shared);
  const memberId: Id | null = search.membro ?? null;
  const today = workspace.today();
  const data = useLedger((ledger) => monthlyReportData(ledger, month, today, memberId), `${search.m}|${memberId}`);
  const monthKey = useMemo(() => `${month.year}-${month.month}`, [month]);

  const back = () => {
    chooseMonth(month);
    void navigate({ to: "/visao-geral", search: {} });
  };
  const download = () => {
    const html = monthlyReportFile(workspace.ledger, month, today, memberId);
    saveFile(reportFileName(month, "html"), html, HTML_TYPE);
    notify(`Relatório de ${data.monthTitle} salvo como arquivo HTML.`);
  };

  return (
    <PrintSheet
      backLabel="Voltar à Visão geral"
      onBack={back}
      onDownload={download}
      autoPrint={search.imprimir === "1"}
      onAutoPrinted={() =>
        void navigate({
          to: "/imprimir/relatorio-mensal",
          search: { ...(search.m ? { m: search.m } : {}), ...(search.membro ? { membro: search.membro } : {}) },
          replace: true,
        })
      }
      sheet={{ "data-month": monthKey }}
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
    </PrintSheet>
  );
}
