/**
 * The operations behind a line of the return (desktop `OperationsDialog`): "detail" to copy the payslip
 * (gross, tax withheld, INSS) of each deposit, or "receipts" to attach the receipt of each payment. The list
 * stays open while each one is done.
 */
import { Dec, DomainError, cashDate, dom, formatBrl, type Id, type Ledger, tax } from "@opesvault/domain";
import { Button, DataTable, ElidedText, type DataColumn } from "@opesvault/ui";
import { useRef, useState } from "react";
import { useLedger, useWorkspace } from "../data/react.tsx";
import { Caption, FormDialog, useFormAct } from "./livro_form.tsx";
import { IncomeDetailDialog } from "./income_detail.tsx";
import { READ_ONLY_TIP } from "../data/read_only.ts";
import { dateOr, moneyOr } from "../data/money.ts";

export type OperationsMode = "detail" | "receipts";

interface OperationLine {
  id: Id;
  date: string;
  description: string;
  value: string;
  status: string;
}

const text = (value: string) => <ElidedText>{value}</ElidedText>;

/** The rows of the dialog: date, description, value and the payslip or the receipts of each operation. */
export function operationLines(ledger: Ledger, ids: readonly Id[], mode: OperationsMode): OperationLine[] {
  const out: OperationLine[] = [];
  for (const id of ids) {
    const op = ledger.operations.get(id);
    if (op === undefined) continue;
    const value = Dec.sum(
      op.postings.filter((p) => p.amount.isPositive()).map((p) => p.amount.abs()),
      Dec.from(0),
    );
    let status: string;
    if (mode === "detail") {
      const detail = tax.records.detailOf(ledger, id);
      status = detail
        ? [detail.gross, detail.withheld, detail.social_security].map((v) => moneyOr(v)).join(" / ")
        : "não detalhado";
    } else {
      const found = dom.attachments.ofOperation(ledger, id);
      status = found.length ? `${found.length} anexo(s)` : "falta";
    }
    const day = cashDate(op);
    out.push({ id, date: dateOr(day), description: op.description, value: formatBrl(value), status });
  }
  return out;
}

export interface OperationsDialogProps {
  open: boolean;
  onClose: () => void;
  operationIds: readonly Id[];
  mode: OperationsMode;
}

export function OperationsDialog({ open, onClose, operationIds, mode }: OperationsDialogProps) {
  const workspace = useWorkspace();
  const act = useFormAct();
  const rows = useLedger((l) => operationLines(l, operationIds, mode), `${mode}|${operationIds.join(",")}`);
  const [picked, setPicked] = useState<Id | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [detail, setDetail] = useState<{ id: Id; key: number } | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  const selected = rows.find((r) => r.id === picked) ?? rows[0] ?? null;

  const columns: DataColumn<OperationLine>[] = [
    {
      id: "date",
      header: "Data",
      cell: (r) => r.date,
      sortValue: (r) => r.date.split("/").reverse().join("-"),
      width: 104,
    },
    {
      id: "description",
      header: "Descrição",
      cell: (r) => text(r.description),
      sortValue: (r) => r.description,
      grow: 1,
      width: 150,
    },
    { id: "value", header: "Valor", cell: (r) => r.value, align: "end", width: 112 },
    {
      id: "status",
      header: mode === "detail" ? "Bruto / IR / INSS" : "Comprovante",
      cell: (r) => text(r.status),
      width: mode === "detail" ? 250 : 120,
      grow: mode === "detail" ? 0 : 1,
    },
  ];

  const start = (id: Id | undefined = selected?.id) => {
    if (!id) return;
    setPicked(id);
    setError(null);
    setDone(null);
    if (mode === "detail") {
      setDetail((current) => ({ id, key: (current?.key ?? 0) + 1 }));
      setDetailOpen(true);
    } else {
      file.current?.click();
    }
  };

  const attach = async (chosen: File | undefined) => {
    if (!chosen || !selected) return;
    const bytes = new Uint8Array(await chosen.arrayBuffer());
    try {
      act((_l, session) => dom.attachments.attach(session, selected.id, chosen.name, bytes));
      setDone("Comprovante anexado e guardado cifrado no projeto.");
    } catch (cause) {
      if (cause instanceof DomainError) setError(cause.message);
      else throw cause;
    }
  };

  return (
    <>
      <FormDialog
        open={open}
        onClose={onClose}
        title={mode === "detail" ? "Contracheques" : "Comprovantes"}
        description={
          mode === "detail"
            ? "Copie do contracheque o bruto, o imposto retido e o INSS de cada depósito."
            : "Anexe o recibo ou a nota de cada pagamento."
        }
        closeOnly
        size="lg"
      >
        <DataTable
          label="Lançamentos"
          rows={rows}
          columns={columns}
          getRowId={(r) => r.id}
          selectedId={selected?.id ?? null}
          onSelect={setPicked}
          onActivate={(id) => (workspace.readOnly ? undefined : start(id))}
          cardTitle={(r) => text(r.description)}
          height={`${Math.min(Math.max(rows.length, 1), 10) * 36 + 38}px`}
          empty={<p className="px-3 py-6 text-center text-body text-secondary">Nenhum lançamento.</p>}
        />
        <div className="flex flex-wrap items-center gap-3">
          <Button
            variant="primary"
            onClick={() => start()}
            disabled={selected === null || workspace.readOnly}
            title={workspace.readOnly ? READ_ONLY_TIP : undefined}
          >
            {mode === "detail" ? "Detalhar…" : "Anexar comprovante…"}
          </Button>
          {done ? (
            <p role="status" className="text-body font-medium text-positive">
              {done}
            </p>
          ) : null}
        </div>
        {error ? (
          <p role="alert" className="rounded-md bg-negative-soft px-3 py-2 text-body font-medium text-negative">
            <span className="sr-only">Erro: </span>
            {error}
          </p>
        ) : null}
        {mode === "receipts" ? <Caption>Aceita PDF, PNG ou JPEG de até 25 MB.</Caption> : null}
        <input
          ref={file}
          type="file"
          aria-label="Escolher o comprovante"
          accept=".pdf,.png,.jpg,.jpeg,application/pdf,image/png,image/jpeg"
          className="sr-only"
          tabIndex={-1}
          onChange={(event) => {
            const chosen = event.target.files?.[0];
            event.target.value = "";
            void attach(chosen);
          }}
        />
      </FormDialog>
      {detail ? (
        <IncomeDetailDialog
          key={detail.key}
          open={detailOpen}
          onClose={() => setDetailOpen(false)}
          operationId={detail.id}
          onDone={() => setDone("Rendimento detalhado.")}
        />
      ) : null}
    </>
  );
}
