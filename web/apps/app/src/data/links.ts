/**
 * Where a notice or a calendar entry is resolved (desktop `AlertsPanel`, `AgendaPage.open_selected`):
 * the destination page, the object (`ref`) and, when one command finishes the job, the action (`act`).
 *
 * `ref` travels in the URL, so it is text. The domain's tuples become parts joined by ":" (ids are
 * UUIDs and dates, which never contain ":"); a date range is "from..to". The target page reads it back
 * with `refParts`. The contract, by destination:
 *
 *   contas        "<cardId>:<YYYY-MM>"            a card bill (the bill's month)          act "pagar"
 *                 "loan:<planId>:<number>"        a financing installment                 act "pagar"
 *                 "check:<accountId>"             a balance that differs from the bank    (no act)
 *   recorrencias  "<ruleId>:<YYYY-MM-DD>"         the forecast of a rule on its due date  act "vincular" (late only)
 *                 "rule:<ruleId>"                 a rule whose price changed              (no act)
 *   importar      "<batchId>"                     the batch with items to review
 *   orcamento     "<categoryId>:<YYYY-MM>"        a category over or near its budget
 *   relatorios    "projected_balance"             the projected balance report
 *                 "comparison"                    the comparison with previous months
 *                 "<report key>"                  any report: in_out, result, cash, categories, net_worth, composition,
 *                                                 projection, merchants, tags, deductibles, annual
 *   livro         "filter:<accountId>:<period>[:<memberId>]"  the operations behind a number;
 *                                                 period "YYYY-MM" or "YYYY-MM-DD..YYYY-MM-DD"
 *   imposto       "variable_income:<YYYY-MM>"     DARF of variable income                 act "darf"
 *                 "carne_leao:<YYYY-MM>:<memberId>"  Carnê-Leão of a member              act "darf"
 *                 "year:<YYYY>"                   the return of that year (pending items)
 *   investimentos "<positionId>"                  an investment (maturity)
 *   reembolsos    "<reimbursementId>" or the refunded expense's "<operationId>"   act "receber" (opens the receipt)
 *   documentos    "<documentId>" or "documento:<documentId>"   selects the file (a receipt, an import's original)
 *   configuracoes (no ref)               the first section (the project)
 *                 "projeto" | "ia" | "seguranca" | "backup" | "privacidade"   opens that section ("backup" is where
 *                                                 the reminder of an old backup leads)
 *   contas        "integrantes"                   the members tab (from Configurações › Projeto)
 *                 "bancarias"                     the bank accounts tab                   act "investimento" (the
 *                                                 new investment form; a new bank account first when there is none)
 */
import { ymStr, type YearMonth, dom } from "@opesvault/domain";

/** What `useGoTo()(page, { ref, act })` receives, plus the words of the link. */
export interface Link {
  page: string;
  ref?: string;
  act?: string;
  /** Short label of the link ("Ver fatura"). */
  label: string;
}

/** The page ids of `src/pages.tsx` for the domain's targets. */
export const TARGET_PAGES: Readonly<Record<string, string>> = {
  accounts: "contas",
  recurrences: "recorrencias",
  import: "importar",
  budget: "orcamento",
  ledger: "livro",
  reports: "relatorios",
  settings: "configuracoes",
  tax: "imposto",
  investments: "investimentos",
};

function isYearMonth(value: unknown): value is YearMonth {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as YearMonth).year === "number" &&
    typeof (value as YearMonth).month === "number"
  );
}

function part(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  if (isYearMonth(value)) return ymStr(value);
  if (Array.isArray(value)) return value.map(part).join("..");
  return String(value);
}

/** The domain's `ref` (an id, a tuple or null) as the URL's text. */
export function encodeRef(ref: unknown): string | undefined {
  if (ref === null || ref === undefined) return undefined;
  if (typeof ref === "string") return ref || undefined;
  if (!Array.isArray(ref)) return undefined;
  const parts = ref.map(part);
  while (parts.length && parts[parts.length - 1] === "") parts.pop();
  return parts.join(":") || undefined;
}

/** The ":" parts of a `ref` (the target page decides what each one means). */
export function refParts(ref: string | undefined): string[] {
  return ref ? ref.split(":") : [];
}

/** The reference of the operations behind a number: an account or category in a month, for a member. */
export function filterRef(accountId: string, month: YearMonth, memberId: string | null = null): string {
  return encodeRef(["filter", accountId, month, memberId]) as string;
}

const ACTION_LABELS: Readonly<Record<string, string>> = {
  accounts: "Ver fatura",
  recurrences: "Ver previsão",
  import: "Revisar",
  budget: "Ver no orçamento",
  reports: "Ver projeção",
  ledger: "Ver lançamentos",
  settings: "Abrir Configurações",
  tax: "Ver pendências",
  investments: "Ver investimento",
};
const ACT_LABELS: Readonly<Record<string, string>> = {
  accounts: "Pagar…",
  recurrences: "Vincular…",
  tax: "Registrar DARF…",
};
const ACT_NAMES: Readonly<Record<string, string>> = { accounts: "pagar", recurrences: "vincular", tax: "darf" };

function head(ref: unknown): unknown {
  return Array.isArray(ref) && ref.length ? ref[0] : undefined;
}

/** The link of a notice of "Atenção": to the object, with the action when one command resolves it. */
export function alertLink(alert: dom.alerts.Alert): Link {
  const target = alert.target;
  const page = TARGET_PAGES[target] ?? "visao-geral";
  const ref = encodeRef(alert.ref);
  const check = head(alert.ref) === "check";
  const darf = head(alert.ref) === "variable_income" || head(alert.ref) === "carne_leao";
  // A bill or installment can be paid before or after it is due; a forecast is linked only once it is
  // late. A balance that differs from the bank opens the account: there is no one-step fix.
  const direct =
    alert.ref !== null &&
    ((target === "accounts" && !check) ||
      (target === "recurrences" && alert.severity === dom.alerts.Severity.URGENT) ||
      (target === "tax" && darf));
  const label = direct ? (ACT_LABELS[target] as string) : check ? "Ver conta" : (ACTION_LABELS[target] ?? "Ver");
  return { page, ...(ref ? { ref } : {}), ...(direct ? { act: ACT_NAMES[target] as string } : {}), label };
}

/** The link of an entry of the calendar: a pending bill or installment opens ready to pay, a late recurrence ready to link. */
export function eventLink(event: dom.agenda.AgendaEvent): Link {
  const page = TARGET_PAGES[event.target] ?? "visao-geral";
  const ref = encodeRef(event.ref);
  const pending = event.state !== dom.agenda.EventState.DONE;
  const direct =
    pending &&
    (event.target === "accounts" || (event.target === "recurrences" && event.state === dom.agenda.EventState.LATE));
  return {
    page,
    ...(ref ? { ref } : {}),
    ...(direct ? { act: ACT_NAMES[event.target] as string } : {}),
    label: direct ? (ACT_LABELS[event.target] as string) : "Abrir",
  };
}
