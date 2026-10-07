/**
 * Deliberate exports (RF-20). Port of `exports.py`. Outputs are plain files outside the project's
 * protection: here every export is a function returning text or bytes, the caller saves the file.
 *
 * Interchange format (version 1, docs/13 §5):
 * - UTF-8 JSON; decimals as strings with '.' separator and full precision;
 * - dates ISO 8601 (YYYY-MM-DD), instants with explicit offset;
 * - every entity keeps its stable id; documents' bytes are not included.
 *
 * `ledgerCsv` and `interchangeJson` give the same bytes as the desktop for the same ledger, with two
 * known limits: the timestamp is a parameter (Python read the clock), and a whole-number float in the
 * persisted data (`Evidence.bbox`) prints as `72` here and `72.0` in Python, because JSON parsing
 * loses the difference.
 */
import { monthEvents, STATE_LABELS as EVENT_STATE_LABELS } from "./domain/agenda.ts";
import { annual, NOTICE as ANNUAL_NOTICE } from "./domain/annual.ts";
import * as budget from "./domain/budget.ts";
import { totalsComparison } from "./domain/comparisons.ts";
import {
  KIND_LABELS as DEDUCTIBLE_LABELS,
  NOTICE as DEDUCTIBLE_NOTICE,
  annual as deductibleGroups,
} from "./domain/deductibles.ts";
import { indicators } from "./domain/indicators.ts";
import { type Ledger } from "./domain/ledger.ts";
import { AccountType, cashDate, competence } from "./domain/model.ts";
import { formatBrl } from "./domain/money.ts";
import { pendingItems } from "./domain/periods.ts";
import * as queries from "./domain/queries.ts";
import { formatDateBr, type IsoDate, type YearMonth, ymBr, ymLastDay, ymStr } from "./lib/dates.ts";
import { Dec } from "./lib/dec.ts";
import type { Id } from "./lib/ids.ts";
import { formatFixed } from "./lib/py.ts";
import { sortedBy } from "./lib/text.ts";
import * as checklist from "./tax/checklist.ts";
import * as declaration from "./tax/declaration.ts";
import * as ids from "./tax/ids.ts";
import * as issues from "./tax/issues.ts";
import { BUCKET_LABELS, IncomeNature, NATURE_LABELS } from "./tax/model.ts";
import * as records from "./tax/records.ts";
import * as simulation from "./tax/simulation.ts";
import * as variableIncome from "./tax/variable_income.ts";

export const INTERCHANGE_FORMAT = "opesvault-intercambio";
export const INTERCHANGE_VERSION = 1;

export const LEDGER_COLUMNS = [
  "operacao_id",
  "versao",
  "situacao",
  "tipo",
  "descricao",
  "data_ocorrencia",
  "data_caixa",
  "competencia",
  "conta",
  "tipo_conta",
  "valor",
  "moeda",
  "integrante_rateio",
  "origem",
] as const;

/** Cells a spreadsheet would read as a formula (OWASP's CSV injection list: '=', '+', '-', '@', tab, CR). */
const FORMULA_START = /^[=+\-@\t\r]/;
const PLAIN_NUMBER = /^[+-]?\d+(\.\d+)?$/;

/** A free-text cell (description, name) that a spreadsheet will not run: a leading "'" when it could be a formula. */
export function spreadsheetText(text: string): string {
  return FORMULA_START.test(text) ? "'" + text : text;
}

/** A cell that may hold a number or text: a plain number (like "-1485.00") is kept, anything else is guarded. */
export function spreadsheetCell(text: string): string {
  return PLAIN_NUMBER.test(text) ? text : spreadsheetText(text);
}

/** Python's `csv.writer(delimiter=";", lineterminator="\n")` with the default minimal quoting. */
function csvField(value: string | number): string {
  const text = String(value);
  return /[;"\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function csvRow(fields: readonly (string | number)[]): string {
  return fields.map(csvField).join(";") + "\n";
}

/** One row per posting (debit positive, credit negative), so totals re-balance in any spreadsheet. */
export function ledgerCsv(ledger: Ledger): Uint8Array {
  let out = csvRow(LEDGER_COLUMNS);
  const members = new Map([...ledger.members.values()].map((m) => [m.id, m.name]));
  const ordered = sortedBy([...ledger.operations.values()], (o) => [cashDate(o) ?? "0001-01-01", o.id]);
  for (const op of ordered) {
    const comp = competence(op);
    for (const posting of op.postings) {
      const account = ledger.account(posting.account_id);
      out += csvRow([
        op.id,
        op.version,
        op.status,
        op.kind,
        spreadsheetText(op.description),
        op.occurred_on ?? "",
        cashDate(op) ?? "",
        comp ? ymStr(comp) : "",
        spreadsheetText(account.name),
        account.type,
        posting.amount.toFixed(),
        op.currency,
        posting.member_id ? spreadsheetText(members.get(posting.member_id) ?? "") : "",
        op.origin.kind,
      ]);
    }
  }
  return new TextEncoder().encode(String.fromCharCode(0xfeff) + out);
}

/**
 * The order in which the desktop's `Ledger` lists its kinds once `opesvault.registry` is loaded
 * (it decides the order of the interchange's entities). A kind that is not listed goes last.
 */
export const KIND_ORDER: readonly string[] = [
  "member",
  "account",
  "card",
  "operation",
  "history",
  "reviewed_suspicion",
  "attachment",
  "bank_account",
  "balance_check",
  "budget_line",
  "installment_plan",
  "deductible_category",
  "goal",
  "loan_plan",
  "loan_payment",
  "loan_prepayment",
  "merchant_alias",
  "saved_filter",
  "reimbursement",
  "member_settlement",
  "operation_tags",
  "period_close",
  "recurrence_rule",
  "forecast_link",
  "settings",
  "import_batch",
  "evidence",
  "extracted_item",
  "category_rule",
  "asset",
  "position",
  "valuation",
  "investment_event",
  "tax_rule",
  "lot",
  "benchmark",
  "investment_profile",
  "tax_identity",
  "member_tax_info",
  "income_classification",
  "income_detail",
  "asset_filing",
  "declared_asset",
  "income_report",
  "tax_parameters",
  "variable_income_rules",
  "tax_payment",
  "tax_checklist_mark",
];

/** Python's `datetime.now(UTC).isoformat()`: microseconds only when there are some, "+00:00". */
export function isoNow(now: Date): string {
  const iso = now.toISOString(); // 2026-10-05T12:00:00.123Z
  const [base = "", ms = "000Z"] = iso.slice(0, -1).split(".");
  const micro = `${ms}000`.slice(0, 6);
  return `${base}${micro === "000000" ? "" : "." + micro}+00:00`;
}

/** The whole ledger as the interchange JSON; `exportedAt` is Python's `datetime.now(UTC).isoformat()`. */
export function interchangeJson(ledger: Ledger, exportedAt: string): Uint8Array {
  const rows = ledger.toRecords();
  const rank = (kind: string): number => {
    const i = KIND_ORDER.indexOf(kind);
    return i < 0 ? KIND_ORDER.length : i;
  };
  const meta = rows.filter((r) => r.kind === "ledger.meta");
  const history = rows.filter((r) => r.kind === "history");
  const others = sortedBy(
    rows.filter((r) => r.kind !== "ledger.meta" && r.kind !== "history"),
    (r) => rank(r.kind),
  );
  const payload = {
    formato: INTERCHANGE_FORMAT,
    versao_formato: INTERCHANGE_VERSION,
    versao_esquema: ledger.meta.schema_version,
    exportado_em: exportedAt,
    aviso: "Arquivo sem criptografia; contém dados financeiros.",
    entidades: [...meta, ...others, ...history].map((r) => ({ id: r.id, tipo: r.kind, dados: r.payload })),
  };
  return new TextEncoder().encode(JSON.stringify(payload, null, 1));
}

// ── printable reports (PDF by explicit action; RF-20) ──────────────────────

/** A table cell: a decimal is money, text is escaped, null is a dash. */
export type Cell = Dec | string | number | null;

/** Python's `html.escape(str(text))`. */
function h(text: unknown): string {
  return String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#x27;");
}

function money(value: Cell): string {
  return value === null ? "—" : value instanceof Dec ? formatBrl(value) : h(value);
}

function table(
  headers: readonly string[],
  rows: readonly (readonly Cell[])[],
  numeric: ReadonlySet<number> = new Set(),
): string {
  const head = headers.map((t, i) => `<th align="${numeric.has(i) ? "right" : "left"}">${h(t)}</th>`).join("");
  let body = rows
    .map(
      (row) =>
        "<tr>" +
        row.map((c, i) => `<td align="${numeric.has(i) ? "right" : "left"}">${money(c)}</td>`).join("") +
        "</tr>",
    )
    .join("");
  if (!rows.length) body = `<tr><td colspan="${headers.length}">Nada no período.</td></tr>`;
  return `<table width="100%" cellspacing="0" cellpadding="3" border="0"><tr>${head}</tr>${body}</table>`;
}

const STYLE =
  "<style>body{font-family:sans-serif;font-size:10pt} h1{font-size:16pt} h2{font-size:12pt;margin-top:14pt}" +
  " th{border-bottom:1px solid #888} td{border-bottom:1px solid #ddd} .note{color:#555;font-size:8pt}</style>";
export const WARNING = "Arquivo exportado sem criptografia: contém dados financeiros do projeto.";

const MONTH_NAMES = [
  "janeiro",
  "fevereiro",
  "março",
  "abril",
  "maio",
  "junho",
  "julho",
  "agosto",
  "setembro",
  "outubro",
  "novembro",
  "dezembro",
] as const;

const nums = (...n: number[]) => new Set(n);

/**
 * The month for the family conversation: summary, categories and budget, bills, commitments,
 * pending. `today` stands for Python's `date.today()` in the calendar of due dates.
 */
export function monthlyReportHtml(
  ledger: Ledger,
  month: YearMonth,
  today: IsoDate,
  memberId: Id | null = null,
): string {
  const title = `${MONTH_NAMES[month.month - 1]} de ${month.year}`;
  const flow = queries.cashFlow(ledger, month, month).get(ymStr(month))!;
  const statement = queries.incomeStatement(ledger, month, memberId);
  const worth = queries.netWorth(ledger, ymLastDay(month));
  const member = memberId ? ledger.members.get(memberId) : undefined;
  const parts: string[] = [
    `<html><head><meta charset='utf-8'>${STYLE}</head><body>`,
    `<h1>${h(ledger.meta.family_name || "Projeto")} — ${h(title)}</h1>`,
    `<p class="note">${h(WARNING)}</p>`,
  ];
  if (member !== undefined) {
    parts.push(`<p>Visão de <b>${h(member.name)}</b>: lançamentos e rateios atribuídos a este integrante.</p>`);
  }
  parts.push("<h2>Resumo</h2>");
  parts.push(
    table(
      ["", "Valor"],
      [
        ["Entradas (caixa)", flow.inflow],
        ["Saídas (caixa)", flow.outflow],
        ["Receitas (competência)", statement.totalIncome],
        ["Despesas (competência)", statement.totalExpense],
        ["Resultado", statement.result],
        ["Patrimônio líquido no fim do mês", worth.net],
      ],
      nums(1),
    ),
  );
  const comparison = totalsComparison(ledger, month);
  parts.push("<h2>Comparado aos meses anteriores</h2>");
  parts.push(
    table(
      ["", "Este mês", "Média de 3 meses", "Um ano antes"],
      comparison.map((c) => [c.name, c.current, c.average, c.lastYear]),
      nums(1, 2, 3),
    ),
  );
  const status = budget.status(ledger, month);
  const plan = new Map(status.rows.map((r) => [r.categoryId, r]));
  const categoryRows: Cell[][] = sortedBy([...statement.expense], ([, v]) => v, true).map(([categoryId, value]) => {
    const row = plan.get(categoryId);
    return [ledger.account(categoryId).name, value, row ? row.planned : null];
  });
  parts.push("<h2>Despesas por categoria</h2>");
  parts.push(table(["Categoria", "Realizado", "Planejado"], categoryRows, nums(1, 2)));
  const events = monthEvents(ledger, month, today);
  parts.push("<h2>Vencimentos do mês</h2>");
  parts.push(
    table(
      ["Data", "Descrição", "Valor", "Situação"],
      events.map((e) => [formatDateBr(e.on), e.title, e.amount.abs(), EVENT_STATE_LABELS[e.state]]),
      nums(2),
    ),
  );
  parts.push("<h2>Indicadores</h2>");
  const indicatorRows: Cell[][] = [];
  for (const indicator of indicators(ledger, month)) {
    let shown: string;
    if (indicator.value === null) shown = "—";
    else if (indicator.unit === "%") shown = `${formatFixed(indicator.value.mul(100), 0)}%`;
    else shown = `${indicator.value.toString()} meses`.replaceAll(".", ",");
    indicatorRows.push([indicator.label, shown, indicator.detail]);
  }
  parts.push(table(["Indicador", "Valor", "Como é calculado"], indicatorRows, nums(1)));
  const pending = pendingItems(ledger, month);
  parts.push("<h2>Pendências</h2>");
  parts.push(pending.length ? "<ul>" + pending.map((p) => `<li>${h(p)}</li>`).join("") + "</ul>" : "<p>Nenhuma.</p>");
  parts.push("</body></html>");
  return parts.join("");
}

/** Year-end support material (domain.annual) plus deductible expenses per person. */
export function annualReportHtml(ledger: Ledger, year: number): string {
  const summary = annual(ledger, year);
  const parts: string[] = [
    `<html><head><meta charset='utf-8'>${STYLE}</head><body>`,
    `<h1>${h(ledger.meta.family_name || "Projeto")} — fechamento de ${year}</h1>`,
    `<p class="note">${h(WARNING)} ${h(ANNUAL_NOTICE)}</p>`,
    `<h2>Bens e dívidas em 31/12/${year}</h2>`,
    table(
      ["Conta", "Tipo", `31/12/${year - 1}`, `31/12/${year}`],
      summary.balances.map((b) => [
        b.name,
        b.kind === AccountType.ASSET ? "Bem" : "Dívida",
        b.previousYearEnd,
        b.yearEnd,
      ]),
      nums(2, 3),
    ),
    `<p>Patrimônio líquido em 31/12/${year}: <b>${money(summary.netWorth)}</b></p>`,
    "<h2>Receitas do ano por categoria</h2>",
    table(
      ["Categoria", "Valor"],
      sortedBy([...summary.income], ([, v]) => v.negate()).map(([k, v]) => [ledger.account(k).name, v]),
      nums(1),
    ),
    "<h2>Investimentos</h2>",
    table(
      ["", "Valor"],
      [
        ["Proventos recebidos", summary.investmentIncome],
        ["Imposto retido na fonte", summary.taxWithheld],
        ["Ganhos realizados (resgates e vendas)", summary.realizedGains],
      ],
      nums(1),
    ),
  ];
  if (summary.incompleteEvents) {
    const leftOut = `${summary.incompleteEvents} resgate(s) sem valor bruto ou custo ficaram fora dos ganhos.`;
    parts.push(`<p class="note">${leftOut}</p>`);
  }
  parts.push("<h2>Despesas dedutíveis</h2>");
  parts.push(`<p class="note">${h(DEDUCTIBLE_NOTICE)}</p>`);
  for (const group of deductibleGroups(ledger, year)) {
    const member = group.memberId ? ledger.members.get(group.memberId) : undefined;
    const person = member ? member.name : "Sem integrante";
    parts.push(`<p><b>${h(DEDUCTIBLE_LABELS[group.kind])} — ${h(person)}: ${money(group.total)}</b></p>`);
    parts.push(
      table(
        ["Data", "Descrição", "Valor"],
        group.lines.map((line) => {
          const when = cashDate(line.operation);
          return [when ? formatDateBr(when) : "—", line.operation.description, line.amount];
        }),
        nums(2),
      ),
    );
  }
  parts.push("</body></html>");
  return parts.join("");
}

/**
 * The year in the shape of the return's sheets, for the declarant and their dependents. `today`
 * stands for Python's `date.today()` in the issues (due dates of the DARFs).
 */
export function taxReportHtml(ledger: Ledger, year: number, today: IsoDate, declarantId: Id | null = null): string {
  const people = records.peopleOf(ledger, declarantId);
  const person = (memberId: Id | null): string => {
    const member = memberId ? ledger.members.get(memberId) : undefined;
    return member ? member.name : "—";
  };
  const tid = (value: string | null): string => (value ? ids.display(value) : "falta");
  const who = declarantId ? person(declarantId) : "todo o projeto";
  const found = declaration.income(ledger, year, people);
  const parts: string[] = [
    `<html><head><meta charset='utf-8'>${STYLE}</head><body>`,
    `<h1>${h(ledger.meta.family_name || "Projeto")} — imposto de renda, ano-calendário ${year}</h1>`,
    `<p>Declarante: <b>${h(who)}</b></p>`,
    `<p class="note">${h(WARNING)} ${h(declaration.NOTICE)}</p>`,
  ];
  if (declarantId) {
    const info = records.memberInfo(ledger, declarantId);
    parts.push(`<p>CPF: ${h(tid(info ? info.cpf : null))}</p>`);
    const deps = declaration.dependents(ledger, declarantId);
    if (deps.length) {
      parts.push("<h2>Dependentes</h2>");
      parts.push(
        table(
          ["Nome", "CPF", "Nascimento", "Relação"],
          deps.map((d) => [d.name, tid(d.cpf), d.birth_date ? formatDateBr(d.birth_date) : "—", d.relation || "—"]),
        ),
      );
    }
  }
  parts.push("<h2>Rendimentos tributáveis recebidos de pessoa jurídica</h2>");
  parts.push(
    table(
      ["Fonte pagadora", "CNPJ", "Integrante", "Rendimentos", "INSS", "IR retido", "13º", "IR 13º"],
      found.taxable.map((r) => [
        r.payer,
        tid(r.tax_id),
        person(r.member_id),
        r.taxable,
        r.social_security,
        r.withheld,
        r.thirteenth,
        r.thirteenth_withheld,
      ]),
      nums(3, 4, 5, 6, 7),
    ),
  );
  for (const nature of [IncomeNature.CARNE_LEAO, IncomeNature.EXEMPT, IncomeNature.EXCLUSIVE, null] as const) {
    const rows = declaration.byNature(found, nature);
    if (!rows.length) continue;
    const title = nature ? NATURE_LABELS[nature] : "Rendimentos sem natureza definida (a classificar)";
    parts.push(`<h2>${h(title)}</h2>`);
    parts.push(
      table(
        ["Fonte", "CNPJ", "Integrante", "Valor", "IR retido"],
        rows.map((r) => [
          r.source,
          (r.tax_id && ids.display(r.tax_id)) || "—",
          person(r.member_id),
          r.amount,
          r.withheld,
        ]),
        nums(3, 4),
      ),
    );
  }
  const payments = declaration.payments(ledger, year, people);
  if (payments.length) {
    parts.push("<h2>Pagamentos efetuados</h2>");
    parts.push(
      table(
        ["Tipo", "Quem recebeu", "CPF/CNPJ", "Beneficiário", "Pago", "Parcela não dedutível"],
        payments.map((r) => [
          DEDUCTIBLE_LABELS[r.kind],
          r.payee,
          tid(r.tax_id),
          person(r.beneficiary_id),
          r.paid,
          r.not_deductible,
        ]),
        nums(4, 5),
      ),
    );
  }
  parts.push("<h2>Bens e direitos (custo de aquisição)</h2>");
  parts.push(
    table(
      ["Grupo", "Código", "Discriminação", "CNPJ", `31/12/${year - 1}`, `31/12/${year}`],
      declaration
        .assets(ledger, year, people)
        .map((r) => [
          `${r.group || "—"}${r.suggested ? " (sugerido)" : ""}`,
          r.code || "—",
          r.description,
          r.subject !== "declared" ? tid(r.tax_id) : "—",
          r.previous === null ? "—" : r.previous,
          r.current === null ? "—" : r.current,
        ]),
      nums(4, 5),
    ),
  );
  const debts = declaration.debts(ledger, year, people);
  if (debts.length) {
    parts.push("<h2>Dívidas e ônus reais</h2>");
    parts.push(
      table(
        ["Dívida", "CNPJ", `31/12/${year - 1}`, `31/12/${year}`],
        debts.map((d) => [d.name, tid(d.tax_id), d.previous.abs(), d.current.abs()]),
        nums(2, 3),
      ),
    );
  }
  const months = variableIncome.months(ledger, year, people);
  if (months.length) {
    parts.push("<h2>Renda variável</h2>");
    parts.push(
      table(
        ["Mês", "Tipo", "Vendas", "Resultado", "Isento", "Base", "Imposto", "IR fonte", "DARF pago"],
        months.map((r) => [
          ymBr(r.month),
          BUCKET_LABELS[r.bucket],
          r.sales,
          r.result,
          r.exempt_gain,
          r.base,
          r.tax === null ? "—" : r.tax,
          r.withheld,
          r.paid,
        ]),
        nums(2, 3, 4, 5, 6, 7, 8),
      ),
    );
  }
  const comparison = simulation.compare(ledger, year, declarantId);
  parts.push("<h2>Simplificada ou completa (simulação)</h2>");
  parts.push(`<p class="note">${h(simulation.NOTICE)}</p>`);
  if (comparison.missing.length) {
    parts.push(`<p>Falta informar: ${h(comparison.missing.join(", "))}.</p>`);
  } else {
    parts.push(
      table(
        ["", "Simplificada", "Completa"],
        [
          [
            "Base de cálculo",
            comparison.simplified ? comparison.simplified.base : "—",
            comparison.itemized ? comparison.itemized.base : "—",
          ],
          [
            "Imposto devido",
            comparison.simplified ? comparison.simplified.tax : "—",
            comparison.itemized ? comparison.itemized.tax : "—",
          ],
        ],
        nums(1, 2),
      ),
    );
  }
  const pending = issues.issues(ledger, year, declarantId, today);
  const absent = checklist.missing(checklist.expected(ledger, year, people));
  if (pending.length || absent.length) {
    parts.push("<h2>Pendências e documentos que faltam</h2>");
    parts.push("<ul>" + pending.map((i) => `<li>${h(i.title)} — ${h(i.detail)}</li>`).join(""));
    parts.push(absent.map((d) => `<li>${h(d.title)}</li>`).join("") + "</ul>");
  }
  parts.push("</body></html>");
  return parts.join("");
}
