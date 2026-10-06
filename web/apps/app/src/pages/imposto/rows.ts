/**
 * What each sheet of the Imposto de renda page shows, as plain rows and notes without React (desktop
 * `ui/pages/tax/rows.py`, testable on its own).
 *
 * Every builder returns rows with an `id` (the index in the domain's list, or the object's own id), so a
 * command on the selected row finds what it refers to. An unknown amount reads "—" or "falta", never zero
 * (docs/00 §5).
 */
import {
  cashDate,
  dom,
  formatBrl,
  formatDateBr,
  tax,
  type Dec,
  type Id,
  type IsoDate,
  type Ledger,
  type YearMonth,
} from "@opesvault/domain";

export interface Row {
  id: string;
  cells: string[];
}

/** Member id to name ("—" when none). */
export type Names = (memberId: Id | null) => string;

export const SEVERITY_WORDS: Readonly<Record<dom.alerts.Severity, string>> = {
  urgent: "Corrigir",
  soon: "Em breve",
  info: "Conferir",
};
export type IssueTone = "negative" | "warning" | "neutral";
export const SEVERITY_TONES: Readonly<Record<dom.alerts.Severity, IssueTone>> = {
  urgent: "negative",
  soon: "warning",
  info: "neutral",
};

export const DASH = "—";

/** Money, or "—" when unknown. */
export const fmt = (value: Dec | null | undefined): string =>
  value === null || value === undefined ? DASH : formatBrl(value);
/** A date, or "—". */
export const fmtDate = (value: IsoDate | null | undefined): string => (value ? formatDateBr(value) : DASH);
/** Money only when there is something (a non-zero amount), else "—". */
const optional = (value: Dec | null | undefined): string => (value && !value.isZero() ? formatBrl(value) : DASH);
export const monthText = (month: YearMonth): string => `${String(month.month).padStart(2, "0")}/${month.year}`;

/** A CPF or CNPJ formatted for reading, or "falta" when the declaration needs one. */
export function taxId(value: string | null | undefined): string {
  return value ? tax.ids.display(value) : "falta";
}

// ── pending items and documents ──────────────────

/** What a pending item opens (`Issue.action` of the domain) and the label of its button. */
export const ISSUE_ACTIONS: Readonly<Record<string, string>> = {
  identity: "Informar CPF/CNPJ…",
  member: "Dados fiscais…",
  nature: "Definir natureza…",
  filing: "Classificar…",
  detail: "Contracheques…",
  receipts: "Comprovantes…",
  report: "Ver informe…",
  checklist: "Ver documentos",
  rules: "Regras…",
  params: "Tabela do ano…",
  payment: "Registrar DARF…",
  investments: "Ver investimento",
  ledger: "Ver no Livro",
};

export function issueRows(found: readonly tax.issues.Issue[]): Row[] {
  return found.map((issue, index) => ({
    id: String(index),
    cells: [SEVERITY_WORDS[issue.severity], issue.title, issue.detail],
  }));
}

export function documentRows(found: readonly tax.checklist.Expected[]): Row[] {
  return found.map((item, index) => ({
    id: String(index),
    cells: [item.title, (item.received ? "Recebido" : "Falta") + (item.by_hand ? " (marcado)" : "")],
  }));
}

// ── income ───────────────────────────────────────

/** Salaries and other income from companies; "*" marks a deposit counted by its net amount. */
export function taxableRows(found: tax.declaration.Income, name: Names): Row[] {
  return found.taxable.map((r, index) => ({
    id: String(index),
    cells: [
      r.payer,
      taxId(r.tax_id),
      name(r.member_id),
      fmt(r.taxable) + (r.net_only ? " *" : ""),
      fmt(r.social_security),
      fmt(r.withheld),
      fmt(r.thirteenth),
      fmt(r.thirteenth_withheld),
    ],
  }));
}

export function otherIncomeRows(found: tax.declaration.Income, name: Names): Row[] {
  return found.other.map((r, index) => ({
    id: String(index),
    cells: [
      r.nature ? tax.model.NATURE_SHORT[r.nature] + (r.code ? ` (${r.code})` : "") : "A definir",
      r.source,
      r.subject === tax.model.NatureSubject.CATEGORY || r.tax_id ? taxId(r.tax_id) : DASH,
      name(r.member_id),
      fmt(r.amount),
      optional(r.withheld),
    ],
  }));
}

export function carneLeaoRows(found: tax.declaration.Income, name: Names): Row[] {
  return found.carne_leao.map((m, index) => ({
    id: String(index),
    cells: [
      monthText(m.month),
      name(m.member_id),
      fmt(m.amount),
      m.paid.isZero() ? "não registrado" : fmt(m.paid),
      fmtDate(tax.variableIncome.dueDate(m.month)),
    ],
  }));
}

// ── payments, assets, debts ──────────────────────

export function paymentRows(found: readonly tax.declaration.PaymentRow[], name: Names): Row[] {
  return found.map((r, index) => {
    const count = r.operations.length;
    return {
      id: String(index),
      cells: [
        dom.deductibles.KIND_LABELS[r.kind],
        r.payee,
        taxId(r.tax_id),
        name(r.beneficiary_id),
        fmt(r.paid),
        optional(r.not_deductible),
        fmt(tax.declaration.paymentNet(r)),
        `${count - r.without_receipt} de ${count}`,
      ],
    };
  });
}

/** A group the app suggested says so: the user decides the filing (CLAUDE.md, imposto de renda). */
export function assetRows(found: readonly tax.declaration.AssetRow[]): Row[] {
  return found.map((r, index) => ({
    id: String(index),
    cells: [
      (r.group || "a definir") + (r.suggested && r.group ? " (sugerido)" : ""),
      r.code || DASH,
      r.name,
      r.description,
      r.subject !== "declared" ? taxId(r.tax_id) : DASH,
      fmt(r.previous),
      fmt(r.current),
    ],
  }));
}

export function debtRows(found: readonly tax.declaration.DebtRow[]): Row[] {
  return found.map((d) => ({
    id: d.account_id,
    cells: [d.name, taxId(d.tax_id), fmt(d.previous.abs()), fmt(d.current.abs())],
  }));
}

// ── variable income ──────────────────────────────

export function variableRows(found: readonly tax.variableIncome.MonthResult[]): Row[] {
  return found.map((r, index) => ({
    id: String(index),
    cells: [
      monthText(r.month),
      tax.model.BUCKET_LABELS[r.bucket] + (r.approximate ? " *" : ""),
      fmt(r.sales),
      fmt(r.result),
      optional(r.exempt_gain),
      optional(r.compensated),
      fmt(r.base),
      fmt(r.tax),
      optional(r.withheld),
      fmt(r.due),
      fmtDate(r.due_date),
      optional(r.paid),
    ],
  }));
}

export function variableNotes(
  found: readonly tax.variableIncome.MonthResult[],
  carried: ReadonlyMap<tax.model.Bucket, Dec>,
): string {
  const notes: string[] = [];
  const losses = [...carried]
    .filter(([, value]) => !value.isZero())
    .map(([bucket, value]) => `${tax.model.BUCKET_LABELS[bucket]}: ${fmt(value)}`);
  if (losses.length) notes.push("Prejuízo a compensar no fim do ano — " + losses.join("; ") + ".");
  if (found.some((r) => r.approximate)) {
    notes.push("* Day trade separado pelo preço médio das compras do mesmo dia; confira com a nota.");
  }
  if (found.some((r) => tax.variableIncome.missingRate(r))) {
    notes.push("Há base tributável sem alíquota: informe em Regras… (o imposto fica desconhecido).");
  }
  notes.push("O vencimento é o último dia útil do mês seguinte sem contar feriados; confira a data.");
  return notes.join(" ");
}

// ── simulation ───────────────────────────────────

/** The two models side by side; a model that cannot be computed shows "—" in every cell. */
export function simulationRows(comparison: tax.simulation.Comparison): Row[] {
  const simple = comparison.simplified;
  const full = comparison.itemized;
  const cell = (model: tax.simulation.Model | null, key: "deductions" | "base" | "tax") =>
    fmt(model === null ? null : model[key]);
  return [
    { id: "taxable", cells: ["Rendimentos tributáveis", fmt(comparison.taxable), fmt(comparison.taxable)] },
    { id: "deductions", cells: ["Desconto ou deduções", cell(simple, "deductions"), cell(full, "deductions")] },
    { id: "base", cells: ["Base de cálculo", cell(simple, "base"), cell(full, "base")] },
    { id: "tax", cells: ["Imposto devido", cell(simple, "tax"), cell(full, "tax")] },
    { id: "paid", cells: ["Imposto já pago ou retido", fmt(comparison.withheld), fmt(comparison.withheld)] },
    {
      id: "balance",
      cells: [
        "A pagar (+) ou a restituir (−)",
        fmt(tax.simulation.balanceOf(comparison, simple)),
        fmt(tax.simulation.balanceOf(comparison, full)),
      ],
    },
  ];
}

export function simulationNotes(comparison: tax.simulation.Comparison): string {
  const notes: string[] = [];
  if (comparison.missing.length) notes.push("Falta informar " + comparison.missing.join(", ") + " (Tabela do ano…).");
  const best = tax.simulation.best(comparison);
  if (best !== null) notes.push(`Com estes números, a ${best.name.toLowerCase()} resulta em menos imposto.`);
  for (const [title, values] of [
    ["Deduções", comparison.deductions],
    ["Fora da base", comparison.left_out],
  ] as const) {
    if (values.size) {
      notes.push(`${title}: ` + [...values].map(([label, value]) => `${label} ${fmt(value)}`).join("; ") + ".");
    }
  }
  return notes.join(" ");
}

// ── informes ─────────────────────────────────────

export function reportRows(ledger: Ledger, found: readonly tax.model.IncomeReport[]): Row[] {
  return found.map((report) => {
    const source = ledger.accounts.get(report.source_id);
    const diffs = tax.statements.differences(ledger, report);
    return {
      id: report.id,
      cells: [
        source ? source.name : "?",
        taxId(report.payer_tax_id),
        String(report.lines.length),
        diffs.length ? `${diffs.length} diferença(s)` : "confere",
      ],
    };
  });
}

export function checkRows(found: readonly tax.statements.Check[]): Row[] {
  return found.map((c) => {
    const difference = tax.statements.difference(c);
    return {
      id: c.field,
      cells: [
        tax.model.FIELD_LABELS[c.field],
        fmt(c.informed),
        c.recorded !== null ? fmt(c.recorded) : "sem registro",
        tax.statements.matches(c) || difference === null ? DASH : fmt(difference),
      ],
    };
  });
}

// ── links and the year ───────────────────────────

export type Reveal =
  | { kind: "year"; year: number }
  | { kind: "darf"; purpose: "variable_income" | "carne_leao"; month: YearMonth; memberId: Id | null };

const MONTH = /^(\d{4})-(0[1-9]|1[0-2])$/;

/**
 * The `ref` of a link (docs `data/links.ts`): "year:<YYYY>", "variable_income:<YYYY-MM>" or
 * "carne_leao:<YYYY-MM>:<memberId>". Anything else is not for this page.
 */
export function parseReveal(ref: string | undefined): Reveal | null {
  if (!ref) return null;
  const [head, second, third] = ref.split(":");
  if (head === "year" && second && /^\d{4}$/.test(second)) return { kind: "year", year: Number(second) };
  const month = second ? MONTH.exec(second) : null;
  if ((head === "variable_income" || head === "carne_leao") && month) {
    return {
      kind: "darf",
      purpose: head,
      month: { year: Number(month[1]), month: Number(month[2]) },
      memberId: head === "carne_leao" && third ? third : null,
    };
  }
  return null;
}

/** The years the selector offers: this year and the seven before it, newest first. */
export function yearOptions(today: IsoDate, shown = 8): number[] {
  const current = Number(today.slice(0, 4));
  return Array.from({ length: shown }, (_, index) => current - index);
}

/**
 * The year the page opens on: last year (the return filed now is about the year before), or the latest
 * year with movement up to next year when last year has none.
 */
export function initialYear(ledger: Ledger, today: IsoDate): number {
  const years = new Set<number>();
  for (const op of ledger.activeOperations()) {
    const day = cashDate(op);
    if (day) years.add(Number(day.slice(0, 4)));
  }
  const last = Number(today.slice(0, 4)) - 1;
  if (years.has(last) || years.size === 0) return last;
  const candidates = [...years].filter((year) => year <= last + 1);
  return candidates.length ? Math.max(...candidates) : last;
}

/** The summary line under the title. */
export function summaryLine(year: number, who: string | null): string {
  return `Declaração de ${year + 1} (ano-calendário ${year}) · ${who ?? "todo o projeto"}`;
}
