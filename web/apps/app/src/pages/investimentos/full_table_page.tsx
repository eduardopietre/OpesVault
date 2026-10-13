/**
 * Investimentos › Tabela completa as a print view (`/imprimir/investimentos[?imprimir=1]`), outside the shell:
 * every investment and savings account with all its figures (`full_table.ts`), to read, print ("Salvar como
 * PDF", in landscape) or save as CSV. The yearly rates are solved in the worker one investment at a time; the
 * table shows "calculando…" meanwhile, and the print dialog asked for by the address waits for them.
 */
import { formatDateBr, type Dec, type Id } from "@opesvault/domain";
import { CSV_TYPE, saveFile } from "@opesvault/ui";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { exportUnencrypted } from "../../data/export_file.ts";
import { useLedger, useOptionalWorkspace } from "../../data/react.tsx";
import { plural } from "../../data/text.ts";
import type { Workspace } from "../../data/workspace.ts";
import { PrintSheet, ValuesTable } from "../../components/print_sheet.tsx";
import { fullCsv, fullRows, fullTable, type FullRow, type Rates } from "./full_table.ts";
import type { FullTableSearch } from "./full_table_search.ts";
import { solveXirr } from "./xirr_client.ts";

export function FullTablePage() {
  const workspace = useOptionalWorkspace();
  // Locking the project or signing out: nothing is drawn without its project.
  return workspace ? <FullTableSheet workspace={workspace} /> : null;
}

/** The yearly rate of every row that has one, solved one after the other; the map grows as answers come. */
function useRates(rows: readonly FullRow[]): { rates: Rates; done: boolean } {
  const [state, setState] = useState<{ rows: readonly FullRow[]; rates: Map<Id, Dec | null> }>(() => ({
    rows,
    rates: new Map(),
  }));
  useEffect(() => {
    let live = true;
    void (async () => {
      const found = new Map<Id, Dec | null>();
      for (const row of rows) {
        const plan = row.xirr;
        if (plan === null) continue;
        const rate = plan.settled ? plan.settled.value : (await solveXirr(plan.dated))[0];
        if (!live) return;
        found.set(row.id, rate);
        setState({ rows, rates: new Map(found) });
      }
      if (live) setState({ rows, rates: new Map(found) });
    })();
    return () => {
      live = false;
    };
  }, [rows]);
  const rates = state.rows === rows ? state.rates : new Map<Id, Dec | null>();
  const wanted = rows.filter((row) => row.xirr !== null).length;
  return { rates, done: rates.size >= wanted };
}

function FullTableSheet({ workspace }: { workspace: Workspace }) {
  const navigate = useNavigate();
  const search = useRouterState({ select: (state) => state.location.search as FullTableSearch });
  const today = workspace.today();
  const rows = useLedger((ledger) => fullRows(ledger, today), today);
  const { rates, done } = useRates(rows);
  const table = fullTable(rows, rates);
  const investmentsCount = rows.filter((row) => !row.savings).length;
  const savingsCount = rows.length - investmentsCount;

  const back = () => void navigate({ to: "/investimentos" });
  const download = () =>
    void exportUnencrypted({
      title: "Exportar a tabela sem criptografia?",
      text: "O arquivo CSV será gravado fora do projeto, na pasta de downloads deste aparelho, sem criptografia.",
      confirmLabel: "Exportar",
      save: () => saveFile(`investimentos-${today}.csv`, fullCsv(rows, rates), CSV_TYPE),
    });

  return (
    <PrintSheet
      backLabel="Voltar a Investimentos"
      onBack={back}
      onDownload={download}
      downloadLabel="Baixar CSV"
      wide
      autoPrint={search.imprimir === "1" && done}
      onAutoPrinted={() => void navigate({ to: "/imprimir/investimentos", search: {}, replace: true })}
      sheet={{ "data-sheet": "investimentos" }}
    >
      <h1 className="text-title font-semibold tracking-[-0.01em] text-text">
        {workspace.ledger.meta.family_name || "Projeto"} — investimentos
      </h1>
      <p className="mt-1 text-caption text-secondary">
        Posição em {formatDateBr(today)} · {plural(investmentsCount, "investimento", "investimentos")}
        {savingsCount ? ` e ${plural(savingsCount, "poupança", "poupanças")}` : ""}. Valores antes de imposto e taxas de
        saída. Rendimento: último valor menos o total investido. Equivalente ao ano: taxa interna de retorno da
        aplicação até o último valor (dias corridos/365), com o equivalente ao mês; em período menor que um ano, é
        estimada. A poupança acompanha o Livro e não tem taxa equivalente. “—” indica dado que falta, nunca zero.
      </p>
      {!done ? (
        <p role="status" className="mt-2 text-caption text-secondary print:hidden">
          Calculando as taxas equivalentes…
        </p>
      ) : null}
      {rows.length === 0 ? (
        <p className="mt-6 text-body">Nenhum investimento nem poupança no projeto.</p>
      ) : (
        <div
          role="region"
          aria-label="Tabela completa de investimentos"
          tabIndex={0}
          className="mt-4 overflow-x-auto print:overflow-visible"
        >
          <ValuesTable
            table={table}
            className="text-caption [&_td]:whitespace-nowrap [&_td:nth-child(2)]:whitespace-normal [&_td:nth-child(5)]:whitespace-normal [&_th]:align-bottom [&_tr:last-child]:font-semibold"
          />
        </div>
      )}
    </PrintSheet>
  );
}
