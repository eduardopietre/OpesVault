/**
 * Helpers of the Recorrências and Metas component tests: the page mounted on the demonstration project (the
 * demo's one rule, "Aluguel", has late forecasts and no operation to link), and small seeds of the data the
 * demonstration lacks (a rule with a matching operation, a charge that repeats).
 */
import { dom, type IsoDate, type Ledger } from "@opesvault/domain";
import { accountNamed } from "../lookup.ts";
import { mountApp, type MountOptions, type Mounted } from "../mount.tsx";

export type Workspace = Mounted["workspace"];

export async function openPage(path: string, title: string, options: MountOptions = {}) {
  return mountApp(path, { heading: title, ...options });
}

/** A rule and, optionally, an operation that realizes its first forecast; one call, outside any undo step. */
export function seedRule(
  workspace: Workspace,
  fields: { description: string; amount: string; category: string; day: number; start: IsoDate; tolerance?: string },
) {
  return workspace.act((ledger) =>
    dom.recurrence.addRule(
      ledger,
      dom.recurrence.RecurrenceRuleSchema.parse({
        description: fields.description,
        account_id: accountNamed(ledger, "Banco A").id,
        counterpart_id: accountNamed(ledger, fields.category).id,
        amount: fields.amount,
        tolerance: fields.tolerance ?? "0",
        day: fields.day,
        start: fields.start,
      }),
    ),
  );
}

export function seedExpense(workspace: Workspace, description: string, amount: string, category: string, on: IsoDate) {
  return workspace.act((ledger) =>
    ledger.recordExpense(
      accountNamed(ledger, "Banco A").id,
      accountNamed(ledger, category).id,
      amount,
      on,
      description,
    ),
  );
}

/** Three months in a row of the same charge: what `dom.subscriptions.candidates` calls a candidate. */
export function seedRepeatingCharge(workspace: Workspace, description = "Netflix") {
  for (const on of ["2026-08-12", "2026-09-12", "2026-10-02"] as IsoDate[]) {
    seedExpense(workspace, description, "39.90", "Lazer", on);
  }
}

export const rules = (ledger: Ledger) => [...dom.recurrence.rules(ledger).values()];
export const linkCount = (ledger: Ledger) => dom.recurrence.links(ledger).size;
