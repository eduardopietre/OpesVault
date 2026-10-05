/**
 * Every W5 module evaluates on its own, whichever is imported first: `investments/profile`,
 * `domain/banking` and `tax/records` import each other (lazily in Python), so no module may use
 * another's exports while being evaluated.
 */
import { describe, expect, it, vi } from "vitest";

const MODULES = [
  "../src/catalogs/index.ts",
  "../src/domain/banking.ts",
  "../src/investments/model.ts",
  "../src/investments/service.ts",
  "../src/investments/performance.ts",
  "../src/investments/returns.ts",
  "../src/investments/trades.ts",
  "../src/investments/simulation.ts",
  "../src/investments/profile.ts",
  "../src/investments/index.ts",
  "../src/tax/model.ts",
  "../src/tax/ids.ts",
  "../src/tax/records.ts",
  "../src/tax/declaration.ts",
  "../src/tax/checklist.ts",
  "../src/tax/simulation.ts",
  "../src/tax/variable_income.ts",
  "../src/tax/index.ts",
];

describe("module evaluation order", () => {
  it.each(MODULES)("%s loads first", async (path) => {
    vi.resetModules();
    await expect(import(/* @vite-ignore */ path)).resolves.toBeTruthy();
  });

  it("registers every W5 kind", async () => {
    vi.resetModules();
    const { Ledger } = await import("../src/domain/ledger.ts");
    await import("../src/registry.ts");
    const kinds = [...Ledger.kinds().keys()];
    for (const kind of [
      "asset",
      "position",
      "valuation",
      "investment_event",
      "tax_rule",
      "lot",
      "investment_profile",
      "bank_account",
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
    ]) {
      expect(kinds).toContain(kind);
    }
  });
});
