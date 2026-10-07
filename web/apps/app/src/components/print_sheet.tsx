/**
 * A print view outside the shell (the month's report, the year-end closing, the report for the declaration):
 * the browser prints it ("Salvar como PDF") and the same report is a file to download. The sheet is paper:
 * light, whatever the theme of the screen. Opened with `imprimir=1`, the print dialog comes up once the sheet
 * is drawn, and the flag leaves the address.
 */
import { Button, applyTheme, cn } from "@opesvault/ui";
import { ArrowLeft, FileDown, Printer } from "lucide-react";
import { useEffect, useRef, type ReactNode } from "react";
import { useTheme } from "../theme.tsx";
import { cellText, type ReportTable } from "../pages/visao-geral/report.ts";

const print = () => {
  if (typeof window.print === "function") window.print();
};

export interface PrintSheetProps {
  /** Back to the page the sheet came from. */
  backLabel: string;
  onBack: () => void;
  onDownload: () => void;
  /** The address asked for the print dialog (`imprimir=1`). */
  autoPrint: boolean;
  /** After the print dialog asked for by the address: the same address without the flag. */
  onAutoPrinted: () => void;
  /** Data attributes of the sheet (what it shows), for tests and screenshots. */
  sheet?: Record<`data-${string}`, string>;
  children: ReactNode;
}

export function PrintSheet({
  backLabel,
  onBack,
  onDownload,
  autoPrint,
  onAutoPrinted,
  sheet,
  children,
}: PrintSheetProps) {
  const { theme } = useTheme();
  useEffect(() => {
    applyTheme("light");
    return () => applyTheme(theme);
  }, [theme]);

  const printed = useRef(onAutoPrinted);
  useEffect(() => {
    printed.current = onAutoPrinted;
  });
  useEffect(() => {
    if (!autoPrint) return;
    const timer = setTimeout(() => {
      print();
      printed.current();
    }, 350);
    return () => clearTimeout(timer);
  }, [autoPrint]);

  return (
    <div className="min-h-dvh bg-window px-2 py-4 text-text min-[480px]:px-4 print:min-h-0 print:bg-transparent print:p-0 tablet:px-6">
      <div className="mx-auto mb-4 flex max-w-[820px] flex-wrap items-center justify-between gap-2 print:hidden">
        <Button variant="ghost" icon={<ArrowLeft />} onClick={onBack}>
          {backLabel}
        </Button>
        <div className="flex flex-wrap items-center gap-2">
          <Button icon={<FileDown />} onClick={onDownload}>
            Baixar como arquivo HTML
          </Button>
          <Button variant="primary" icon={<Printer />} onClick={print}>
            Imprimir ou salvar em PDF
          </Button>
        </div>
      </div>
      <article
        {...sheet}
        className="mx-auto max-w-[820px] rounded-xl border border-separator bg-raised p-4 shadow-md min-[480px]:p-6 print:max-w-none print:rounded-none print:border-0 print:p-0 print:shadow-none tablet:p-10"
      >
        {children}
      </article>
    </div>
  );
}

/** A report's table of values, as on paper; `className` adds to the table's own. */
export function ValuesTable({ table, className }: { table: ReportTable; className?: string }) {
  return (
    <table className={cn("w-full border-collapse text-body", className)}>
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
  );
}

/** A titled table of a report (its title as a heading, when it has one). */
export function ReportTableView({ table }: { table: ReportTable }) {
  return (
    <section className="break-inside-avoid">
      {table.title ? <h2 className="mt-6 mb-2 text-headline font-semibold text-text">{table.title}</h2> : null}
      <ValuesTable table={table} />
    </section>
  );
}
