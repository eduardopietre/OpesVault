/**
 * The report for the declaration as a print view (`/imprimir/imposto?ano=2025[&declarante=id][&imprimir=1]`),
 * outside the shell: the browser prints it ("Salvar como PDF"), and the same report is a file to download.
 * Drawn with React from the same data as the domain's HTML (`report.ts`); the sheet is always light, like
 * paper, whatever the theme of the screen. It carries CPFs and CNPJs: it leaves the project's protection only
 * when the person prints or downloads it.
 */
import { Button, applyTheme, cn, notify } from "@opesvault/ui";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import { ArrowLeft, FileDown, Printer } from "lucide-react";
import { useEffect, useRef } from "react";
import { useLedger, useOptionalWorkspace } from "../../data/react.tsx";
import type { Workspace } from "../../data/workspace.ts";
import { useTheme } from "../../theme.tsx";
import { cellText, type ReportTable } from "../visao-geral/report.ts";
import { saveTextFile } from "../visao-geral/save_file.ts";
import { taxReportData, taxReportFile, taxReportFileName, type ReportSection } from "./report.ts";
import type { TaxReportSearch } from "./report_search.ts";

function Table({ table }: { table: ReportTable }) {
  return (
    <table className="w-full border-collapse text-body">
      <caption className="sr-only">{table.title}</caption>
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
  );
}

function Section({ section }: { section: ReportSection }) {
  return (
    <section className="break-inside-avoid-page" data-section={section.id}>
      <h2 className="mt-6 mb-2 text-headline font-semibold text-text">{section.title}</h2>
      {section.note ? <p className="mb-2 text-caption text-secondary">{section.note}</p> : null}
      {section.text ? <p className="text-body">{section.text}</p> : null}
      {section.table ? <Table table={section.table} /> : null}
      {section.items ? (
        <ul className="list-disc pl-5 text-body">
          {section.items.map((item, index) => (
            <li key={index}>{item}</li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

export function TaxReportPage() {
  const workspace = useOptionalWorkspace();
  // Locking the project or signing out: nothing is drawn without its project.
  return workspace ? <ReportSheet workspace={workspace} /> : null;
}

function ReportSheet({ workspace }: { workspace: Workspace }) {
  const navigate = useNavigate();
  const { theme } = useTheme();
  const search = useRouterState({ select: (state) => state.location.search as TaxReportSearch });
  const today = workspace.today();
  const year = search.ano ? Number(search.ano) : Number(today.slice(0, 4)) - 1;
  const declarant = search.declarante && workspace.ledger.members.has(search.declarante) ? search.declarante : null;
  const data = useLedger((ledger) => taxReportData(ledger, year, today, declarant), `${year}|${declarant}`);

  // The sheet is paper: light, whatever the screen's theme.
  useEffect(() => {
    applyTheme("light");
    return () => applyTheme(theme);
  }, [theme]);

  const print = () => {
    if (typeof window.print === "function") window.print();
  };
  // Opened from "Mais › Relatório para a declaração (PDF)…": the print dialog comes up once the sheet is drawn.
  const asked = useRef(false);
  useEffect(() => {
    if (search.imprimir !== "1" || asked.current) return;
    asked.current = true;
    const timer = setTimeout(() => {
      print();
      void navigate({
        to: "/imprimir/imposto",
        search: { ano: String(year), ...(search.declarante ? { declarante: search.declarante } : {}) },
        replace: true,
      });
    }, 350);
    return () => clearTimeout(timer);
  }, [search.imprimir, search.declarante, year, navigate]);

  const back = () => void navigate({ to: "/imposto-de-renda", search: { ref: `year:${year}` } });
  const download = () => {
    const html = taxReportFile(workspace.ledger, year, today, declarant);
    saveTextFile(taxReportFileName(year, "html"), html);
    notify(`Relatório de ${year} salvo como arquivo HTML.`);
  };

  return (
    <div className="min-h-dvh bg-window px-4 py-4 text-text print:min-h-0 print:bg-transparent print:p-0 tablet:px-6">
      <div className="mx-auto mb-4 flex max-w-[820px] flex-wrap items-center justify-between gap-2 print:hidden">
        <Button variant="ghost" icon={<ArrowLeft />} onClick={back}>
          Voltar ao Imposto de renda
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
        className="mx-auto max-w-[820px] rounded-xl border border-separator bg-raised p-6 shadow-md print:max-w-none print:rounded-none print:border-0 print:p-0 print:shadow-none tablet:p-10"
      >
        <h1 className="text-title font-semibold tracking-[-0.01em] text-text">
          {data.project} — imposto de renda, ano-calendário {data.year}
        </h1>
        <p className="mt-2 text-body">
          Declarante: <strong>{data.who}</strong>
        </p>
        <p className="mt-1 text-caption text-secondary">
          {data.warning} {data.notice}
        </p>
        {data.cpf !== null ? <p className="mt-3 text-body">CPF: {data.cpf}</p> : null}
        {data.sections.map((section) => (
          <Section key={section.id} section={section} />
        ))}
      </article>
    </div>
  );
}
