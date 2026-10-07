/**
 * The year-end closing as a print view (`/imprimir/relatorio-anual?ano=2026[&imprimir=1]`), outside the
 * shell: the browser prints it ("Salvar como PDF"), and the same report is a file to download. Drawn with
 * React from the same data as the domain's HTML (`annual.ts`); the sheet is always light, like paper.
 */
import { formatBrl } from "@opesvault/domain";
import { Button, applyTheme, notify, saveFile, HTML_TYPE } from "@opesvault/ui";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import { ArrowLeft, FileDown, Printer } from "lucide-react";
import { useEffect, useRef } from "react";
import { chooseMonth, useSharedMonth } from "../../data/month.ts";
import { useLedger, useOptionalWorkspace } from "../../data/react.tsx";
import type { Workspace } from "../../data/workspace.ts";
import { useTheme } from "../../theme.tsx";
import { ReportTableView } from "../visao-geral/report_page.tsx";
import { annualFileName, annualReportData, annualReportFile } from "./annual.ts";
import type { AnnualSearch } from "./annual_search.ts";

export function AnnualReportPage() {
  const workspace = useOptionalWorkspace();
  // Locking the project or signing out: nothing is drawn without its project.
  return workspace ? <AnnualSheet workspace={workspace} /> : null;
}

function AnnualSheet({ workspace }: { workspace: Workspace }) {
  const navigate = useNavigate();
  const { theme } = useTheme();
  const [shared] = useSharedMonth();
  const search = useRouterState({ select: (state) => state.location.search as AnnualSearch });
  const year = search.ano ? Number(search.ano) : shared.year;
  const data = useLedger((ledger) => annualReportData(ledger, year), year);

  // The sheet is paper: light, whatever the screen's theme.
  useEffect(() => {
    applyTheme("light");
    return () => applyTheme(theme);
  }, [theme]);

  const print = () => {
    if (typeof window.print === "function") window.print();
  };
  // Opened from "Relatório anual (PDF)…": the print dialog comes up once the sheet is drawn.
  const asked = useRef(false);
  useEffect(() => {
    if (search.imprimir !== "1" || asked.current) return;
    asked.current = true;
    const timer = setTimeout(() => {
      print();
      void navigate({
        to: "/imprimir/relatorio-anual",
        search: search.ano ? { ano: search.ano } : {},
        replace: true,
      });
    }, 350);
    return () => clearTimeout(timer);
  }, [search.imprimir, search.ano, navigate]);

  const back = () => {
    chooseMonth({ year, month: shared.year === year ? shared.month : 12 });
    void navigate({ to: "/relatorios", search: { ref: "annual" } });
  };
  const download = () => {
    saveFile(annualFileName(year, "html"), annualReportFile(workspace.ledger, year), HTML_TYPE);
    notify(`Fechamento de ${year} salvo como arquivo HTML.`);
  };

  return (
    <div className="min-h-dvh bg-window px-2 py-4 text-text min-[480px]:px-4 print:min-h-0 print:bg-transparent print:p-0 tablet:px-6">
      <div className="mx-auto mb-4 flex max-w-[820px] flex-wrap items-center justify-between gap-2 print:hidden">
        <Button variant="ghost" icon={<ArrowLeft />} onClick={back}>
          Voltar aos Relatórios
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
        data-year={year}
        className="mx-auto max-w-[820px] rounded-xl border border-separator bg-raised p-4 shadow-md min-[480px]:p-6 print:max-w-none print:rounded-none print:border-0 print:p-0 print:shadow-none tablet:p-10"
      >
        <h1 className="text-title font-semibold tracking-[-0.01em] text-text">
          {data.project} — fechamento de {data.year}
        </h1>
        <p className="mt-1 text-caption text-secondary">
          {data.warning} {data.notice}
        </p>
        <ReportTableView table={data.balances} />
        <p className="mt-3 text-body">
          Patrimônio líquido em 31/12/{data.year}: <strong>{formatBrl(data.netWorth)}</strong>
        </p>
        <ReportTableView table={data.income} />
        <ReportTableView table={data.investments} />
        {data.incomplete ? <p className="mt-2 text-caption text-secondary">{data.incomplete}</p> : null}
        <section>
          <h2 className="mt-6 mb-2 text-headline font-semibold text-text">Despesas dedutíveis</h2>
          <p className="mb-2 text-caption text-secondary">{data.deductibleNotice}</p>
          {data.deductibles.length === 0 ? <p className="text-body">Nenhuma despesa dedutível no ano.</p> : null}
          {data.deductibles.map((group) => (
            <div key={group.table.id} className="mt-3">
              <p className="text-body font-semibold">
                {group.title}: {formatBrl(group.total)}
              </p>
              <ReportTableView table={group.table} />
            </div>
          ))}
        </section>
      </article>
    </div>
  );
}
