/**
 * Informe de rendimentos (desktop `ReportDialog`): an informe to review before saving, line by line: who
 * issued it, the year and each line read (editable). The original, when there is one, is kept encrypted in
 * the project together with the report. The reading is generic and not yet validated with real documents, so
 * every line is checked by the person.
 */
import {
  AccountType,
  DomainError,
  Dec,
  MoneyError,
  formatBrl,
  parseBrl,
  session as sessions,
  sortedBy,
  tax,
  type Id,
} from "@opesvault/domain";
import { Button, IconButton, Select, TextField, type SelectOption } from "@opesvault/ui";
import { Plus, X } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { useWorkspace } from "../data/react.tsx";
import { Caption, FormDialog, FormGrid, FullRow, useFormAct } from "./livro_form.tsx";
import { TaxIdField, readTaxId } from "./tax_fields.tsx";

const FIELDS: SelectOption[] = Object.entries(tax.model.FIELD_LABELS).map(([id, label]) => ({ id, label }));

/** Who issued it: an account (bank, broker) or an income category (employer), as "account:<id>" / "category:<id>". */
export type ReportSourceChoice = `${tax.model.ReportSource}:${Id}`;

export const sourceChoice = (source: tax.model.ReportSource, id: Id): ReportSourceChoice => `${source}:${id}`;

export function splitSource(choice: string): [tax.model.ReportSource, Id] {
  const at = choice.indexOf(":");
  return [choice.slice(0, at) as tax.model.ReportSource, choice.slice(at + 1)];
}

/** The account or payer already known by this CNPJ. */
function guessSource(
  ledger: ReturnType<typeof useWorkspace>["ledger"],
  taxId: string | null,
): ReportSourceChoice | null {
  if (!taxId) return null;
  for (const found of tax.records.identities(ledger).values()) {
    if (found.tax_id !== taxId) continue;
    if (found.subject === tax.model.TaxSubject.ACCOUNT) return sourceChoice(tax.model.ReportSource.ACCOUNT, found.ref);
    if (found.subject === tax.model.TaxSubject.CATEGORY) {
      return sourceChoice(tax.model.ReportSource.CATEGORY, found.ref);
    }
  }
  return null;
}

interface LineRow {
  key: number;
  field: string;
  label: string;
  value: string;
}

/** The original file of an informe being imported; it is saved with the report. */
export interface ReportOriginal {
  name: string;
  data: Uint8Array;
}

export interface ReportDialogProps {
  open: boolean;
  onClose: () => void;
  year: number;
  lines: readonly tax.model.ReportLine[];
  payerTaxId?: string | null;
  payerName?: string | null;
  /** Who it is from, when known (an item of the checklist asked for it). */
  source?: [tax.model.ReportSource, Id] | null;
  /** The informe being corrected. */
  reportId?: Id | null;
  /** The document already kept for it. */
  documentId?: Id | null;
  /** The file just read: it is kept with the report. */
  original?: ReportOriginal | null;
  /** Lines with a value that were not recognised. */
  skipped?: readonly string[];
  onDone?: (report: tax.model.IncomeReport) => void;
}

export function ReportDialog({
  open,
  onClose,
  year,
  lines,
  payerTaxId = null,
  payerName = null,
  source = null,
  reportId = null,
  documentId = null,
  original = null,
  skipped = [],
  onDone,
}: ReportDialogProps) {
  const ledger = useWorkspace().ledger;
  const act = useFormAct();
  const counter = useRef(lines.length);
  const options = useMemo<SelectOption[]>(
    () => [
      ...sortedBy(
        [...ledger.accounts.values()].filter(
          (a) => (a.type === AccountType.ASSET || a.type === AccountType.LIABILITY) && !a.archived,
        ),
        (a) => a.name.toLowerCase(),
      ).map((a) => ({ id: sourceChoice(tax.model.ReportSource.ACCOUNT, a.id), label: `Conta: ${a.name}` })),
      ...sortedBy(
        ledger.categories(AccountType.INCOME).filter((a) => !a.archived),
        (a) => a.name.toLowerCase(),
      ).map((a) => ({
        id: sourceChoice(tax.model.ReportSource.CATEGORY, a.id),
        label: `Fonte pagadora: ${a.name}`,
      })),
    ],
    [ledger],
  );
  const [from, setFrom] = useState<string | null>(
    source ? sourceChoice(source[0], source[1]) : guessSource(ledger, payerTaxId),
  );
  const [yearText, setYearText] = useState(String(year));
  const [payer, setPayer] = useState(payerTaxId ? tax.ids.display(payerTaxId) : "");
  const [rows, setRows] = useState<LineRow[]>(() =>
    lines.map((line, index) => ({
      key: index,
      field: line.field,
      label: line.label,
      value: formatBrl(line.amount).replace("R$", "").trim(),
    })),
  );

  const edit = (key: number, change: Partial<LineRow>) =>
    setRows((list) => list.map((row) => (row.key === key ? { ...row, ...change } : row)));

  /** The typed lines; a line without a value is dropped. */
  const readLines = (): tax.model.ReportLine[] => {
    const out: tax.model.ReportLine[] = [];
    rows.forEach((row, index) => {
      const raw = row.value.trim();
      if (!raw) return;
      let amount: Dec;
      try {
        amount = parseBrl(raw);
      } catch (error) {
        if (error instanceof MoneyError) {
          throw new DomainError(`Valor inválido na linha ${index + 1}. Use o formato 1.234,56.`);
        }
        throw error;
      }
      out.push(
        tax.model.ReportLineSchema.parse({
          field: row.field,
          amount: amount.abs(),
          label: row.label.slice(0, 200),
        }),
      );
    });
    return out;
  };

  const confirm = () => {
    if (from === null) throw new DomainError("Escolha de quem é o informe.");
    const digits = readTaxId(payer, "any", true);
    const found = readLines();
    const number = Number(yearText.trim());
    if (!Number.isInteger(number) || number < 1990 || number > 2999) {
      throw new DomainError("Informe o ano-calendário, como 2025.");
    }
    const [kind, sourceId] = splitSource(from);
    const saved = act((l, session) => {
      // The original is kept once, even when the same file is read again.
      let doc: Id | null = documentId;
      if (original !== null) {
        const hash = sessions.sha256Hex(original.data);
        doc = (session.findDocumentByHash(hash) ?? session.addDocument(original.name, original.data)).meta.id;
      }
      const report = tax.records.saveReport(l, number, kind, sourceId, found, {
        payer_tax_id: digits,
        payer_name: payerName,
        document_id: doc,
        report_id: reportId,
      });
      const subject =
        kind === tax.model.ReportSource.ACCOUNT ? tax.model.TaxSubject.ACCOUNT : tax.model.TaxSubject.CATEGORY;
      if (report.payer_tax_id && tax.records.identity(l, subject, sourceId) === null) {
        tax.records.setIdentity(l, subject, sourceId, report.payer_tax_id, report.payer_name);
      }
      return report;
    });
    onDone?.(saved);
  };

  const shown = skipped.slice(0, 6).join("; ") + (skipped.length > 6 ? "…" : "");

  return (
    <FormDialog
      open={open}
      onClose={onClose}
      title="Informe de rendimentos"
      size="lg"
      confirmLabel="Salvar informe"
      onConfirm={confirm}
    >
      <FormGrid>
        <FullRow>
          <Select
            label="De quem é o informe"
            options={options}
            value={from}
            onChange={setFrom}
            placeholder="Escolha…"
          />
        </FullRow>
        <TextField
          label="Ano-calendário"
          value={yearText}
          onChange={setYearText}
          inputMode="numeric"
          maxLength={4}
          autoComplete="off"
          className="tabular-nums"
        />
        <TaxIdField label="CNPJ de quem emitiu" value={payer} onChange={setPayer} />
      </FormGrid>
      <fieldset className="min-w-0">
        <legend className="mb-2 text-body font-medium text-text">Linhas do informe</legend>
        {rows.length === 0 ? (
          <p className="mb-2 text-body text-secondary">Nenhuma linha ainda. Adicione as linhas do documento.</p>
        ) : null}
        <ul className="flex flex-col gap-3">
          {rows.map((row, index) => (
            <li
              key={row.key}
              className="grid grid-cols-[minmax(0,1fr)_2rem] items-end gap-x-2 gap-y-2 rounded-lg border border-separator p-3 tablet:grid-cols-[minmax(0,1.3fr)_minmax(0,1.4fr)_minmax(0,0.9fr)_2rem] tablet:border-0 tablet:p-0"
            >
              <Select
                label={`Linha ${index + 1}: campo`}
                options={FIELDS}
                value={row.field}
                onChange={(field) => edit(row.key, { field })}
                className="col-span-1"
              />
              <IconButton
                label={`Remover linha ${index + 1}`}
                icon={<X />}
                size="sm"
                className="tablet:order-last"
                onClick={() => setRows((list) => list.filter((r) => r.key !== row.key))}
              />
              <TextField
                label={`Linha ${index + 1}: texto do informe`}
                value={row.label}
                onChange={(label) => edit(row.key, { label })}
                maxLength={200}
                autoComplete="off"
                fieldClassName="col-span-2 tablet:col-span-1"
              />
              <TextField
                label={`Linha ${index + 1}: valor`}
                value={row.value}
                onChange={(value) => edit(row.key, { value })}
                inputMode="decimal"
                autoComplete="off"
                placeholder="0,00"
                className="text-right tabular-nums"
                fieldClassName="col-span-2 tablet:col-span-1"
              />
            </li>
          ))}
        </ul>
        <div className="mt-3">
          <Button
            size="sm"
            icon={<Plus />}
            onClick={() =>
              setRows((list) => [
                ...list,
                { key: counter.current++, field: tax.model.ReportField.TAXABLE, label: "", value: "" },
              ])
            }
          >
            Adicionar linha
          </Button>
        </div>
      </fieldset>
      {skipped.length ? <Caption>Linhas com valor que não foram reconhecidas: {shown}</Caption> : null}
      <Caption>
        Confira cada linha com o documento: a leitura é genérica e ainda não foi validada com informes reais. O original
        fica guardado e cifrado no projeto.
      </Caption>
    </FormDialog>
  );
}
