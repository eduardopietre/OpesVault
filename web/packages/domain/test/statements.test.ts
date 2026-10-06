/** `tests/test_tax.py::test_informe_is_read_and_checked_against_the_records`, reading the synthetic PDF. */
import { describe, expect, it } from "vitest";

import { DomainError } from "../src/domain/ledger.ts";
import { makeDate } from "../src/lib/dates.ts";
import { issues } from "../src/tax/issues.ts";
import { ReportSource } from "../src/tax/model.ts";
import * as records from "../src/tax/records.ts";
import * as statements from "../src/tax/statements.ts";
import { family } from "./fixtures.ts";
import { doc, extractor } from "./importing_helpers.ts";

describe("informe from the PDF", () => {
  it("reads the synthetic PDF and compares it with the records", async () => {
    const f = family();
    const Y = 2025;
    const parsed = await statements.read(doc("bank_income_report.pdf"), extractor);
    expect(parsed.year).toBe(Y);
    expect(parsed.payerTaxId).toBe("11222333000181");
    const fields = new Map(parsed.lines.map((l) => [l.field, l.amount.toString()]));
    expect(fields.get("balance_previous")).toBe("1000.00");
    expect(fields.get("balance_end")).toBe("2500.00");
    expect(fields.get("exempt")).toBe("12.34");
    expect(fields.get("withheld")).toBe("10.26");
    f.ledger.recordOpeningBalance(f.bank, "1000.00", makeDate(Y - 1, 1, 2));
    f.ledger.recordIncome(f.bank, f.salary, "1400.00", makeDate(Y, 6, 1), "Depósito");
    const report = records.saveReport(f.ledger, Y, ReportSource.ACCOUNT, f.bank, parsed.lines, {
      payer_tax_id: parsed.payerTaxId,
    });
    const diffs = statements.differences(f.ledger, report);
    expect(diffs.map((d) => d.field)).toEqual(["balance_end"]);
    expect(statements.difference(diffs[0]!)!.toString()).toBe("100.00");
    expect(() => records.saveReport(f.ledger, Y, ReportSource.ACCOUNT, f.bank, [])).toThrow(DomainError);
    const found = issues(f.ledger, Y, null, makeDate(Y + 1, 3, 1));
    expect(found.some((i) => i.title === "Informe diferente do registrado: Banco A")).toBe(true);
  });
});
