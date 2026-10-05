/** Operation filters for the ledger view. Port of `domain/search.py`. */
import type { IsoDate } from "../lib/dates.ts";
import type { Id } from "../lib/ids.ts";
import { casefold } from "../lib/text.ts";
import type { Ledger } from "./ledger.ts";
import { cashDate, isActive, type Operation, type OriginKind } from "./model.ts";

export const StatusFilter = { ACTIVE: "active", CANCELLED: "cancelled", ALL: "all" } as const;
export type StatusFilter = (typeof StatusFilter)[keyof typeof StatusFilter];

export interface OperationFilter {
  readonly start: IsoDate | null;
  readonly end: IsoDate | null;
  /** Balance account or category hit by any posting. */
  readonly account_id: Id | null;
  /** Operation member or any posting share. */
  readonly member_id: Id | null;
  readonly text: string;
  readonly status: StatusFilter;
  readonly origin: OriginKind | null;
  /** Restricts to these operations (a tag, an installment plan…); null means no restriction. */
  readonly operation_ids: ReadonlySet<Id> | null;
}

export function operationFilter(changes: Partial<OperationFilter> = {}): OperationFilter {
  return {
    start: null,
    end: null,
    account_id: null,
    member_id: null,
    text: "",
    status: StatusFilter.ALL,
    origin: null,
    operation_ids: null,
    ...changes,
  };
}

export function matches(flt: OperationFilter, op: Operation): boolean {
  if (flt.operation_ids !== null && !flt.operation_ids.has(op.id)) return false;
  if (flt.status === StatusFilter.ACTIVE && !isActive(op)) return false;
  if (flt.status === StatusFilter.CANCELLED && isActive(op)) return false;
  if (flt.origin !== null && op.origin.kind !== flt.origin) return false;
  if (flt.start !== null || flt.end !== null) {
    // Unknown dates never match a period: they are not "in" any month.
    const when = op.occurred_on ?? cashDate(op);
    if (when === null) return false;
    if (flt.start !== null && when < flt.start) return false;
    if (flt.end !== null && when > flt.end) return false;
  }
  if (flt.account_id !== null && op.postings.every((p) => p.account_id !== flt.account_id)) return false;
  if (
    flt.member_id !== null &&
    op.member_id !== flt.member_id &&
    op.postings.every((p) => p.member_id !== flt.member_id)
  )
    return false;
  const needle = casefold(flt.text.trim());
  return !needle || casefold(op.description).includes(needle) || casefold(op.notes ?? "").includes(needle);
}

/** Newest first; operations without any date go last. */
export function findOperations(ledger: Ledger, flt: OperationFilter): Operation[] {
  const found = [...ledger.operations.values()].filter((op) => matches(flt, op));
  const key = (o: Operation) => o.occurred_on ?? cashDate(o) ?? "0001-01-01";
  // UUIDs in canonical lowercase form sort like their integers.
  found.sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    if (ka !== kb) return ka < kb ? 1 : -1;
    return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
  });
  return found;
}
