/**
 * Helpers of the Recorrências and Metas component tests: the page mounted on the demonstration project (the
 * demo's one rule, "Aluguel", has late forecasts and no operation to link), and small seeds of the data the
 * demonstration lacks (a rule with a matching operation, a charge that repeats).
 */
import { dom, type IsoDate, type Ledger } from "@opesvault/domain";
import { act as reactAct, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { mountPage, type MountOptions } from "./overview_calendar_helpers.tsx";

export type Workspace = Awaited<ReturnType<typeof mountPage>>["workspace"];

export async function openPage(path: string, title: string, options: MountOptions = {}) {
  const mounted = await mountPage(path, options);
  await screen.findByRole("heading", { level: 1, name: title });
  return { ...mounted, ledger: mounted.workspace.ledger, user: userEvent.setup() };
}

export const accountId = (ledger: Ledger, name: string) =>
  [...ledger.accounts.values()].find((account) => account.name === name)!.id;

export const flat = (text: string | null | undefined) => (text ?? "").replace(/\s+/g, " ").trim();

/** The row of a table (by the id the page gives it), or null. */
export const rowOf = (table: HTMLElement, id: string) => table.querySelector<HTMLElement>(`[data-row-id="${id}"]`);

export const pickRow = async (user: ReturnType<typeof userEvent.setup>, tableName: string, text: string) => {
  const table = await screen.findByRole("grid", { name: tableName });
  await user.click(within(table).getAllByText(text)[0]!);
  return table;
};

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
        account_id: accountId(ledger, "Banco A"),
        counterpart_id: accountId(ledger, fields.category),
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
    ledger.recordExpense(accountId(ledger, "Banco A"), accountId(ledger, category), amount, on, description),
  );
}

/** Three months in a row of the same charge: what `dom.subscriptions.candidates` calls a candidate. */
export function seedRepeatingCharge(workspace: Workspace, description = "Netflix") {
  for (const on of ["2026-08-12", "2026-09-12", "2026-10-02"] as IsoDate[]) {
    seedExpense(workspace, description, "39.90", "Lazer", on);
  }
}

/** Starts a new step so the test's undo reverts only what the page did. */
export const undoOnce = (workspace: Workspace) => reactAct(() => void workspace.undo());

export const rules = (ledger: Ledger) => [...dom.recurrence.rules(ledger).values()];
export const linkCount = (ledger: Ledger) => dom.recurrence.links(ledger).size;
