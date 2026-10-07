/** Mounting Imposto de renda on the demonstration project (or an empty or read-only one) for its tests. */
import {
  AccountSubtype,
  AccountType,
  LedgerAccountSchema,
  investments,
  makeDate,
  tax,
  type Id,
  type IsoDate,
  type Ledger,
} from "@opesvault/domain";
import { mountApp, type MountOptions } from "../mount.tsx";
import { accountNamed, memberNamed } from "../lookup.ts";

/** The year the demonstration project has its tax data in. */
export const YEAR = 2026;

export async function openImposto(path = "/imposto-de-renda", options: MountOptions = {}) {
  return mountApp(path, { width: 1600, heading: "Imposto de renda", ...options });
}

/** What the project holds in the tax records, to prove an undo brought everything back. */
export function taxSnapshot(ledger: Ledger): string {
  const kinds = Object.keys(tax.model.KINDS);
  return JSON.stringify([
    kinds.map((kind) => [kind, [...ledger.entities(kind).values()]]),
    ledger.operations.size,
    [...ledger.accounts.values()].length,
  ]);
}

const d = (y: number, m: number, day: number): IsoDate => makeDate(y, m, day);

/**
 * Stocks sold in the demonstration year: a taxable month in April (sales above the exemption limit) and an
 * exempt one in February. Rates are the test's own: nothing fiscal is embedded in the app.
 */
export function seedVariableIncome(ledger: Ledger, options: { rates?: boolean } = {}) {
  const bank = accountNamed(ledger, "Banco A");
  const ana = memberNamed(ledger, "Ana");
  ledger.recordOpeningBalance(bank.id, "100000.00", d(YEAR - 1, 12, 1));
  const position = investments.service.createPosition(
    ledger,
    "PETR4",
    investments.model.AssetClass.STOCK,
    d(YEAR, 1, 2),
    {
      mode: investments.model.TrackingMode.QUANTITY,
      holder_id: ana.id,
    },
  );
  investments.trades.buy(ledger, position.id, d(YEAR, 1, 2), "1000", "20.00", bank.id);
  if (options.rates !== false) {
    tax.records.setVariableRules(
      ledger,
      d(2000, 1, 1),
      [
        tax.model.BucketRuleSchema.parse({ bucket: "common", rate: "0.15", exempt_sales_limit: "20000.00" }),
        tax.model.BucketRuleSchema.parse({ bucket: "day_trade", rate: "0.20" }),
      ],
      "teste",
    );
  }
  investments.trades.sell(ledger, position.id, d(YEAR, 2, 10), "100", "25.00", bank.id);
  investments.trades.sell(ledger, position.id, d(YEAR, 4, 10), "400", "70.00", bank.id);
  return { position, bank, ana };
}

/** A rent income category (no nature yet) with one deposit of Ana's. */
export function seedRent(ledger: Ledger) {
  const bank = accountNamed(ledger, "Banco A");
  const ana = memberNamed(ledger, "Ana");
  const rent = ledger.addAccount(
    LedgerAccountSchema.parse({ name: "Aluguel recebido", type: AccountType.INCOME, subtype: AccountSubtype.CATEGORY }),
  );
  ledger.recordIncome(bank.id, rent.id, "1500.00", d(YEAR, 3, 1), "Aluguel", { member_id: ana.id });
  return rent;
}

export type { Id };
