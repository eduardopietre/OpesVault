/**
 * Importar índice de referência (desktop `InvestmentsPage.import_benchmark`): a local series ("data;valor", one
 * level per date) kept in the project to set a return beside. The file never leaves the browser; the application
 * brings no series of its own.
 */
import { DomainError, investments, type Id } from "@opesvault/domain";
import { Field, TextField } from "@opesvault/ui";
import { useRef, useState } from "react";
import { Caption, FormDialog, useFormAct } from "./livro_form.tsx";

const { benchmarks } = investments;

export interface InvestmentBenchmarkDialogProps {
  open: boolean;
  onClose: () => void;
  onDone?: (benchmarkId: Id, name: string) => void;
}

export function InvestmentBenchmarkDialog({ open, onClose, onDone }: InvestmentBenchmarkDialogProps) {
  const act = useFormAct();
  const input = useRef<HTMLInputElement>(null);
  const [name, setName] = useState("");
  const [file, setFile] = useState<File | null>(null);

  const confirm = async () => {
    if (!file) throw new DomainError("Escolha o arquivo da série (data;valor).");
    const title = name.trim();
    if (!title) throw new DomainError("Informe o nome do índice.");
    let data: Uint8Array;
    try {
      data = new Uint8Array(await file.arrayBuffer());
    } catch {
      throw new DomainError("Não foi possível ler o arquivo do índice.");
    }
    const saved = act((l) => {
      try {
        return benchmarks.importBenchmarkCsv(l, title, data, `arquivo ${file.name}`);
      } catch (error) {
        if (error instanceof benchmarks.UnicodeDecodeError) {
          throw new DomainError("O arquivo precisa estar em UTF-8 (CSV com data;valor).");
        }
        throw error;
      }
    });
    onDone?.(saved.id, title);
  };

  return (
    <FormDialog
      open={open}
      onClose={onClose}
      title="Importar índice de referência"
      confirmLabel="Importar"
      size="sm"
      onConfirm={confirm}
    >
      <div className="flex flex-col gap-3">
        <Field label="Série do índice (data;valor)" required>
          {({ id, describedBy }) => (
            <input
              ref={input}
              id={id}
              type="file"
              accept=".csv,.txt,text/csv,text/plain"
              aria-describedby={describedBy}
              data-autofocus=""
              className="block w-full min-w-0 text-body text-text file:mr-3 file:h-9 file:cursor-pointer file:rounded-md file:border file:border-separator-strong file:bg-raised file:px-3 file:text-body file:font-medium file:text-text hover:file:border-secondary"
              onChange={(event) => {
                const chosen = event.target.files?.[0] ?? null;
                setFile(chosen);
                if (chosen && !name.trim()) setName(chosen.name.replace(/\.[^.]+$/, ""));
              }}
            />
          )}
        </Field>
        <TextField label="Nome do índice" value={name} onChange={setName} maxLength={120} autoComplete="off" required />
        <Caption>
          Uma linha por data: dd/mm/aaaa;nível (a primeira linha pode ser o cabeçalho). Com a série, a rentabilidade do
          período aparece ao lado do índice, só nas datas que a série tem.
        </Caption>
      </div>
    </FormDialog>
  );
}
