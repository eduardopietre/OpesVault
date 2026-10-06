/**
 * Imposto de renda (desktop `ui/pages/tax/`): the year in the shape of the return's sheets, what is still
 * missing and the monthly DARFs, as support material for the declaration. Rates, tables and limits are the
 * person's: nothing fiscal is embedded, and a number that depends on what was not informed is unknown (—),
 * with its reason. The nature of each income, the group and code of each asset and every CPF/CNPJ are the
 * person's choices; the page may suggest, marked as such, and never saves on its own.
 *
 * A pending item leads straight to the dialog that resolves it. A link from another screen (a DARF reminder,
 * the declaration season) opens the year, the month and, with an action, the payment.
 */
import { Dec, investments, tax, type Id, type YearMonth } from "@opesvault/domain";
import {
  Adaptive,
  Button,
  Collapsible,
  EmptyState,
  MenuButton,
  PageHeader,
  Select,
  confirm,
  notify,
  useStoredFlag,
  type SelectOption,
} from "@opesvault/ui";
import { FileDown, FileUp } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { useAct, useLedger, useWorkspace } from "../../data/react.tsx";
import { useGoTo, useReveal } from "../../data/navigation.ts";
import { useNavigate } from "@tanstack/react-router";
import { useDialog, useLock } from "../../components/list_parts.tsx";
import { FigureRow, Money } from "../../components/figures.tsx";
import { declarantChoices, namesOf, yearData } from "./data.ts";
import { DialogHost, type Spec } from "./host.tsx";
import { useReportImport, type ParsedProps, type ReportSourcePick } from "./import_flow.tsx";
import { IssueList } from "./issues.tsx";
import { initialYear, parseReveal, summaryLine, yearOptions } from "./rows.ts";
import {
  AssetsSection,
  DebtsSection,
  DocumentsSection,
  IncomeSection,
  PaymentsSection,
  ReportsSection,
  SimulationSection,
  VariableSection,
} from "./sections.tsx";

const PROJECT = "__project";

export function Page() {
  const workspace = useWorkspace();
  const ledger = workspace.ledger;
  const act = useAct();
  const goTo = useGoTo();
  const navigate = useNavigate();
  const { locked, tip } = useLock();
  const today = workspace.today();
  const dialog = useDialog<Spec>();

  const [year, setYear] = useState(() => initialYear(ledger, today));
  const [declarant, setDeclarant] = useState<Id | null>(null);
  const choices = useLedger(declarantChoices);
  const who = declarant !== null && choices.some((c) => c.id === declarant) ? declarant : null;
  const data = useLedger((l) => yearData(l, year, who, today), `${year}|${who}|${today}`);
  const names = useMemo(() => namesOf(ledger), [ledger]);
  const whoName = who ? (choices.find((c) => c.id === who)?.name ?? null) : null;

  // The choice of a row of each sheet (by id, so it survives a change of the rows).
  const [taxable, setTaxable] = useState<string | null>(null);
  const [other, setOther] = useState<string | null>(null);
  const [carne, setCarne] = useState<string | null>(null);
  const [payment, setPayment] = useState<string | null>(null);
  const [asset, setAsset] = useState<string | null>(null);
  const [debt, setDebt] = useState<string | null>(null);
  const [variable, setVariable] = useState<string | null>(null);
  const [doc, setDoc] = useState<string | null>(null);
  const [report, setReport] = useState<string | null>(null);
  const reportId = data.reports.find((r) => r.id === report)?.id ?? data.reports[0]?.id ?? null;
  const [docsOpen, setDocsOpen] = useStoredFlag("secoes/ir/documentos", true);
  const docsBox = useRef<HTMLDivElement>(null);
  const variableBox = useRef<HTMLDivElement>(null);
  const reportsBox = useRef<HTMLDivElement>(null);

  const reset = () => {
    setTaxable(null);
    setOther(null);
    setCarne(null);
    setPayment(null);
    setAsset(null);
    setDebt(null);
    setVariable(null);
    setDoc(null);
    setReport(null);
  };
  const chooseYear = (next: number) => {
    setYear(next);
    reset();
  };
  const chooseDeclarant = (id: Id | null) => {
    setDeclarant(id);
    reset();
  };

  const years = useMemo(() => {
    const list = yearOptions(today);
    return list.includes(year) ? list : [...list, year].sort((a, b) => b - a);
  }, [today, year]);
  const yearSelect: SelectOption[] = years.map((y) => ({ id: String(y), label: `Ano-calendário ${y}` }));
  const declarantSelect: SelectOption[] = [
    { id: PROJECT, label: "Projeto inteiro" },
    ...choices.map((c) => ({ id: c.id, label: c.name })),
  ];

  const show = (spec: Spec) => {
    if (locked) {
      notify(tip ?? "");
      return;
    }
    dialog.show(spec);
  };

  // ── DARF ──────────────────────────────

  /** The payment of a DARF: variable income suggests what is still due; the Carnê-Leão has no sum to suggest. */
  const pay = (purpose: tax.model.PaymentPurpose, month: YearMonth, memberId: Id | null) => {
    let suggested: Dec | null = null;
    if (purpose === tax.model.PaymentPurpose.VARIABLE_INCOME) {
      const due = tax.variableIncome
        .dueByMonth(tax.variableIncome.months(ledger, month.year))
        .get(`${month.year}-${String(month.month).padStart(2, "0")}`);
      suggested = due ? due.due.sub(due.paid) : null;
    }
    show({ kind: "payment", purpose, month, memberId: purpose === "carne_leao" ? memberId : null, suggested });
  };

  const payVariable = (index?: number) => {
    let row = index !== undefined ? data.months[index] : undefined;
    if (row === undefined && variable !== null) row = data.months[Number(variable)];
    let month = row?.month ?? null;
    if (month === null) {
      const due = tax.variableIncome.dueByMonth(data.months);
      month = [...due.values()].find((m) => m.paid.lt(m.due))?.month ?? null;
    }
    if (month === null) {
      notify("Escolha o mês na tabela de renda variável.");
      return;
    }
    pay(tax.model.PaymentPurpose.VARIABLE_INCOME, month, null);
  };

  const payCarne = (index?: number) => {
    const item = data.income.carne_leao[index ?? (carne !== null ? Number(carne) : -1)];
    if (item === undefined) {
      notify("Escolha o mês do Carnê-Leão.");
      return;
    }
    pay(tax.model.PaymentPurpose.CARNE_LEAO, item.month, item.member_id);
  };

  // ── the commands of the sheets ────────

  const identity = (subject: tax.model.TaxSubject, ref: string, label: string) =>
    show({ kind: "taxid", subject, ref, label });

  const editPayer = () => {
    const row = taxable !== null ? data.income.taxable[Number(taxable)] : undefined;
    if (row) {
      identity(tax.model.TaxSubject.CATEGORY, row.source_id, row.payer);
      return;
    }
    const found = other !== null ? data.income.other[Number(other)] : undefined;
    if (found && found.subject === tax.model.NatureSubject.CATEGORY) {
      identity(tax.model.TaxSubject.CATEGORY, found.ref, found.source);
      return;
    }
    notify("Escolha uma fonte pagadora.");
  };

  const operations = (ids: readonly Id[], mode: "detail" | "receipts") => show({ kind: "operations", ids, mode });

  const payslips = (index?: number) => {
    const row = data.income.taxable[index ?? (taxable !== null ? Number(taxable) : -1)];
    if (!row) {
      notify("Escolha uma fonte pagadora.");
      return;
    }
    operations(row.operations, "detail");
  };

  const nature = (index?: number) => {
    const row = data.income.other[index ?? (other !== null ? Number(other) : -1)];
    show({ kind: "nature", focus: row ? { subject: row.subject, ref: row.ref } : null });
  };

  const selectedPayment = (index?: number) => data.payments[index ?? (payment !== null ? Number(payment) : -1)];
  const editPayee = () => {
    const row = selectedPayment();
    if (!row) {
      notify("Escolha um pagamento na tabela.");
      return;
    }
    identity(tax.model.TaxSubject.MERCHANT, row.payee_key, row.payee);
  };
  const paymentReceipts = (index?: number) => {
    const row = selectedPayment(index);
    if (!row) {
      notify("Escolha um pagamento na tabela.");
      return;
    }
    operations(row.operations, "receipts");
  };

  const filing = (row: tax.declaration.AssetRow) => {
    if (row.subject === "declared") {
      show({ kind: "asset", assetId: row.ref });
      return;
    }
    show({
      kind: "filing",
      subject: row.subject === "account" ? tax.model.FilingSubject.ACCOUNT : tax.model.FilingSubject.POSITION,
      ref: row.ref,
      name: row.name,
      suggested: row.group,
    });
  };
  const editFiling = (index?: number) => {
    const row = data.assets[index ?? (asset !== null ? Number(asset) : -1)];
    if (!row) {
      notify("Escolha um bem na tabela.");
      return;
    }
    filing(row);
  };
  const editInstitution = () => {
    const row = asset !== null ? data.assets[Number(asset)] : undefined;
    if (!row) {
      notify("Escolha um bem na tabela.");
      return;
    }
    if (row.subject === "declared") {
      notify("Um bem declarado à mão não tem instituição.");
      return;
    }
    let ref: string = row.ref;
    if (row.subject === "position") {
      const held = investments.service.positions(ledger).get(row.ref);
      if (held === undefined) return;
      ref = held.account_id;
    }
    identity(tax.model.TaxSubject.ACCOUNT, ref, row.name);
  };
  const editLender = () => {
    if (debt === null) {
      notify("Escolha uma dívida na tabela.");
      return;
    }
    const account = ledger.accounts.get(debt);
    if (account) identity(tax.model.TaxSubject.ACCOUNT, debt, account.name);
  };

  // ── informes ──────────────────────────

  const openReport = (id: string | undefined = reportId ?? undefined) => {
    const found = id ? tax.records.reports(ledger).get(id) : undefined;
    if (!found) {
      notify("Escolha um informe na tabela.");
      return;
    }
    show({
      kind: "report",
      message: "Informe corrigido.",
      props: {
        year: found.year,
        lines: found.lines,
        payerTaxId: found.payer_tax_id,
        payerName: found.payer_name,
        source: [found.source, found.source_id],
        reportId: found.id,
        documentId: found.document_id,
      },
    });
  };
  const removeReport = async () => {
    const found = reportId ? tax.records.reports(ledger).get(reportId) : undefined;
    if (!found) {
      notify("Escolha um informe na tabela.");
      return;
    }
    const yes = await confirm({
      title: "Remover este informe?",
      text: "O arquivo original continua em Documentos.",
      confirmLabel: "Remover",
      danger: true,
    });
    if (yes) act((l) => tax.records.removeReport(l, found.id), "Informe removido.");
  };
  const reportSaved = (saved: tax.model.IncomeReport) => {
    setReport(saved.id);
    requestAnimationFrame(() => reportsBox.current?.scrollIntoView({ block: "nearest", behavior: "smooth" }));
  };

  const importer = useReportImport(year, (props: ParsedProps) => {
    dialog.show({ kind: "report", props, message: "Informe salvo e comparado com o registrado." });
  });
  const importReport = (from: ReportSourcePick = null) => {
    if (locked) {
      notify(tip ?? "");
      return;
    }
    importer.pick(from);
  };
  const newReport = () => show({ kind: "report", message: "Informe salvo.", props: { year, lines: [] } });

  // ── documents of the year ─────────────

  const openDocument = (index?: number) => {
    const item = data.docs[index ?? (doc !== null ? Number(doc) : -1)];
    if (!item) {
      notify("Escolha um documento na tabela.");
      return;
    }
    if (item.action === "receipts" && Array.isArray(item.ref)) {
      operations(item.ref as Id[], "receipts");
    } else if (item.action === "report" && Array.isArray(item.ref)) {
      const [source, sourceId] = item.ref as [tax.model.ReportSource, Id];
      const existing = tax.records.reportsOf(ledger, year).find((r) => r.source === source && r.source_id === sourceId);
      if (existing) openReport(existing.id);
      else importReport([source, sourceId]);
    } else {
      toggleReceived(index);
    }
  };
  const toggleReceived = (index?: number) => {
    const item = data.docs[index ?? (doc !== null ? Number(doc) : -1)];
    if (!item) {
      notify("Escolha um documento na tabela.");
      return;
    }
    act((l) => tax.records.setMark(l, year, item.key, item.by_hand ? null : !item.received));
  };

  // ── a pending item leads to what resolves it ────

  const showDocuments = () => {
    setDocsOpen(true);
    requestAnimationFrame(() => docsBox.current?.scrollIntoView({ block: "nearest", behavior: "smooth" }));
  };

  const resolve = (issue: tax.issues.Issue) => {
    const ref = issue.ref;
    switch (issue.action) {
      case "identity":
        if (Array.isArray(ref)) {
          const [subject, key] = ref as [tax.model.TaxSubject, string];
          const at = issue.title.indexOf(": ");
          identity(subject, key, at < 0 ? issue.title : issue.title.slice(at + 2));
        }
        break;
      case "member":
        if (typeof ref === "string") show({ kind: "member", memberId: ref });
        break;
      case "nature":
        if (Array.isArray(ref)) {
          const [subject, id] = ref as [tax.model.NatureSubject, Id];
          show({ kind: "nature", focus: { subject, ref: id } });
        } else show({ kind: "nature", focus: null });
        break;
      case "filing": {
        const [subject, id] = (ref as [string, Id] | null) ?? ["", ""];
        const row = data.assets.find((r) => r.subject === subject && r.ref === id);
        if (row) filing(row);
        break;
      }
      case "detail":
      case "receipts":
        if (Array.isArray(ref)) operations(ref as Id[], issue.action);
        break;
      case "report":
        if (typeof ref === "string") openReport(ref);
        break;
      case "checklist":
        showDocuments();
        break;
      case "rules":
        show({ kind: "rules" });
        break;
      case "params":
        show({ kind: "params", year });
        break;
      case "payment":
        if (Array.isArray(ref)) {
          const [purpose, month, member] = ref as [tax.model.PaymentPurpose, YearMonth, Id | undefined];
          pay(purpose, month, member ?? null);
        }
        break;
      case "investments":
        goTo("investimentos", typeof ref === "string" ? { ref } : {});
        break;
      case "ledger":
        goTo("livro");
        break;
    }
  };

  // ── links from other screens ──────────

  useReveal((ref, action) => {
    const target = parseReveal(ref);
    if (target === null) return;
    if (target.kind === "year") {
      chooseYear(target.year);
      return;
    }
    chooseYear(target.month.year);
    requestAnimationFrame(() => variableBox.current?.scrollIntoView({ block: "nearest", behavior: "smooth" }));
    if (action === "darf" && !locked) pay(target.purpose, target.month, target.memberId);
  });

  const printReport = () =>
    void navigate({
      to: "/imprimir/imposto",
      search: { ano: String(year), ...(who ? { declarante: who } : {}), imprimir: "1" },
    });

  const figures = [
    {
      label: "Rendimentos tributáveis",
      value: <Money value={data.comparison.taxable} />,
    },
    { label: "Imposto retido", value: <Money value={data.withheld} /> },
    { label: "Deduções registradas", value: <Money value={data.deductions} /> },
    {
      label: "Pendências",
      value: String(data.issues.length),
      ...(data.urgent ? { tone: "negative" as const, note: `${data.urgent} para corrigir` } : {}),
    },
  ];

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Imposto de renda"
        context={summaryLine(year, whoName)}
        primary={
          <Button
            variant="primary"
            icon={<FileUp />}
            busy={importer.busy}
            onClick={() => importReport()}
            disabled={locked}
            title={locked ? tip : "PDF do banco, da corretora ou do empregador"}
          >
            Importar informe…
          </Button>
        }
        actions={
          <>
            <MenuButton
              label="Cadastros"
              items={[
                { id: "people", label: "Declarantes e dependentes…", onSelect: () => peopleDialog() },
                {
                  id: "nature",
                  label: "Natureza dos rendimentos…",
                  onSelect: () => show({ kind: "nature", focus: null }),
                },
                {
                  id: "asset",
                  label: "Novo bem (imóvel, veículo)…",
                  onSelect: () => show({ kind: "asset", assetId: null }),
                },
                { kind: "separator", id: "sep" },
                { id: "params", label: "Tabela e limites do ano…", onSelect: () => show({ kind: "params", year }) },
                { id: "rules", label: "Regras de renda variável…", onSelect: () => show({ kind: "rules" }) },
              ]}
            />
            <MenuButton
              label="Mais"
              items={[
                { id: "new-report", label: "Novo informe sem arquivo…", onSelect: newReport },
                {
                  id: "pdf",
                  label: "Relatório para a declaração (PDF)…",
                  icon: <FileDown />,
                  onSelect: printReport,
                },
              ]}
            />
          </>
        }
      >
        <div className="w-60">
          <Select
            label="Ano-calendário"
            hideLabel
            options={yearSelect}
            value={String(year)}
            onChange={(id) => chooseYear(Number(id))}
          />
        </div>
        <div className="w-48">
          <Select
            label="Declarante"
            hideLabel
            options={declarantSelect}
            value={who ?? PROJECT}
            onChange={(id) => chooseDeclarant(id === PROJECT ? null : id)}
          />
        </div>
      </PageHeader>

      {data.hasAny ? (
        <>
          <section
            aria-label="Resumo do ano"
            className="min-w-0 rounded-xl border border-separator bg-raised p-5 shadow-sm"
          >
            <FigureRow figures={figures} min="11.5rem" />
            <p className="mt-4 text-caption text-secondary">{tax.declaration.NOTICE}</p>
          </section>

          <Adaptive at={1300} columns="3fr 2fr" gap={24}>
            <Collapsible
              title={data.issues.length ? `Pendências · ${data.issues.length}` : "Pendências"}
              prefKey="ir/pendencias"
            >
              <IssueList issues={data.issues} onResolve={resolve} />
            </Collapsible>
            <div ref={docsBox} className="min-w-0">
              <DocumentsSection
                data={data}
                selected={doc}
                onSelect={setDoc}
                open={docsOpen}
                onOpenChange={setDocsOpen}
                onOpenItem={openDocument}
                onToggle={() => toggleReceived()}
              />
            </div>
          </Adaptive>

          <IncomeSection
            data={data}
            names={names}
            taxable={taxable}
            other={other}
            carne={carne}
            onTaxable={setTaxable}
            onOther={setOther}
            onCarne={setCarne}
            onPayer={editPayer}
            onPayslips={payslips}
            onNature={nature}
            onDarf={payCarne}
          />
          <PaymentsSection
            data={data}
            names={names}
            selected={payment}
            onSelect={setPayment}
            onPayee={editPayee}
            onReceipts={paymentReceipts}
          />
          <Adaptive at={1300} columns="3fr 2fr" gap={24}>
            <AssetsSection
              data={data}
              selected={asset}
              onSelect={setAsset}
              onFiling={editFiling}
              onInstitution={editInstitution}
              onNew={() => show({ kind: "asset", assetId: null })}
            />
            {data.debts.length ? (
              <DebtsSection data={data} selected={debt} onSelect={setDebt} onLender={editLender} />
            ) : (
              <span />
            )}
          </Adaptive>
          {data.months.length ? (
            <div ref={variableBox} className="min-w-0">
              <VariableSection
                data={data}
                selected={variable}
                onSelect={setVariable}
                onDarf={payVariable}
                onRules={() => show({ kind: "rules" })}
              />
            </div>
          ) : null}
          <Adaptive at={1300} columns="2fr 3fr" gap={24}>
            <SimulationSection data={data} onParams={() => show({ kind: "params", year })} />
            <div ref={reportsBox} className="min-w-0">
              <ReportsSection
                data={data}
                selected={reportId}
                onSelect={setReport}
                onOpen={openReport}
                onRemove={() => void removeReport()}
              />
            </div>
          </Adaptive>
        </>
      ) : (
        <div className="rounded-xl border border-dashed border-separator-strong bg-window/40">
          <EmptyState
            title="Nada registrado neste ano"
            description="A página organiza o ano nas fichas da declaração assim que houver lançamentos. Escolha outro ano acima ou registre receitas e despesas no Livro financeiro."
            actions={
              <Button variant="primary" onClick={() => goTo("livro")}>
                Abrir o Livro financeiro
              </Button>
            }
          />
        </div>
      )}

      <DialogHost
        spec={dialog.spec}
        open={dialog.open}
        dialogKey={dialog.key}
        onClose={dialog.close}
        onReportSaved={reportSaved}
      />
      {importer.nodes}
    </div>
  );

  function peopleDialog() {
    if (ledger.members.size === 0) {
      notify("Cadastre os integrantes em Contas e cartões › Integrantes.");
      return;
    }
    show({ kind: "people" });
  }
}
