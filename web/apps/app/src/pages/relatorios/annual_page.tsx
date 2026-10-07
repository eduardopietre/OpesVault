/**
 * The year-end closing as a print view (`/imprimir/relatorio-anual?ano=2026[&imprimir=1]`), outside the
 * shell: the browser prints it ("Salvar como PDF"), and the same report is a file to download. Drawn with
 * React from the same data as the domain's HTML (`annual.ts`); the sheet is always light, like paper.
 */
import { formatBrl } from "@opesvault/domain";
import { notify, saveFile, HTML_TYPE } from "@opesvault/ui";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import { chooseMonth, useSharedMonth } from "../../data/month.ts";
import { useLedger, useOptionalWorkspace } from "../../data/react.tsx";
import type { Workspace } from "../../data/workspace.ts";
import { PrintSheet, ReportTableView } from "../../components/print_sheet.tsx";
import { annualFileName, annualReportData, annualReportFile } from "./annual.ts";
import type { AnnualSearch } from "./annual_search.ts";

export function AnnualReportPage() {
  const workspace = useOptionalWorkspace();
  // Locking the project or signing out: nothing is drawn without its project.
  return workspace ? <AnnualSheet workspace={workspace} /> : null;
}

function AnnualSheet({ workspace }: { workspace: Workspace }) {
  const navigate = useNavigate();
  const [shared] = useSharedMonth();
  const search = useRouterState({ select: (state) => state.location.search as AnnualSearch });
  const year = search.ano ? Number(search.ano) : shared.year;
  const data = useLedger((ledger) => annualReportData(ledger, year), year);

  const back = () => {
    chooseMonth({ year, month: shared.year === year ? shared.month : 12 });
    void navigate({ to: "/relatorios", search: { ref: "annual" } });
  };
  const download = () => {
    saveFile(annualFileName(year, "html"), annualReportFile(workspace.ledger, year), HTML_TYPE);
    notify(`Fechamento de ${year} salvo como arquivo HTML.`);
  };

  return (
    <PrintSheet
      backLabel="Voltar aos Relatórios"
      onBack={back}
      onDownload={download}
      autoPrint={search.imprimir === "1"}
      onAutoPrinted={() =>
        void navigate({
          to: "/imprimir/relatorio-anual",
          search: search.ano ? { ano: search.ano } : {},
          replace: true,
        })
      }
      sheet={{ "data-year": String(year) }}
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
    </PrintSheet>
  );
}
