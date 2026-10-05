/**
 * What is incomplete or inconsistent for the return (pendências), and the monthly tax reminders.
 * Port of `tax/issues.py`.
 *
 * Checks of completeness and agreement, never legal judgments: a payment without the payee's CNPJ, a
 * receipt not attached, an informe that differs from the records, an income without a nature, a DARF
 * not registered. Each issue says where it is fixed. `today` is explicit.
 */
import { LOOKBACK_DAYS, Severity } from "../domain/alerts.ts";
import type { Ledger } from "../domain/ledger.ts";
import { formatBrl } from "../domain/money.ts";
import { assets, positions } from "../investments/service.ts";
import { addDays, type IsoDate, monthOf, type YearMonth, yearOf, ymAdd, ymEq, ymOf, ymStr } from "../lib/dates.ts";
import type { Id } from "../lib/ids.ts";
import { getOrKeyError, orDec } from "../lib/py.ts";
import { sortedBy } from "../lib/text.ts";
import * as checklist from "./checklist.ts";
import * as declaration from "./declaration.ts";
import { FIELD_LABELS, IncomeNature, KINDS, NatureSubject, TaxSubject } from "./model.ts";
import * as records from "./records.ts";
import * as simulation from "./simulation.ts";
import * as statements from "./statements.ts";
import * as variableIncome from "./variable_income.ts";

export interface Issue {
  readonly severity: Severity;
  readonly title: string;
  readonly detail: string;
  /** What the tax page opens: identity, member, nature, filing, detail, report, ... */
  readonly action: string;
  readonly ref: unknown;
}

function issue(severity: Severity, title: string, detail: string, action: string, ref: unknown = null): Issue {
  return { severity, title, detail, action, ref };
}

/** Cached by the ledger's state: the overview asks for it on every refresh. */
export function issues(ledger: Ledger, year: number, declarantId: Id | null, today: IsoDate): Issue[] {
  return ledger.cached(`tax.issues:${year}:${declarantId ?? ""}:${today}`, () =>
    computeIssues(ledger, year, declarantId, today),
  );
}

function person(ledger: Ledger, memberId: Id | null): string {
  const member = memberId ? ledger.members.get(memberId) : undefined;
  return member ? member.name : "sem integrante";
}

/** `f"{month.month:02d}/{month.year}"` */
function monthLabel(month: YearMonth): string {
  return `${String(month.month).padStart(2, "0")}/${month.year}`;
}

function dateBr(d: IsoDate): string {
  return `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}`;
}

const ORDER: Readonly<Record<Severity, number>> = { urgent: 0, soon: 1, info: 2 };

function computeIssues(ledger: Ledger, year: number, declarantId: Id | null, today: IsoDate): Issue[] {
  const people = records.peopleOf(ledger, declarantId);
  const out: Issue[] = [];
  out.push(...peopleIssues(ledger, declarantId));
  const found = declaration.income(ledger, year, people);
  for (const row of found.taxable) {
    if (row.tax_id === null) {
      out.push(
        issue(
          Severity.URGENT,
          `CNPJ da fonte pagadora: ${row.payer}`,
          "obrigatório na ficha de rendimentos",
          "identity",
          [TaxSubject.CATEGORY, row.source_id],
        ),
      );
    }
    if (row.net_only) {
      out.push(
        issue(
          Severity.INFO,
          `Bruto, imposto retido e INSS: ${row.payer}`,
          `${row.net_only} depósito(s) contados pelo valor líquido; detalhe pelo contracheque`,
          "detail",
          [...row.operations],
        ),
      );
    }
  }
  for (const row of declaration.unclassified(found)) {
    out.push(
      issue(
        Severity.URGENT,
        `Natureza do rendimento: ${row.source}`,
        `recebido ${formatBrl(row.amount)} sem saber se é tributável, isento ou exclusivo`,
        "nature",
        [row.subject, row.ref],
      ),
    );
  }
  for (const row of found.other) {
    if (
      (row.nature === IncomeNature.EXEMPT || row.nature === IncomeNature.EXCLUSIVE) &&
      row.tax_id === null &&
      row.subject === NatureSubject.CATEGORY
    ) {
      out.push(
        issue(Severity.INFO, `CNPJ da fonte: ${row.source}`, "pedido na ficha de isentos e exclusivos", "identity", [
          TaxSubject.CATEGORY,
          row.ref,
        ]),
      );
    }
  }
  if (people !== null && found.unassigned) {
    out.push(
      issue(
        Severity.INFO,
        "Receitas sem integrante",
        `${found.unassigned} lançamento(s) de receita sem integrante ficaram fora desta declaração`,
        "ledger",
      ),
    );
  }
  for (const item of declaration.payments(ledger, year, people)) {
    if (!declaration.paymentNet(item).isPositive()) continue;
    if (item.tax_id === null) {
      out.push(
        issue(
          Severity.URGENT,
          `CPF/CNPJ de quem recebeu: ${item.payee}`,
          `pagamentos dedutíveis de ${formatBrl(item.paid)}`,
          "identity",
          [TaxSubject.MERCHANT, item.payee_key],
        ),
      );
    }
    if (item.without_receipt) {
      out.push(
        issue(
          Severity.SOON,
          `Comprovante não anexado: ${item.payee}`,
          `${item.without_receipt} pagamento(s) sem recibo ou nota`,
          "receipts",
          [...item.operations],
        ),
      );
    }
  }
  for (const asset of declaration.assets(ledger, year, people)) {
    if (asset.suggested || asset.code === null) {
      out.push(
        issue(
          Severity.INFO,
          `Grupo e código do bem: ${asset.name}`,
          "escolha como ele aparece em Bens e Direitos",
          "filing",
          [asset.subject, asset.ref],
        ),
      );
    }
    if (asset.subject === "position" && asset.current === null) {
      out.push(
        issue(
          Severity.SOON,
          `Custo de aquisição desconhecido: ${asset.name}`,
          "Bens e Direitos usa o custo, não o valor de mercado",
          "investments",
          asset.ref,
        ),
      );
    }
    if (asset.subject === "account" && asset.tax_id === null) {
      out.push(
        issue(Severity.INFO, `CNPJ da instituição: ${asset.name}`, "pedido em Bens e Direitos", "identity", [
          TaxSubject.ACCOUNT,
          asset.ref,
        ]),
      );
    }
  }
  for (const report of records.reportsOf(ledger, year)) {
    const source = ledger.accounts.get(report.source_id);
    for (const diff of statements.differences(ledger, report)) {
      out.push(
        issue(
          Severity.URGENT,
          `Informe diferente do registrado: ${source ? source.name : "?"}`,
          `${FIELD_LABELS[diff.field]}: informe ${formatBrl(diff.informed)}, ` +
            `registrado ${formatBrl(orDec(diff.recorded, diff.informed))}`,
          "report",
          report.id,
        ),
      );
    }
  }
  const absent = checklist.missing(checklist.expected(ledger, year, people));
  if (absent.length) {
    out.push(
      issue(
        Severity.INFO,
        `${absent.length} documento(s) ainda não recebido(s)`,
        "veja Documentos do ano",
        "checklist",
      ),
    );
  }
  out.push(...monthlyIssues(ledger, year, people, today));
  const comparison = simulation.compare(ledger, year, declarantId);
  if (comparison.missing.length) {
    out.push(issue(Severity.INFO, "Simulação incompleta", "falta informar " + comparison.missing.join(", "), "params"));
  }
  return sortedBy(out, (i) => ORDER[i.severity]);
}

function peopleIssues(ledger: Ledger, declarantId: Id | null): Issue[] {
  const out: Issue[] = [];
  const targets = declarantId ? [declarantId, ...records.dependentsOf(ledger, declarantId)] : [];
  for (const memberId of targets) {
    const info = records.memberInfo(ledger, memberId);
    if (info === null || info.cpf === null) {
      const role = memberId === declarantId ? "Declarante" : "Dependente";
      out.push(issue(Severity.URGENT, `CPF: ${person(ledger, memberId)}`, `${role} sem CPF`, "member", memberId));
    } else if (memberId !== declarantId && info.birth_date === null) {
      out.push(
        issue(
          Severity.INFO,
          `Data de nascimento: ${person(ledger, memberId)}`,
          "pedida na ficha de dependentes",
          "member",
          memberId,
        ),
      );
    }
  }
  return out;
}

function monthlyIssues(ledger: Ledger, year: number, people: ReadonlySet<Id> | null, today: IsoDate): Issue[] {
  const out: Issue[] = [];
  const rows = variableIncome.months(ledger, year, people);
  if (rows.some((r) => variableIncome.missingRate(r))) {
    out.push(
      issue(
        Severity.SOON,
        "Alíquotas de renda variável",
        "há meses com ganho tributável e sem alíquota informada",
        "rules",
      ),
    );
  }
  for (const { month, due, paid, due_date: when } of variableIncome.dueByMonth(rows).values()) {
    if (paid.lt(due)) {
      const late = when < today;
      out.push(
        issue(
          late ? Severity.URGENT : Severity.SOON,
          `DARF de renda variável ${monthLabel(month)}`,
          `valor de ${formatBrl(due.sub(paid))}; ${late ? "venceu" : "vence"} em ${dateBr(when)}`,
          "payment",
          ["variable_income", month],
        ),
      );
    }
  }
  for (const item of declaration.income(ledger, year, people).carne_leao) {
    if (item.paid.isPositive()) continue;
    const when = variableIncome.dueDate(item.month);
    const late = when < today;
    out.push(
      issue(
        late ? Severity.URGENT : Severity.SOON,
        `Carnê-Leão ${monthLabel(item.month)}: ${person(ledger, item.member_id)}`,
        `recebido ${formatBrl(item.amount)}; o DARF ${late ? "venceu" : "vence"} em ${dateBr(when)}. ` +
          "Calcule no Carnê-Leão Web e registre o pagamento",
        "payment",
        ["carne_leao", item.month, item.member_id],
      ),
    );
  }
  return out;
}

// ── reminders for the Atenção panel ──────────

/** (severity, title, detail, due date, ref) */
export type Reminder = readonly [Severity, string, string, IsoDate, unknown];

/** The user started preparing a return here (any tax record): only then the season reminder shows. */
export function engaged(ledger: Ledger): boolean {
  return Object.keys(KINDS).some((kind) => ledger.entities(kind).size > 0);
}

/** Monthly DARFs (renda variável, Carnê-Leão) near or past due, and the return's season. */
export function reminders(ledger: Ledger, today: IsoDate, horizon: number): Reminder[] {
  return ledger.cached(`tax.reminders:${today}:${horizon}`, () => computeReminders(ledger, today, horizon));
}

function computeReminders(ledger: Ledger, today: IsoDate, horizon: number): Reminder[] {
  const out: Reminder[] = [];
  if (!engaged(ledger) && !hasVariableIncome(ledger)) return out;
  const windowStart = addDays(today, -LOOKBACK_DAYS);
  const windowEnd = addDays(today, horizon);
  for (const month of [ymAdd(ymOf(today), -2), ymAdd(ymOf(today), -1)]) {
    const when = variableIncome.dueDate(month);
    if (!(windowStart <= when && when <= windowEnd)) continue;
    const rows = variableIncome.months(ledger, month.year);
    const due = variableIncome.dueByMonth(rows.filter((r) => ymEq(r.month, month))).get(ymStr(month));
    if (due !== undefined && due.paid.lt(due.due)) {
      const severity = when < today ? Severity.URGENT : Severity.SOON;
      out.push([
        severity,
        `DARF de renda variável ${monthLabel(month)}`,
        `${formatBrl(due.due.sub(due.paid))}`,
        when,
        ["variable_income", month],
      ]);
    }
    for (const item of declaration.income(ledger, month.year).carne_leao) {
      if (ymEq(item.month, month) && item.paid.isZero()) {
        const severity = when < today ? Severity.URGENT : Severity.SOON;
        out.push([
          severity,
          `Carnê-Leão ${monthLabel(month)}: ${person(ledger, item.member_id)}`,
          `${formatBrl(item.amount)} recebido(s) de pessoa física ou do exterior`,
          when,
          ["carne_leao", month, item.member_id],
        ]);
      }
    }
  }
  if (monthOf(today) >= 2 && monthOf(today) <= 5 && engaged(ledger)) {
    const year = yearOf(today) - 1;
    const pending = issues(ledger, year, null, today).filter((i) => i.severity !== Severity.INFO);
    if (pending.length) {
      out.push([
        Severity.INFO,
        `Declaração de ${year}: ${pending.length} pendência(s)`,
        "CPF/CNPJ, comprovantes, informes e natureza dos rendimentos",
        today,
        ["year", year],
      ]);
    }
  }
  return out;
}

function hasVariableIncome(ledger: Ledger): boolean {
  return [...positions(ledger).values()].some((p) =>
    variableIncome.CLASSES.has(getOrKeyError(assets(ledger), p.asset_id).asset_class),
  );
}
