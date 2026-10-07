/**
 * The report for the declaration as a print view (`/imprimir/imposto?ano=2025[&declarante=id][&imprimir=1]`),
 * outside the shell: the browser prints it ("Salvar como PDF"), and the same report is a file to download.
 * Drawn with React from the same data as the domain's HTML (`report.ts`); the sheet is always light, like
 * paper, whatever the theme of the screen. It carries CPFs and CNPJs: it leaves the project's protection only
 * when the person prints or downloads it.
 */
import { cn, notify, saveFile, HTML_TYPE } from "@opesvault/ui";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import { useLedger, useOptionalWorkspace } from "../../data/react.tsx";
import type { Workspace } from "../../data/workspace.ts";
import { cellText, type ReportTable } from "../visao-geral/report.ts";
import { taxReportData, taxReportFile, taxReportFileName, type ReportSection } from "./report.ts";
import type { TaxReportSearch } from "./report_search.ts";
import { PrintSheet, ValuesTable } from "../../components/print_sheet.tsx";

/** On a phone a row is a small card (many columns do not fit); on paper and from the tablet it is the table. */
function Cards({ table }: { table: ReportTable }) {
  if (table.rows.length === 0) return <p className="text-body text-secondary">Nada no período.</p>;
  return (
    <ul className="flex flex-col tablet:hidden print:hidden">
      {table.rows.map((row, rowIndex) => (
        <li key={rowIndex} className="border-b border-separator py-2">
          <dl className="flex flex-col gap-1 text-body">
            {row.map((cell, index) => (
              <div key={index} className="flex items-baseline justify-between gap-3">
                <dt className="w-2/5 shrink-0 text-caption text-secondary [overflow-wrap:anywhere]">
                  {table.headers[index] || "Item"}
                </dt>
                <dd
                  className={cn(
                    "min-w-0 flex-1 text-right [overflow-wrap:anywhere]",
                    table.numeric.includes(index) && "tabular-nums",
                  )}
                >
                  {cellText(cell)}
                </dd>
              </div>
            ))}
          </dl>
        </li>
      ))}
    </ul>
  );
}

function Table({ table }: { table: ReportTable }) {
  return (
    <>
      <Cards table={table} />
      <ValuesTable table={table} className="hidden tablet:table print:table" />
    </>
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
  const search = useRouterState({ select: (state) => state.location.search as TaxReportSearch });
  const today = workspace.today();
  const year = search.ano ? Number(search.ano) : Number(today.slice(0, 4)) - 1;
  const declarant = search.declarante && workspace.ledger.members.has(search.declarante) ? search.declarante : null;
  const data = useLedger((ledger) => taxReportData(ledger, year, today, declarant), `${year}|${declarant}`);

  const back = () => void navigate({ to: "/imposto-de-renda", search: { ref: `year:${year}` } });
  const download = () => {
    const html = taxReportFile(workspace.ledger, year, today, declarant);
    saveFile(taxReportFileName(year, "html"), html, HTML_TYPE);
    notify(`Relatório de ${year} salvo como arquivo HTML.`);
  };

  return (
    <PrintSheet
      backLabel="Voltar ao Imposto de renda"
      onBack={back}
      onDownload={download}
      autoPrint={search.imprimir === "1"}
      onAutoPrinted={() =>
        void navigate({
          to: "/imprimir/imposto",
          search: { ano: String(year), ...(search.declarante ? { declarante: search.declarante } : {}) },
          replace: true,
        })
      }
      sheet={{ "data-year": String(year) }}
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
    </PrintSheet>
  );
}
