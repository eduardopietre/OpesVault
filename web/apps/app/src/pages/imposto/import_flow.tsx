/**
 * Informes de rendimentos, from the file to the review (desktop `ReportCommands`): the person chooses a PDF
 * (or text), the domain reads it with the browser's PDF extractor, a protected one asks for its password once
 * (never stored), and the lines go to the review dialog, with the original kept encrypted when saved. A file
 * that cannot be read says so and points to the informe without a file.
 */
import { DomainError, importing, tax, type Id } from "@opesvault/domain";
import { notify } from "@opesvault/ui";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useDialog } from "../../data/dialog.ts";
import { browserExtractor } from "../../data/pdf.ts";
import { DocumentsPasswordDialog } from "../../dialogs/documents_password.tsx";
import type { ReportDialogProps } from "../../dialogs/tax_report.tsx";

/** What the review dialog gets from a file that was read. */
export type ParsedProps = Omit<ReportDialogProps, "open" | "onClose" | "onDone">;

export type ReportSourcePick = [tax.model.ReportSource, Id] | null;

interface Waiting {
  name: string;
  data: Uint8Array;
  source: ReportSourcePick;
}

const UNREADABLE = "Não foi possível ler este arquivo. Use Mais › Novo informe sem arquivo.";

export function useReportImport(year: number, onRead: (props: ParsedProps) => void) {
  const input = useRef<HTMLInputElement>(null);
  const source = useRef<ReportSourcePick>(null);
  const [busy, setBusy] = useState(false);
  const asking = useDialog<Waiting>();
  const waiting = asking.spec;
  const show = asking.show;
  const read = useRef(onRead);
  useEffect(() => {
    read.current = onRead;
  });

  const parse = useCallback(
    async (name: string, data: Uint8Array, from: ReportSourcePick, password: string | null): Promise<void> => {
      let result: tax.statements.ParsedReport;
      try {
        result = await tax.statements.read(data, browserExtractor(), password);
      } catch (error) {
        if (
          error instanceof importing.source.SourceError &&
          (error.problem === importing.source.SourceProblem.PASSWORD_REQUIRED ||
            error.problem === importing.source.SourceProblem.WRONG_PASSWORD)
        ) {
          if (password !== null) throw new DomainError("Senha incorreta. Tente de novo.");
          show({ name, data, source: from });
          return;
        }
        notify(UNREADABLE, { tone: "negative" });
        return;
      }
      const props: ParsedProps = {
        year: result.year ?? year,
        lines: result.lines,
        payerTaxId: result.payerTaxId,
        payerName: result.payerName,
        source: from,
        skipped: result.skipped,
        original: { name, data },
      };
      // After the password dialog, which closes as this returns, the review opens: never both at once.
      if (password === null) read.current(props);
      else window.setTimeout(() => read.current(props), 0);
    },
    [year, show],
  );

  const chosen = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    try {
      const data = new Uint8Array(await file.arrayBuffer());
      await parse(file.name, data, source.current, null);
    } catch {
      notify("Não foi possível ler o arquivo.", { tone: "negative" });
    } finally {
      setBusy(false);
    }
  };

  const pick = useCallback((from: ReportSourcePick = null) => {
    source.current = from;
    input.current?.click();
  }, []);

  const nodes: ReactNode = (
    <>
      <input
        ref={input}
        type="file"
        aria-label="Escolher o arquivo do informe"
        accept=".pdf,.csv,.txt,application/pdf,text/csv,text/plain"
        className="sr-only"
        tabIndex={-1}
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          void chosen(file);
        }}
      />
      {waiting ? (
        <DocumentsPasswordDialog
          key={asking.key}
          open={asking.open}
          onClose={asking.close}
          name={waiting.name}
          onSubmit={(password) => parse(waiting.name, waiting.data, waiting.source, password)}
        />
      ) : null}
    </>
  );

  return { pick, busy, nodes };
}
