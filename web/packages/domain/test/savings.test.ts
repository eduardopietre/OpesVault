/** Savings accounts beside the investments: figures read from the ledger, one row per account. */
import { describe, expect, it } from "vitest";

import { AccountSubtype, AccountType, LedgerAccountSchema } from "../src/domain/model.ts";
import type { IsoDate } from "../src/lib/dates.ts";
import { savingsAccounts, savingsFigures, savingsName } from "../src/investments/savings.ts";
import { family } from "./fixtures.ts";

const d = (s: string) => s as IsoDate;

describe("savings beside the investments", () => {
  it("reads the balance, the interest credited from income and the rest as what was put in", () => {
    const f = family();
    f.ledger.recordOpeningBalance(f.bank, "5000.00", d("2025-12-31"));
    f.ledger.recordTransfer(f.bank, f.savings, "1000.00", d("2026-01-05"));
    f.ledger.recordTransfer(f.bank, f.savings, "500.00", d("2026-02-05"));
    f.ledger.recordIncome(f.savings, f.salary, "7.25", d("2026-02-28"), "Juros da poupança");
    f.ledger.recordTransfer(f.savings, f.bank, "200.00", d("2026-03-10"));
    const at = savingsFigures(f.ledger, f.savings, d("2026-03-31"));
    expect(at.value.eq("1307.25")).toBe(true);
    expect(at.income.eq("7.25")).toBe(true);
    expect(at.invested.eq("1300")).toBe(true);
    // up to a date: nothing after it counts
    const before = savingsFigures(f.ledger, f.savings, d("2026-02-27"));
    expect(before.value.eq("1500")).toBe(true);
    expect(before.income.isZero()).toBe(true);
  });

  it("lists every savings account in use, each with the name of what holds it", () => {
    const f = family();
    const second = f.ledger.addAccount(
      LedgerAccountSchema.parse({
        name: "Poupança Bruno",
        type: AccountType.ASSET,
        subtype: AccountSubtype.SAVINGS,
        holders: [f.bruno],
      }),
    ).id;
    expect(savingsAccounts(f.ledger).map((a) => a.id)).toEqual([f.savings, second]);
    expect(savingsName(f.ledger, f.savings)).toBe("Poupança");
    expect(savingsName(f.ledger, second)).toBe("Poupança (Bruno)");
  });
});
