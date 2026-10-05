/**
 * The domain part of `test_registry_loads_every_kind_in_a_fresh_process` (tests/test_domain_ledger.py):
 * opening a project must know every persisted kind of the planning modules, and the closing guards
 * are registered.
 */
import { describe, expect, it } from "vitest";

import { DomainError, Ledger } from "../src/domain/ledger.ts";
import { closeMonth } from "../src/domain/periods.ts";
import { type IsoDate, ym } from "../src/lib/dates.ts";
import { family } from "./fixtures.ts";

const DOMAIN_KINDS = [
  "installment_plan",
  "recurrence_rule",
  "forecast_link",
  "period_close",
  "settings",
  "budget_line",
  "balance_check",
  "loan_plan",
  "loan_payment",
  "loan_prepayment",
  "deductible_category",
  "reimbursement",
  "member_settlement",
  "saved_filter",
  "goal",
  "operation_tags",
  "merchant_alias",
  "reviewed_suspicion",
];

describe("registry", () => {
  it("knows every kind of the planning modules", () => {
    const kinds = new Set(Ledger.kinds().keys());
    expect(DOMAIN_KINDS.filter((k) => !kinds.has(k))).toEqual([]);
  });

  it("registers the closing guards", () => {
    const f = family();
    closeMonth(f.ledger, ym(2026, 1));
    expect(() => f.ledger.recordExpense(f.bank, f.groceries, "1.00", "2026-01-02" as IsoDate, "x")).toThrow(
      DomainError,
    );
  });
});
