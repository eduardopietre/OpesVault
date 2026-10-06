/**
 * The report for the return as data: the same sections and figures, in the same order, as the domain's
 * `exporting.taxReportHtml` (rendimentos, pagamentos, bens, dívidas, renda variável, simulação, pendências),
 * so the print view can draw them with React instead of injecting HTML. A test compares the two section by
 * section.
 */
import { dom, exporting, formatDateBr, tax, type Id, type IsoDate, type Ledger } from "@opesvault/domain";
import type { ReportTable } from "../visao-geral/report.ts";

export interface ReportSection {
  id: string;
  title: string;
  /** A note under the title. */
  note?: string;
  table?: ReportTable;
  /** A plain paragraph. */
  text?: string;
  items?: readonly string[];
}

export interface TaxReportData {
  project: string;
  year: number;
  /** The declarant's name, or "todo o projeto". */
  who: string;
  /** The file leaves the project's protection. */
  warning: string;
  notice: string;
  /** The declarant's CPF as printed ("falta" when unknown); null for the whole project. */
  cpf: string | null;
  sections: readonly ReportSection[];
}

const nums = (...indexes: number[]) => indexes;

export function taxReportData(ledger: Ledger, year: number, today: IsoDate, declarantId: Id | null): TaxReportData {
  const people = tax.records.peopleOf(ledger, declarantId);
  const person = (memberId: Id | null): string => {
    const member = memberId ? ledger.members.get(memberId) : undefined;
    return member ? member.name : "—";
  };
  const tid = (value: string | null): string => (value ? tax.ids.display(value) : "falta");
  const found = tax.declaration.income(ledger, year, people);
  const sections: ReportSection[] = [];
  let cpf: string | null = null;

  if (declarantId) {
    const info = tax.records.memberInfo(ledger, declarantId);
    cpf = tid(info ? info.cpf : null);
    const deps = tax.declaration.dependents(ledger, declarantId);
    if (deps.length) {
      sections.push({
        id: "dependentes",
        title: "Dependentes",
        table: {
          id: "dependentes",
          title: "Dependentes",
          headers: ["Nome", "CPF", "Nascimento", "Relação"],
          numeric: [],
          rows: deps.map((d) => [
            d.name,
            tid(d.cpf),
            d.birth_date ? formatDateBr(d.birth_date) : "—",
            d.relation || "—",
          ]),
        },
      });
    }
  }

  const taxableTitle = "Rendimentos tributáveis recebidos de pessoa jurídica";
  sections.push({
    id: "tributaveis",
    title: taxableTitle,
    table: {
      id: "tributaveis",
      title: taxableTitle,
      headers: ["Fonte pagadora", "CNPJ", "Integrante", "Rendimentos", "INSS", "IR retido", "13º", "IR 13º"],
      numeric: nums(3, 4, 5, 6, 7),
      rows: found.taxable.map((r) => [
        r.payer,
        tid(r.tax_id),
        person(r.member_id),
        r.taxable,
        r.social_security,
        r.withheld,
        r.thirteenth,
        r.thirteenth_withheld,
      ]),
    },
  });

  for (const nature of [
    tax.model.IncomeNature.CARNE_LEAO,
    tax.model.IncomeNature.EXEMPT,
    tax.model.IncomeNature.EXCLUSIVE,
    null,
  ] as const) {
    const rows = tax.declaration.byNature(found, nature);
    if (!rows.length) continue;
    const title = nature ? tax.model.NATURE_LABELS[nature] : "Rendimentos sem natureza definida (a classificar)";
    sections.push({
      id: `natureza-${nature ?? "indefinida"}`,
      title,
      table: {
        id: `natureza-${nature ?? "indefinida"}`,
        title,
        headers: ["Fonte", "CNPJ", "Integrante", "Valor", "IR retido"],
        numeric: nums(3, 4),
        rows: rows.map((r) => [
          r.source,
          (r.tax_id && tax.ids.display(r.tax_id)) || "—",
          person(r.member_id),
          r.amount,
          r.withheld,
        ]),
      },
    });
  }

  const payments = tax.declaration.payments(ledger, year, people);
  if (payments.length) {
    sections.push({
      id: "pagamentos",
      title: "Pagamentos efetuados",
      table: {
        id: "pagamentos",
        title: "Pagamentos efetuados",
        headers: ["Tipo", "Quem recebeu", "CPF/CNPJ", "Beneficiário", "Pago", "Parcela não dedutível"],
        numeric: nums(4, 5),
        rows: payments.map((r) => [
          dom.deductibles.KIND_LABELS[r.kind],
          r.payee,
          tid(r.tax_id),
          person(r.beneficiary_id),
          r.paid,
          r.not_deductible,
        ]),
      },
    });
  }

  sections.push({
    id: "bens",
    title: "Bens e direitos (custo de aquisição)",
    table: {
      id: "bens",
      title: "Bens e direitos (custo de aquisição)",
      headers: ["Grupo", "Código", "Discriminação", "CNPJ", `31/12/${year - 1}`, `31/12/${year}`],
      numeric: nums(4, 5),
      rows: tax.declaration
        .assets(ledger, year, people)
        .map((r) => [
          `${r.group || "—"}${r.suggested ? " (sugerido)" : ""}`,
          r.code || "—",
          r.description,
          r.subject !== "declared" ? tid(r.tax_id) : "—",
          r.previous,
          r.current,
        ]),
    },
  });

  const debts = tax.declaration.debts(ledger, year, people);
  if (debts.length) {
    sections.push({
      id: "dividas",
      title: "Dívidas e ônus reais",
      table: {
        id: "dividas",
        title: "Dívidas e ônus reais",
        headers: ["Dívida", "CNPJ", `31/12/${year - 1}`, `31/12/${year}`],
        numeric: nums(2, 3),
        rows: debts.map((d) => [d.name, tid(d.tax_id), d.previous.abs(), d.current.abs()]),
      },
    });
  }

  const months = tax.variableIncome.months(ledger, year, people);
  if (months.length) {
    sections.push({
      id: "renda-variavel",
      title: "Renda variável",
      table: {
        id: "renda-variavel",
        title: "Renda variável",
        headers: ["Mês", "Tipo", "Vendas", "Resultado", "Isento", "Base", "Imposto", "IR fonte", "DARF pago"],
        numeric: nums(2, 3, 4, 5, 6, 7, 8),
        rows: months.map((r) => [
          `${String(r.month.month).padStart(2, "0")}/${r.month.year}`,
          tax.model.BUCKET_LABELS[r.bucket],
          r.sales,
          r.result,
          r.exempt_gain,
          r.base,
          r.tax,
          r.withheld,
          r.paid,
        ]),
      },
    });
  }

  const comparison = tax.simulation.compare(ledger, year, declarantId);
  const simulation: ReportSection = {
    id: "simulacao",
    title: "Simplificada ou completa (simulação)",
    note: tax.simulation.NOTICE,
    ...(comparison.missing.length
      ? { text: `Falta informar: ${comparison.missing.join(", ")}.` }
      : {
          table: {
            id: "simulacao",
            title: "Simplificada ou completa (simulação)",
            headers: ["", "Simplificada", "Completa"],
            numeric: nums(1, 2),
            rows: [
              ["Base de cálculo", comparison.simplified?.base ?? null, comparison.itemized?.base ?? null],
              ["Imposto devido", comparison.simplified?.tax ?? null, comparison.itemized?.tax ?? null],
            ],
          },
        }),
  };
  sections.push(simulation);

  const pending = tax.issues.issues(ledger, year, declarantId, today);
  const absent = tax.checklist.missing(tax.checklist.expected(ledger, year, people));
  if (pending.length || absent.length) {
    sections.push({
      id: "pendencias",
      title: "Pendências e documentos que faltam",
      items: [...pending.map((i) => `${i.title} — ${i.detail}`), ...absent.map((d) => d.title)],
    });
  }

  return {
    project: ledger.meta.family_name || "Projeto",
    year,
    who: declarantId ? person(declarantId) : "todo o projeto",
    warning: exporting.WARNING,
    notice: tax.declaration.NOTICE,
    cpf,
    sections,
  };
}

/** The same report as the domain's HTML file (for the download). */
export function taxReportFile(ledger: Ledger, year: number, today: IsoDate, declarantId: Id | null): string {
  return exporting.taxReportHtml(ledger, year, today, declarantId);
}

/** File name of the report ("declaracao-2025.html"). */
export function taxReportFileName(year: number, extension: string): string {
  return `declaracao-${year}.${extension}`;
}
