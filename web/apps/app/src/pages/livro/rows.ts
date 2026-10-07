/**
 * What the Livro shows, as plain functions (desktop `pages/ledger/model.py` and `filters.py`): labels, periods,
 * the amount and accounts of an operation, the filter state and what it selects. No React here, so
 * the rules are tested without a screen.
 */
import {
  Dec,
  OperationKind,
  OriginKind,
  ZERO,
  addDays,
  cashDate,
  dom,
  makeDate,
  search,
  ymFirstDay,
  ymLastDay,
  ymOf,
  type Id,
  type IsoDate,
  type Ledger,
  type Operation,
  type YearMonth,
  formatBrl,
  yearOf,
  monthOf,
} from "@opesvault/domain";
import { monthName } from "@opesvault/ui";
import { cents, DASH } from "../../data/money.ts";

export const KIND_LABELS: Readonly<Record<OperationKind, string>> = {
  [OperationKind.OPENING_BALANCE]: "Saldo de abertura",
  [OperationKind.INCOME]: "Receita",
  [OperationKind.EXPENSE]: "Despesa",
  [OperationKind.TRANSFER]: "Transferência",
  [OperationKind.CARD_PURCHASE]: "Compra no cartão",
  [OperationKind.CARD_PAYMENT]: "Pagamento de fatura",
  [OperationKind.CARD_CHARGE]: "Encargo do cartão",
  [OperationKind.REFUND]: "Estorno do lojista",
  [OperationKind.INVESTMENT_CONTRIBUTION]: "Aporte",
  [OperationKind.INVESTMENT_WITHDRAWAL]: "Resgate",
  [OperationKind.INVESTMENT_INCOME]: "Provento",
  [OperationKind.TAX_PAYMENT]: "Pagamento de imposto",
  [OperationKind.REVERSAL]: "Estorno",
  [OperationKind.OTHER]: "Outra",
};

export const ORIGIN_LABELS: Readonly<Record<OriginKind, string>> = {
  [OriginKind.MANUAL]: "Manual",
  [OriginKind.IMPORT]: "Importado",
  [OriginKind.RECURRENCE]: "Recorrência",
  [OriginKind.SYSTEM]: "Sistema",
};

export const STATUS_LABELS: Readonly<Record<search.StatusFilter, string>> = {
  all: "Ativos e cancelados",
  active: "Só ativos",
  cancelled: "Só cancelados",
};

export type PeriodKey = "all" | "month" | "this_month" | "last_month" | "last_3" | "this_year" | "custom";

/** "Mês selecionado" is relabelled with the month itself (shared with Visão geral and Orçamento). */
export const PERIODS: readonly (readonly [PeriodKey, string])[] = [
  ["all", "Todo o período"],
  ["month", "Mês selecionado"],
  ["this_month", "Este mês"],
  ["last_month", "Mês passado"],
  ["last_3", "Últimos 3 meses"],
  ["this_year", "Este ano"],
  ["custom", "Personalizado"],
];

/** The periods a saved filter may keep (a custom range would go stale). */
export const SAVEABLE: readonly PeriodKey[] = ["all", "month", "this_month", "last_month", "last_3", "this_year"];

function firstOf(today: IsoDate): IsoDate {
  return makeDate(yearOf(today), monthOf(today), 1);
}

export function periodRange(key: PeriodKey, today: IsoDate): readonly [IsoDate | null, IsoDate | null] {
  const first = firstOf(today);
  if (key === "this_month") return [first, today];
  if (key === "last_month") {
    const end = addDays(first, -1);
    return [firstOf(end), end];
  }
  if (key === "last_3") {
    let start = first;
    for (let i = 0; i < 2; i++) start = firstOf(addDays(start, -1));
    return [start, today];
  }
  if (key === "this_year") return [makeDate(yearOf(today), 1, 1), today];
  return [null, null];
}

// ── the cells ───────────────────────────────────

export function operationTotal(op: Operation): Dec {
  return Dec.sum(
    op.postings.filter((p) => p.amount.isPositive()).map((p) => p.amount),
    ZERO,
  );
}

export function operationAmount(op: Operation): string {
  return formatBrl(operationTotal(op));
}

/** Cents as a bigint, to sort amounts exactly. */
export function amountKey(op: Operation): bigint {
  return cents(operationTotal(op));
}

export function operationAccounts(ledger: Ledger, op: Operation): string {
  const name = (accountId: Id) => ledger.accounts.get(accountId)?.name ?? "?";
  const debit = op.postings.filter((p) => p.amount.isPositive()).map((p) => name(p.account_id));
  const credit = op.postings.filter((p) => p.amount.isNegative()).map((p) => name(p.account_id));
  return `${credit.join(", ")} → ${debit.join(", ")}`;
}

export function operationDate(op: Operation): IsoDate | null {
  return op.occurred_on ?? cashDate(op);
}

/** "out/2026", how the tables read months. */
export function shortMonth(month: YearMonth): string {
  return `${monthName(month.month).slice(0, 3)}/${month.year}`;
}

export function competenceLabel(op: Operation): string {
  return op.accrual_month ? shortMonth(op.accrual_month) : DASH;
}

// ── the filters ─────────────────────────────────

export interface FilterState {
  period: PeriodKey;
  /** Custom range, as typed (dd/mm/aaaa). */
  start: string;
  end: string;
  account: Id | null;
  member: Id | null;
  status: search.StatusFilter;
  origin: OriginKind | null;
  tag: string | null;
  text: string;
  /** The account is a category: its subcategories count too ("Ver lançamentos" from the budget). */
  withChildren: boolean;
}

export const EMPTY_FILTERS: FilterState = {
  period: "all",
  start: "",
  end: "",
  account: null,
  member: null,
  status: "all",
  origin: null,
  tag: null,
  text: "",
  withChildren: false,
};

/** True when something other than the period narrows the list. */
export function onlyPeriod(f: FilterState): boolean {
  return (
    f.account === null &&
    f.member === null &&
    f.status === "all" &&
    f.origin === null &&
    f.tag === null &&
    !f.text.trim()
  );
}

/** Anything chosen (the period counts only when it is not "all"). */
export function filtersActive(f: FilterState): boolean {
  return f.period !== "all" || !onlyPeriod(f);
}

export function monthOnly(f: FilterState): boolean {
  return f.period === "month" && onlyPeriod(f);
}

/** The selection a filter state stands for. A custom period still being typed selects nothing yet. */
export function toOperationFilter(
  ledger: Ledger,
  f: FilterState,
  month: YearMonth,
  today: IsoDate,
  parseDate: (text: string) => IsoDate | null,
): search.OperationFilter {
  let start: IsoDate | null;
  let end: IsoDate | null;
  if (f.period === "custom") {
    start = parseDate(f.start);
    end = parseDate(f.end);
  } else if (f.period === "month") {
    start = ymFirstDay(month);
    end = ymLastDay(month);
  } else {
    [start, end] = periodRange(f.period, today);
  }
  // A category with its subcategories: the operations that touch any of them (and the tag, when chosen).
  let ids: Set<Id> | null = f.tag !== null ? new Set(dom.tags.operationsWith(ledger, f.tag)) : null;
  if (f.withChildren && f.account !== null) {
    const wanted = new Set([
      f.account,
      ...[...ledger.accounts.values()].filter((a) => a.parent_id === f.account).map((a) => a.id),
    ]);
    const touching = new Set<Id>();
    for (const op of ledger.operations.values())
      if (op.postings.some((p) => wanted.has(p.account_id))) touching.add(op.id);
    ids = ids === null ? touching : new Set([...ids].filter((id) => touching.has(id)));
  }
  return search.operationFilter({
    start,
    end,
    account_id: f.withChildren ? null : f.account,
    member_id: f.member,
    text: f.text,
    status: f.status,
    origin: f.origin,
    operation_ids: ids,
  });
}

export function snapshotFilter(f: FilterState, name: string): dom.savedFilters.SavedFilter {
  return dom.savedFilters.SavedFilterSchema.parse({
    name,
    period: f.period,
    account_id: f.account,
    member_id: f.member,
    text: f.text.trim(),
    status: f.status,
    origin: f.origin,
    tag: f.tag,
  });
}

/** A saved filter as a state (accounts that no longer exist are left out, like a combo that cannot find them). */
export function stateOfSaved(ledger: Ledger, saved: dom.savedFilters.SavedFilter): FilterState {
  const period = SAVEABLE.includes(saved.period as PeriodKey) ? (saved.period as PeriodKey) : "all";
  const status = saved.status in STATUS_LABELS ? (saved.status as search.StatusFilter) : "all";
  const origin = Object.values(OriginKind).includes(saved.origin as OriginKind) ? (saved.origin as OriginKind) : null;
  return {
    ...EMPTY_FILTERS,
    period,
    account: saved.account_id !== null && ledger.accounts.has(saved.account_id) ? saved.account_id : null,
    member: saved.member_id !== null && ledger.members.has(saved.member_id) ? saved.member_id : null,
    status,
    origin,
    tag: saved.tag !== null && dom.tags.allTags(ledger).includes(saved.tag) ? saved.tag : null,
    text: saved.text,
  };
}

// ── where other pages send the person ───────────

export type Reveal =
  | { kind: "operation"; id: Id }
  | { kind: "category"; id: Id; month: YearMonth }
  | { kind: "account"; id: Id }
  | { kind: "tag"; id: Id }
  | {
      kind: "filter";
      id: Id | null;
      month: YearMonth | null;
      range: readonly [IsoDate, IsoDate] | null;
      member: Id | null;
    };

/**
 * The `ref` another page passes to "Ver lançamentos": an operation id, `categoria:<id>:<AAAA-MM>`,
 * `conta:<id>` or `marcador:<tag id>` (the tag's name).
 */
export function parseReveal(ref: string): Reveal {
  // "filter:<account>:<YYYY-MM>[:<member>]" or "filter:<account>:<YYYY-MM-DD>..<YYYY-MM-DD>[:<member>]";
  // the account may be empty ("filter::2026-10": every account, as the reports' totals do)
  const filter = /^filter:([^:]*):(?:(\d{4})-(\d{2})|(\d{4}-\d{2}-\d{2})\.\.(\d{4}-\d{2}-\d{2}))(?::([^:]+))?$/.exec(
    ref,
  );
  if (filter) {
    return {
      kind: "filter",
      id: filter[1] ? (filter[1] as Id) : null,
      month: filter[2] ? { year: Number(filter[2]), month: Number(filter[3]) } : null,
      range: filter[4] && filter[5] ? [filter[4] as IsoDate, filter[5] as IsoDate] : null,
      member: (filter[6] as Id | undefined) ?? null,
    };
  }
  const category = /^categoria:([^:]+):(\d{4})-(\d{2})$/.exec(ref);
  if (category) {
    return {
      kind: "category",
      id: category[1] as Id,
      month: { year: Number(category[2]), month: Number(category[3]) },
    };
  }
  if (ref.startsWith("conta:")) return { kind: "account", id: ref.slice("conta:".length) };
  if (ref.startsWith("marcador:")) return { kind: "tag", id: ref.slice("marcador:".length) };
  return { kind: "operation", id: ref };
}

export function monthOfDate(date: IsoDate): YearMonth {
  return ymOf(date);
}
