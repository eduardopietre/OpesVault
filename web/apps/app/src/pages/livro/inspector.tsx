/**
 * Details of the selected operation, beside the table instead of in a dialog (desktop
 * `pages/ledger/inspector.py`): description, kind and origin, amount, the dates, the postings with who each
 * share belongs to, tags, merchant, suspicions, receipts, reimbursement, notes and the last history entries.
 */
import { dom, formatBrl, isActive, type Id, type IsoDate, type Ledger, type Operation } from "@opesvault/domain";
import { Badge, Button, Figure } from "@opesvault/ui";
import { FileText, Paperclip, Pencil, TriangleAlert } from "lucide-react";
import type { ReactNode } from "react";
import { KIND_LABELS, ORIGIN_LABELS, operationAmount } from "./rows.ts";
import { monthLabel } from "../../dialogs/livro_form.tsx";
import { dateOr } from "../../data/money.ts";

export const HISTORY_ACTIONS: Readonly<Record<string, string>> = {
  create: "criado",
  update: "corrigido",
  cancel: "cancelado",
  archive: "arquivado",
  close_period: "mês fechado",
  reopen_period: "mês reaberto",
  approve_import: "importação aprovada",
};

/** "05/10/2026 14:30", in this computer's time zone. */
export function instantLabel(instant: string): string {
  const date = new Date(instant);
  if (Number.isNaN(date.getTime())) return instant;
  return date.toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" });
}

function Pair({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="shrink-0 text-caption text-secondary">{label}</dt>
      <dd className="min-w-0 text-right text-body">{children}</dd>
    </div>
  );
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2 border-t border-separator pt-3">
      <h3 className="text-body font-semibold">{title}</h3>
      {children}
    </section>
  );
}

export interface InspectorBodyProps {
  ledger: Ledger;
  operation: Operation;
  today: IsoDate;
  onOpenReceipt: (documentId: Id) => void;
  onEdit?: () => void;
  onAttach?: () => void;
  /** More commands (a menu), for when the page's own command bar is out of reach (a sheet). */
  moreActions?: ReactNode;
  readOnly?: boolean;
}

export function OperationDetails({
  ledger,
  operation: op,
  today,
  onOpenReceipt,
  onEdit,
  onAttach,
  moreActions,
  readOnly,
}: InspectorBodyProps) {
  const member = op.member_id ? ledger.members.get(op.member_id) : undefined;
  const tags = dom.tags.tagsOf(ledger, op.id);
  const suspicions = dom.anomalies.ofOperation(ledger, op.id, today);
  const receipts = dom.attachments.ofOperation(ledger, op.id);
  const reimbursements = [...dom.sharing.reimbursements(ledger).values()].filter((r) => r.operation_id === op.id);
  const history = ledger.historyOf(op.id);
  return (
    <div className="flex flex-col gap-3" data-testid="operation-details">
      <div className="min-w-0">
        <h3 className="text-headline font-semibold break-words">{op.description}</h3>
        <p className="mt-0.5 text-body text-secondary">
          {KIND_LABELS[op.kind] ?? op.kind} · {isActive(op) ? "Ativo" : "Cancelado"} · {ORIGIN_LABELS[op.origin.kind]}
        </p>
      </div>
      <Figure label="Valor" value={operationAmount(op)} />
      <div className="flex flex-wrap gap-2">
        {onEdit ? (
          <Button size="sm" icon={<Pencil />} onClick={onEdit} disabled={!isActive(op) || readOnly === true}>
            Corrigir
          </Button>
        ) : null}
        {onAttach ? (
          <Button size="sm" icon={<Paperclip />} onClick={onAttach} disabled={readOnly === true}>
            Anexar comprovante
          </Button>
        ) : null}
        {moreActions}
      </div>
      <dl className="flex flex-col gap-1 border-t border-separator pt-3">
        <Pair label="Ocorrência">{dateOr(op.occurred_on)}</Pair>
        <Pair label="Lançamento">{dateOr(op.booked_on)}</Pair>
        <Pair label="Liquidação">{dateOr(op.settled_on)}</Pair>
        <Pair label="Vencimento">{dateOr(op.due_on)}</Pair>
        <Pair label="Competência">{op.accrual_month ? monthLabel(op.accrual_month) : "—"}</Pair>
        <Pair label="Responsável">{member ? member.name : "Projeto"}</Pair>
      </dl>
      <Group title="Partidas">
        <ul className="flex flex-col gap-1">
          {op.postings.map((posting, index) => {
            const account = ledger.accounts.get(posting.account_id);
            const share = posting.member_id ? ledger.members.get(posting.member_id) : undefined;
            const side = posting.amount.isPositive() ? "débito" : "crédito";
            return (
              <li key={index} className="flex items-baseline justify-between gap-3 text-body">
                <span className="min-w-0 truncate" title={account?.name ?? "?"}>
                  {account?.name ?? "?"}
                </span>
                <span className="shrink-0 text-right tabular-nums">
                  {formatBrl(posting.amount.abs())}{" "}
                  <span className="text-caption text-secondary">({share ? `${side} · ${share.name}` : side})</span>
                </span>
              </li>
            );
          })}
        </ul>
      </Group>
      <dl className="flex flex-col gap-1">
        {tags.length ? (
          <Pair label="Marcadores">
            <span className="inline-flex flex-wrap justify-end gap-1">
              {tags.map((tag) => (
                <Badge key={tag} tone="accent">
                  {tag}
                </Badge>
              ))}
            </span>
          </Pair>
        ) : null}
        <Pair label="Estabelecimento">{dom.merchants.merchantOf(ledger, op.description)}</Pair>
      </dl>
      {suspicions.map((suspicion) => (
        <p
          key={`${suspicion.kind}-${suspicion.operationId}`}
          className="flex gap-2 rounded-md bg-warning-soft px-3 py-2 text-caption text-warning"
        >
          <TriangleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          <span>
            <strong className="font-semibold">{suspicion.title}:</strong> {suspicion.detail}
          </span>
        </p>
      ))}
      {receipts.length ? (
        <Group title="Comprovantes">
          <div className="flex flex-col items-start gap-1">
            {receipts.map((receipt, index) => (
              <Button
                key={receipt.id}
                size="sm"
                variant="ghost"
                icon={<FileText />}
                onClick={() => onOpenReceipt(receipt.document_id)}
              >
                {receipts.length > 1 ? `Abrir comprovante ${index + 1}` : "Abrir comprovante"}
              </Button>
            ))}
          </div>
        </Group>
      ) : null}
      {reimbursements.length ? (
        <dl className="flex flex-col gap-1">
          {reimbursements.map((item) => (
            <Pair key={item.id} label="Reembolso">
              {item.payer} · {formatBrl(item.expected)} · {dom.sharing.STATE_LABELS[dom.sharing.state(ledger, item)]}
            </Pair>
          ))}
        </dl>
      ) : null}
      {op.notes ? (
        <Group title="Observações">
          <p className="text-body break-words whitespace-pre-wrap">{op.notes}</p>
        </Group>
      ) : null}
      {history.length ? (
        <Group title="Histórico">
          <ul className="flex flex-col gap-1.5">
            {history.slice(-5).map((entry) => (
              <li key={entry.id} className="text-caption">
                <span className="text-secondary">
                  {instantLabel(entry.at)} · v{entry.version} · {entry.operator ?? "operador não informado"}
                </span>
                {entry.reason ? <span className="block text-text">Motivo: {entry.reason}</span> : null}
              </li>
            ))}
          </ul>
        </Group>
      ) : null}
    </div>
  );
}

/** What the inspector says when there is no single operation to show. */
export function SelectionNote({ selected }: { selected: number }) {
  return (
    <div className="flex flex-col gap-2 text-body text-secondary">
      <p>{selected === 0 ? "Nenhum lançamento selecionado" : `${selected} lançamentos selecionados`}</p>
      {selected > 1 ? (
        <p className="text-caption">Use Ações › Reclassificar para mudar a categoria de todos.</p>
      ) : (
        <p className="text-caption">Escolha uma linha da tabela para ver as partidas, os comprovantes e o histórico.</p>
      )}
    </div>
  );
}
