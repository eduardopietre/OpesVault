/**
 * The sheets of the Imposto de renda page (desktop `TaxPage` sections): documents of the year, income,
 * payments, assets and debts, variable income, the simplified × complete simulation and the informes. Each is a
 * collapsible section with its own commands on the title line; the rows come from `rows.ts`, the choice of a
 * row is by id, and a command that needs a row says so when none is chosen.
 */
import { tax } from "@opesvault/domain";
import { Collapsible, useMotionPreset } from "@opesvault/ui";
import { motion } from "motion/react";
import type { ReactNode } from "react";
import { EditButton } from "../../components/list_parts.tsx";
import {
  ASSETS,
  CARNE,
  CHECKS,
  DEBTS,
  DOCUMENTS,
  OTHER,
  PAYMENTS,
  REPORTS,
  SIMULATION,
  TAXABLE,
  VARIABLE,
} from "./columns.tsx";
import type { YearData } from "./data.ts";
import {
  assetRows,
  carneLeaoRows,
  checkRows,
  debtRows,
  documentRows,
  otherIncomeRows,
  paymentRows,
  reportRows,
  simulationNotes,
  simulationRows,
  taxableRows,
  variableNotes,
  variableRows,
  type Names,
} from "./rows.ts";
import { SheetTable } from "./sheet.tsx";
import { useLedger } from "../../data/react.tsx";

const Caption = ({ children }: { children: ReactNode }) => (
  <p className="mt-2 text-caption text-secondary [overflow-wrap:anywhere]">{children}</p>
);

/** What a sheet says when it has no rows: what it is for and where its rows come from. */
const Hint = ({ children }: { children: ReactNode }) => (
  <p className="text-body text-secondary [overflow-wrap:anywhere]">{children}</p>
);

/** A table that comes in with a short fade when its rows first appear. */
function Fade({ children }: { children: ReactNode }) {
  const preset = useMotionPreset();
  return <motion.div {...preset.enter}>{children}</motion.div>;
}

const Subtitle = ({ children }: { children: ReactNode }) => (
  <h3 className="mt-5 mb-2 text-body font-semibold first:mt-0">{children}</h3>
);

// ── documents of the year ────────────────────────

export interface DocumentsSectionProps {
  data: YearData;
  selected: string | null;
  onSelect: (id: string) => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onOpenItem: (index?: number) => void;
  onToggle: () => void;
}

export function DocumentsSection({
  data,
  selected,
  onSelect,
  open,
  onOpenChange,
  onOpenItem,
  onToggle,
}: DocumentsSectionProps) {
  const missing = tax.checklist.missing(data.docs).length;
  const rows = documentRows(data.docs);
  const chosen = selected !== null ? data.docs[Number(selected)] : undefined;
  return (
    <Collapsible
      title={missing ? `Documentos do ano · faltam ${missing}` : "Documentos do ano"}
      description="Informes e comprovantes que a declaração pede."
      open={open}
      onOpenChange={onOpenChange}
    >
      {rows.length ? (
        <>
          {/* in the body, not on the title line: the title ("faltam 6") would be cut on a phone */}
          <div className="mb-2 flex flex-wrap gap-2">
            <EditButton onClick={() => onOpenItem()}>Abrir…</EditButton>
            <EditButton onClick={onToggle}>Recebido / não recebido</EditButton>
          </div>
          <SheetTable
            label="Documentos do ano"
            cols={DOCUMENTS}
            rows={rows}
            selectedId={selected}
            onSelect={onSelect}
            onActivate={(id) => onOpenItem(Number(id))}
            max={12}
          />
          {chosen ? <Caption>{chosen.detail}</Caption> : null}
        </>
      ) : (
        <Hint>Nenhum documento esperado: o ano ainda não tem contas com movimento nem pagamentos dedutíveis.</Hint>
      )}
    </Collapsible>
  );
}

// ── income ───────────────────────────────────────

export interface IncomeSectionProps {
  data: YearData;
  names: Names;
  taxable: string | null;
  other: string | null;
  carne: string | null;
  onTaxable: (id: string) => void;
  onOther: (id: string) => void;
  onCarne: (id: string) => void;
  onPayer: () => void;
  onPayslips: (index?: number) => void;
  onNature: (index?: number) => void;
  onDarf: (index?: number) => void;
}

export function IncomeSection(props: IncomeSectionProps) {
  const { data, names } = props;
  const taxable = taxableRows(data.income, names);
  const other = otherIncomeRows(data.income, names);
  const carne = carneLeaoRows(data.income, names);
  return (
    <Collapsible
      title="Rendimentos"
      prefKey="ir/rendimentos"
      description="Pelo regime de caixa (data do dinheiro). Sem o contracheque, o depósito conta pelo líquido."
      actions={
        <>
          <EditButton onClick={props.onPayer}>CNPJ da fonte…</EditButton>
          <EditButton onClick={() => props.onPayslips()}>Contracheques…</EditButton>
          <EditButton variant="ghost" onClick={() => props.onNature()}>
            Natureza…
          </EditButton>
        </>
      }
    >
      {!taxable.length && !other.length ? (
        <Hint>
          Nenhuma receita no ano. Salários, aluguéis e rendimentos aparecem aqui conforme a natureza de cada categoria
          (Cadastros › Natureza dos rendimentos).
        </Hint>
      ) : null}
      {taxable.length ? (
        <Fade>
          <Subtitle>Tributáveis recebidos de pessoa jurídica</Subtitle>
          <SheetTable
            label="Rendimentos tributáveis de pessoa jurídica"
            cols={TAXABLE}
            rows={taxable}
            selectedId={props.taxable}
            onSelect={props.onTaxable}
            onActivate={(id) => props.onPayslips(Number(id))}
            max={10}
          />
          {data.income.taxable.some((r) => r.net_only) ? (
            <Caption>* Depósito contado pelo valor líquido, porque o contracheque não foi detalhado.</Caption>
          ) : null}
        </Fade>
      ) : null}
      {other.length ? (
        <Fade>
          <Subtitle>Isentos, exclusivos, Carnê-Leão e a classificar</Subtitle>
          <SheetTable
            label="Rendimentos isentos, exclusivos e do Carnê-Leão"
            cols={OTHER}
            rows={other}
            selectedId={props.other}
            onSelect={props.onOther}
            onActivate={(id) => props.onNature(Number(id))}
            max={12}
            titleCell={1}
          />
        </Fade>
      ) : null}
      {carne.length ? (
        <Fade>
          <Subtitle>Carnê-Leão mês a mês (o imposto é calculado no Carnê-Leão Web)</Subtitle>
          <SheetTable
            label="Carnê-Leão mês a mês"
            cols={CARNE}
            rows={carne}
            selectedId={props.carne}
            onSelect={props.onCarne}
            onActivate={(id) => props.onDarf(Number(id))}
            max={12}
          />
          <div className="mt-2">
            <EditButton variant="ghost" onClick={() => props.onDarf()}>
              Registrar DARF do Carnê-Leão…
            </EditButton>
          </div>
        </Fade>
      ) : null}
    </Collapsible>
  );
}

// ── payments ─────────────────────────────────────

export interface PaymentsSectionProps {
  data: YearData;
  names: Names;
  selected: string | null;
  onSelect: (id: string) => void;
  onPayee: () => void;
  onReceipts: (index?: number) => void;
}

export function PaymentsSection({ data, names, selected, onSelect, onPayee, onReceipts }: PaymentsSectionProps) {
  const rows = paymentRows(data.payments, names);
  return (
    <Collapsible
      title="Pagamentos efetuados"
      prefKey="ir/pagamentos"
      description="Despesas das categorias marcadas como dedutíveis. A parte reembolsada (plano de saúde, empresa) é a parcela não dedutível."
      actions={
        <>
          <EditButton onClick={onPayee}>CPF/CNPJ…</EditButton>
          <EditButton variant="ghost" onClick={() => onReceipts()}>
            Comprovantes…
          </EditButton>
        </>
      }
    >
      {rows.length ? (
        <SheetTable
          label="Pagamentos efetuados"
          cols={PAYMENTS}
          rows={rows}
          selectedId={selected}
          onSelect={onSelect}
          onActivate={(id) => onReceipts(Number(id))}
          max={14}
          titleCell={1}
        />
      ) : (
        <Hint>
          Nenhum pagamento dedutível no ano. Marque as categorias em Contas e cartões › Categorias › Dedutível no IR
          (saúde, educação, previdência privada, pensão).
        </Hint>
      )}
    </Collapsible>
  );
}

// ── assets and debts ─────────────────────────────

export interface AssetsSectionProps {
  data: YearData;
  selected: string | null;
  onSelect: (id: string) => void;
  onFiling: (index?: number) => void;
  onInstitution: () => void;
  onNew: () => void;
}

export function AssetsSection({ data, selected, onSelect, onFiling, onInstitution, onNew }: AssetsSectionProps) {
  const rows = assetRows(data.assets);
  return (
    <Collapsible
      title="Bens e direitos"
      prefKey="ir/bens"
      description="Pelo custo de aquisição do que ainda é seu, nunca pelo valor de mercado."
      actions={
        <>
          <EditButton onClick={() => onFiling()}>Classificar…</EditButton>
          <EditButton variant="ghost" onClick={onInstitution}>
            CNPJ…
          </EditButton>
          <EditButton variant="ghost" onClick={onNew}>
            Novo bem…
          </EditButton>
        </>
      }
    >
      {rows.length ? (
        <>
          <SheetTable
            label="Bens e direitos"
            cols={ASSETS}
            rows={rows}
            selectedId={selected}
            onSelect={onSelect}
            onActivate={(id) => onFiling(Number(id))}
            max={16}
            titleCell={2}
          />
          {selected !== null && data.assets[Number(selected)] ? (
            <Caption>{tax.declaration.groupLabel(data.assets[Number(selected)]!)}</Caption>
          ) : null}
        </>
      ) : (
        <Hint>Nenhum bem com saldo ou custo no fim do ano.</Hint>
      )}
    </Collapsible>
  );
}

export interface DebtsSectionProps {
  data: YearData;
  selected: string | null;
  onSelect: (id: string) => void;
  onLender: () => void;
}

export function DebtsSection({ data, selected, onSelect, onLender }: DebtsSectionProps) {
  const rows = debtRows(data.debts);
  return (
    <Collapsible
      title="Dívidas e ônus"
      prefKey="ir/dividas"
      description="Financiamentos e empréstimos. Faturas de cartão ficam de fora."
      actions={
        <EditButton variant="ghost" onClick={onLender}>
          CNPJ…
        </EditButton>
      }
    >
      <SheetTable
        label="Dívidas e ônus reais"
        cols={DEBTS}
        rows={rows}
        selectedId={selected}
        onSelect={onSelect}
        onActivate={() => onLender()}
        max={8}
      />
    </Collapsible>
  );
}

// ── variable income ──────────────────────────────

export interface VariableSectionProps {
  data: YearData;
  selected: string | null;
  onSelect: (id: string) => void;
  onDarf: (index?: number) => void;
  onRules: () => void;
}

export function VariableSection({ data, selected, onSelect, onDarf, onRules }: VariableSectionProps) {
  return (
    <Collapsible
      title="Renda variável"
      prefKey="ir/renda_variavel"
      description="Vendas de ações, ETF e fundos imobiliários, mês a mês, com as alíquotas que você informou."
      actions={
        <>
          <EditButton onClick={() => onDarf()}>Registrar DARF…</EditButton>
          <EditButton variant="ghost" onClick={onRules}>
            Regras…
          </EditButton>
        </>
      }
    >
      <SheetTable
        label="Renda variável mês a mês"
        cols={VARIABLE}
        rows={variableRows(data.months)}
        selectedId={selected}
        onSelect={onSelect}
        onActivate={(id) => onDarf(Number(id))}
        max={14}
        titleCell={0}
      />
      <Caption>{variableNotes(data.months, data.carried)}</Caption>
    </Collapsible>
  );
}

// ── simulation ───────────────────────────────────

export function SimulationSection({ data, onParams }: { data: YearData; onParams: () => void }) {
  const unknown = data.comparison.missing.length > 0;
  return (
    <Collapsible
      title="Simplificada ou completa"
      prefKey="ir/simulacao"
      description={tax.simulation.NOTICE}
      actions={
        <EditButton variant="ghost" onClick={onParams}>
          Tabela do ano…
        </EditButton>
      }
    >
      <SheetTable label="Simplificada ou completa" cols={SIMULATION} rows={simulationRows(data.comparison)} max={8} />
      <Caption>{simulationNotes(data.comparison)}</Caption>
      {unknown ? (
        <p className="mt-1 text-caption text-secondary">
          Sem a tabela e os limites do ano, o imposto fica desconhecido (—), não zero.
        </p>
      ) : null}
    </Collapsible>
  );
}

// ── informes ─────────────────────────────────────

export interface ReportsSectionProps {
  data: YearData;
  selected: string | null;
  onSelect: (id: string) => void;
  onOpen: (id?: string) => void;
  onRemove: () => void;
}

export function ReportsSection({ data, selected, onSelect, onOpen, onRemove }: ReportsSectionProps) {
  const rows = useLedger((ledger) => reportRows(ledger, data.reports), data.reports.map((r) => r.id).join(","));
  const checks = useLedger((ledger) => {
    const report = data.reports.find((r) => r.id === selected);
    return report ? checkRows(tax.statements.check(ledger, report)) : [];
  }, `${selected}`);
  return (
    <Collapsible
      title="Informes"
      prefKey="ir/informes"
      description="Cada informe comparado com o que foi registrado; uma diferença aponta lançamento faltando ou errado."
      actions={
        <>
          <EditButton onClick={() => onOpen()}>Abrir…</EditButton>
          <EditButton variant="ghost" onClick={onRemove}>
            Remover
          </EditButton>
        </>
      }
    >
      {rows.length ? (
        <>
          <SheetTable
            label="Informes de rendimentos"
            cols={REPORTS}
            rows={rows}
            selectedId={selected}
            onSelect={onSelect}
            onActivate={onOpen}
            max={8}
          />
          <Subtitle>Informe comparado com o registrado</Subtitle>
          <SheetTable label="Informe comparado com o registrado" cols={CHECKS} rows={checks} max={8} />
        </>
      ) : (
        <Hint>
          Nenhum informe deste ano. Importe o PDF do banco, da corretora ou do empregador para comparar com o que foi
          registrado.
        </Hint>
      )}
    </Collapsible>
  );
}
