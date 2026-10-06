/**
 * The dialogs of the Imposto de renda page: one at a time, mounted with a fresh key so each leaves with its
 * content. Each says what happened in a notice when it is saved (the desktop's `TaxCommands._run` messages).
 */
import { notify } from "@opesvault/ui";
import { Fragment } from "react";
import type { Dec, Id, YearMonth, tax } from "@opesvault/domain";
import { DeclaredAssetDialog } from "../../dialogs/tax_declared_asset.tsx";
import { FilingDialog } from "../../dialogs/tax_filing.tsx";
import { TaxIdDialog } from "../../dialogs/tax_id.tsx";
import { MemberTaxDialog } from "../../dialogs/tax_member.tsx";
import { NatureDialog } from "../../dialogs/tax_nature.tsx";
import { OperationsDialog, type OperationsMode } from "../../dialogs/tax_operations.tsx";
import { ParametersDialog } from "../../dialogs/tax_parameters.tsx";
import { PaymentDialog } from "../../dialogs/tax_payment.tsx";
import { PeopleDialog } from "../../dialogs/tax_people.tsx";
import { ReportDialog, type ReportDialogProps } from "../../dialogs/tax_report.tsx";
import { VariableRulesDialog } from "../../dialogs/tax_rules.tsx";

export type Spec =
  | { kind: "params"; year: number }
  | { kind: "rules" }
  | { kind: "payment"; purpose: tax.model.PaymentPurpose; month: YearMonth; memberId: Id | null; suggested: Dec | null }
  | { kind: "filing"; subject: tax.model.FilingSubject; ref: Id; name: string; suggested: string | null }
  | { kind: "asset"; assetId: Id | null }
  | { kind: "taxid"; subject: tax.model.TaxSubject; ref: string; label: string }
  | { kind: "member"; memberId: Id }
  | { kind: "people" }
  | { kind: "nature"; focus: { subject: tax.model.NatureSubject; ref: Id } | null }
  | { kind: "operations"; ids: readonly Id[]; mode: OperationsMode }
  | {
      kind: "report";
      props: Omit<ReportDialogProps, "open" | "onClose" | "onDone">;
      /** What the notice says once it is saved. */
      message: string;
    };

export interface DialogHostProps {
  spec: Spec | null;
  open: boolean;
  dialogKey: number;
  onClose: () => void;
  /** The informe that was just saved (the page selects it). */
  onReportSaved: (report: tax.model.IncomeReport) => void;
}

export function DialogHost({ spec, open, dialogKey, onClose, onReportSaved }: DialogHostProps) {
  if (spec === null) return null;
  return (
    <Fragment key={dialogKey}>
      <Dialogs spec={spec} open={open} onClose={onClose} onReportSaved={onReportSaved} />
    </Fragment>
  );
}

function Dialogs({ spec, open, onClose, onReportSaved }: Omit<DialogHostProps, "spec" | "dialogKey"> & { spec: Spec }) {
  const common = { open, onClose };
  switch (spec.kind) {
    case "params":
      return <ParametersDialog {...common} year={spec.year} onDone={() => notify("Tabela do ano salva.")} />;
    case "rules":
      return <VariableRulesDialog {...common} onDone={() => notify("Regras de renda variável salvas.")} />;
    case "payment":
      return (
        <PaymentDialog
          {...common}
          purpose={spec.purpose}
          month={spec.month}
          memberId={spec.memberId}
          suggested={spec.suggested}
          onDone={() => notify("Pagamento do DARF registrado.")}
        />
      );
    case "filing":
      return (
        <FilingDialog
          {...common}
          subject={spec.subject}
          reference={spec.ref}
          name={spec.name}
          suggested={spec.suggested}
          onDone={() => notify("Bem classificado.")}
        />
      );
    case "asset":
      return (
        <DeclaredAssetDialog
          {...common}
          assetId={spec.assetId}
          onDone={(created) => notify(created ? "Bem incluído." : "Bem salvo.")}
        />
      );
    case "taxid":
      return (
        <TaxIdDialog
          {...common}
          subject={spec.subject}
          reference={spec.ref}
          label={spec.label}
          onDone={() => notify("CPF/CNPJ salvo.")}
        />
      );
    case "member":
      return <MemberTaxDialog {...common} memberId={spec.memberId} onDone={() => notify("Dados fiscais salvos.")} />;
    case "people":
      return <PeopleDialog {...common} />;
    case "nature":
      return <NatureDialog {...common} focus={spec.focus} onDone={() => notify("Natureza dos rendimentos salva.")} />;
    case "operations":
      return <OperationsDialog {...common} operationIds={spec.ids} mode={spec.mode} />;
    case "report":
      return (
        <ReportDialog
          {...common}
          {...spec.props}
          onDone={(report) => {
            notify(spec.message);
            onReportSaved(report);
          }}
        />
      );
  }
}
