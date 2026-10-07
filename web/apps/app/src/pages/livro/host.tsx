/**
 * The dialogs the Livro opens, one at a time (desktop `pages/ledger/actions.py` and the dialogs in
 * `ui/dialogs.py` / `ui/planning_dialogs.py`). The page keeps a `DialogSpec` and whether it is open: closing
 * only clears `open`, so the dialog animates out with its content, and the next one gets a new `key`.
 */
import { dom, formatBrl, type Id, type Operation, edits } from "@opesvault/domain";
import { decide, notify } from "@opesvault/ui";
import { useState } from "react";
import { useWorkspace } from "../../data/react.tsx";
import { BalanceCheckDialog } from "../../dialogs/balance_check.tsx";
import { DeductibleDialog } from "../../dialogs/deductible.tsx";
import { IncomeDetailDialog } from "../../dialogs/income_detail.tsx";
import { FormDialog, useFormAct } from "../../dialogs/livro_form.tsx";
import { ReasonDialog, TextPromptDialog } from "../../dialogs/livro_prompts.tsx";
import { OperationDialog, OPERATION_KINDS, type OperationKindKey } from "../../dialogs/operation.tsx";
import { OperationEditDialog, SimpleEditDialog } from "../../dialogs/operation_edit.tsx";
import { ReclassifyDialog } from "../../dialogs/reclassify.tsx";
import { ReimbursementDialog } from "../../dialogs/reimbursement.tsx";
import { RenameTagDialog, TagDialog } from "../../dialogs/tags.tsx";
import { AiReviewDialog } from "../../dialogs/ai_review.tsx";
import { HISTORY_ACTIONS, instantLabel } from "./inspector.tsx";
import { ReceiptDialog } from "./receipt.tsx";
import { snapshotFilter, type FilterState } from "./rows.ts";
import type { ReviewProps } from "./ai.tsx";

export type DialogSpec =
  | { kind: "new"; op: OperationKindKey }
  | { kind: "simple"; id: Id }
  | { kind: "postings"; id: Id }
  | { kind: "reclassify"; ids: readonly Id[] }
  | { kind: "tags"; ids: readonly Id[] }
  | { kind: "rename-tag"; tag: string }
  | { kind: "income-detail"; id: Id }
  | { kind: "merchant"; id: Id }
  | { kind: "reimbursement"; id: Id }
  | { kind: "reverse"; id: Id }
  | { kind: "cancel"; id: Id }
  | { kind: "history"; id: Id }
  | { kind: "balance"; accountId: Id; choices: readonly Id[] }
  | { kind: "deductible"; categoryId: Id }
  | { kind: "save-filter"; filter: FilterState }
  | { kind: "receipt"; documentId: Id }
  | { kind: "ai"; review: ReviewProps };

export interface DialogHost {
  spec: DialogSpec | null;
  open: boolean;
  key: number;
  show: (spec: DialogSpec) => void;
  close: () => void;
}

export function useDialogHost(): DialogHost {
  const [state, setState] = useState<{ spec: DialogSpec | null; open: boolean; key: number }>({
    spec: null,
    open: false,
    key: 0,
  });
  return {
    ...state,
    show: (spec) => setState((s) => ({ spec, open: true, key: s.key + 1 })),
    close: () => setState((s) => ({ ...s, open: false })),
  };
}

export interface LedgerDialogsProps {
  host: DialogHost;
  /** After an operation was created: select it. */
  onCreated: (id: Id | null) => void;
}

export function LedgerDialogs({ host, onCreated }: LedgerDialogsProps) {
  const workspace = useWorkspace();
  const ledger = workspace.ledger;
  const act = useFormAct();
  const { spec, open, close } = host;
  if (spec === null) return null;
  const key = `${spec.kind}-${host.key}`;
  const operation = (id: Id): Operation | undefined => ledger.operations.get(id);

  switch (spec.kind) {
    case "new":
      return (
        <OperationDialog
          key={key}
          open={open}
          onClose={close}
          kind={spec.op}
          onDone={(kind, id) => {
            notify(`${OPERATION_KINDS[kind]}: lançamento registrado.`);
            onCreated(id);
          }}
        />
      );
    case "simple": {
      const op = operation(spec.id);
      if (!op) return null;
      return (
        <SimpleEditDialog
          key={key}
          open={open}
          onClose={close}
          operation={op}
          onDone={() => notify("Lançamento corrigido. A versão anterior ficou no histórico.")}
          onFullEditor={() => host.show({ kind: "postings", id: spec.id })}
        />
      );
    }
    case "postings": {
      const op = operation(spec.id);
      if (!op) return null;
      return (
        <OperationEditDialog
          key={key}
          open={open}
          onClose={close}
          operation={op}
          onDone={() => notify("Lançamento corrigido. A versão anterior ficou no histórico.")}
        />
      );
    }
    case "reclassify":
      return (
        <ReclassifyDialog
          key={key}
          open={open}
          onClose={close}
          operationIds={spec.ids}
          onDone={(result: edits.BulkResult) => {
            const message = `${result.changed} reclassificado(s), ${result.skipped} mantido(s).`;
            if (result.errors.length) {
              void decide({
                title: "Reclassificação",
                text: [message, ...result.errors.slice(0, 10)].join("\n"),
                choices: [],
                cancelLabel: "Entendi",
              });
            } else notify(message);
          }}
        />
      );
    case "tags":
      return (
        <TagDialog
          key={key}
          open={open}
          onClose={close}
          operationIds={spec.ids}
          onDone={(changed) => {
            if (changed) notify(`Marcadores alterados em ${changed} lançamento(s).`);
            else notify("Nenhum lançamento mudou: os marcadores já estavam assim.");
          }}
        />
      );
    case "rename-tag":
      return (
        <RenameTagDialog
          key={key}
          open={open}
          onClose={close}
          tag={spec.tag}
          onDone={(changed, name) => notify(`Marcador renomeado para “${name}” em ${changed} lançamento(s).`)}
        />
      );
    case "income-detail":
      return (
        <IncomeDetailDialog
          key={key}
          open={open}
          onClose={close}
          operationId={spec.id}
          onDone={() => notify("Rendimento detalhado: aparece em Imposto de renda.")}
        />
      );
    case "merchant": {
      const op = operation(spec.id);
      if (!op) return null;
      return (
        <TextPromptDialog
          key={key}
          open={open}
          onClose={close}
          title="Nomear estabelecimento"
          label="Nome do estabelecimento"
          confirmLabel="Salvar nome"
          description={`Nome para “${op.description}” e descrições parecidas.`}
          initial={dom.merchants.merchantOf(ledger, op.description)}
          emptyMessage="Informe o nome do estabelecimento."
          onSubmit={(name) => {
            act((l) => dom.merchants.nameMerchant(l, op.description, name), "nomear estabelecimento");
            notify(`Estabelecimento “${name}” definido; a descrição original continua guardada.`);
          }}
        />
      );
    }
    case "reimbursement": {
      const op = operation(spec.id);
      if (!op) return null;
      return (
        <ReimbursementDialog
          key={key}
          open={open}
          onClose={close}
          operation={op}
          onDone={() => notify("Reembolso registrado. Acompanhe em Reembolsos e acertos.")}
        />
      );
    }
    case "reverse": {
      const op = operation(spec.id);
      if (!op) return null;
      return (
        <ReasonDialog
          key={key}
          open={open}
          onClose={close}
          title="Estornar lançamento"
          confirmLabel="Estornar"
          description={`${op.description}: o estorno é um novo lançamento oposto; o original é mantido.`}
          onSubmit={(reason) => {
            act((l) => l.reverseOperation(op.id, workspace.today(), reason), "estornar lançamento");
            notify("Estorno registrado como nova operação; o original foi mantido.");
          }}
        />
      );
    }
    case "cancel": {
      const op = operation(spec.id);
      if (!op) return null;
      return (
        <ReasonDialog
          key={key}
          open={open}
          onClose={close}
          title="Cancelar lançamento"
          confirmLabel="Cancelar lançamento"
          description={`${op.description}: continua visível em “Só cancelados”, fora dos saldos e relatórios.`}
          onSubmit={(reason) => {
            act((l) => l.cancelOperation(op.id, reason), "cancelar lançamento");
            notify("Lançamento cancelado. Ele continua visível em “Só cancelados”.");
          }}
        />
      );
    }
    case "history": {
      const entries = ledger.historyOf(spec.id);
      return (
        <FormDialog key={key} open={open} onClose={close} title="Histórico" closeOnly>
          {entries.length ? (
            <ol className="flex flex-col gap-3">
              {entries.map((entry) => (
                <li key={entry.id} className="text-body">
                  <span className="font-semibold">
                    v{entry.version} · {HISTORY_ACTIONS[entry.action] ?? entry.action}
                  </span>
                  <span className="block text-caption text-secondary">
                    {instantLabel(entry.at)} · {entry.operator ?? "operador não informado"}
                  </span>
                  {entry.reason ? <span className="block">Motivo: {entry.reason}</span> : null}
                </li>
              ))}
            </ol>
          ) : (
            <p className="text-body text-secondary">Sem histórico.</p>
          )}
        </FormDialog>
      );
    }
    case "balance":
      return (
        <BalanceCheckDialog
          key={key}
          open={open}
          onClose={close}
          accountId={spec.accountId}
          choices={spec.choices}
          onDone={(check, name) => {
            const result = dom.balanceChecks.results(ledger, check.account_id).find((r) => r.check.id === check.id);
            if (result === undefined) notify(`Saldo de ${name} conferido.`);
            else if (result.matches) notify(`Saldo de ${name} confere com o do banco (${formatBrl(result.computed)}).`);
            else
              notify(
                `Saldo de ${name} difere: o banco mostra ${formatBrl(check.informed)} e o livro ${formatBrl(result.computed)}.`,
                { tone: "warning" },
              );
          }}
        />
      );
    case "deductible":
      return (
        <DeductibleDialog
          key={key}
          open={open}
          onClose={close}
          categoryId={spec.categoryId}
          onDone={(kind) =>
            notify(
              kind === null
                ? "Categoria deixou de ser dedutível."
                : `Categoria marcada como dedutível (${dom.deductibles.KIND_LABELS[kind]}).`,
            )
          }
        />
      );
    case "save-filter":
      return (
        <TextPromptDialog
          key={key}
          open={open}
          onClose={close}
          title="Salvar filtro"
          label="Nome do filtro"
          placeholder="ex.: Cartão da Ana este mês"
          confirmLabel="Salvar filtro"
          emptyMessage="Dê um nome ao filtro."
          onSubmit={(name) => {
            const saved = act((l) => dom.savedFilters.saveFilter(l, snapshotFilter(spec.filter, name)), "salvar filtro");
            notify(`Filtro “${saved.name}” salvo no projeto.`);
          }}
        />
      );
    case "receipt":
      return <ReceiptDialog key={key} open={open} onClose={close} documentId={spec.documentId} />;
    case "ai":
      return <AiReviewDialog key={key} open={open} onClose={close} {...spec.review} />;
  }
}
