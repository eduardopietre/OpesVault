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
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect } from "vitest";
import { mountPage, type MountOptions } from "./overview_calendar_helpers.tsx";
import { setViewport } from "./livro_harness.tsx";

export type User = ReturnType<typeof userEvent.setup>;

/** The year the demonstration project has its tax data in. */
export const YEAR = 2026;

export async function openImposto(path = "/imposto-de-renda", options: MountOptions & { width?: number } = {}) {
  setViewport(options.width ?? 1600);
  const mounted = await mountPage(path, options);
  await screen.findByRole("heading", { level: 1, name: "Imposto de renda" });
  return { ...mounted, ledger: mounted.workspace.ledger, user: userEvent.setup() };
}

export const flat = (text: string | null | undefined) => (text ?? "").replace(/\s+/g, " ").trim();

/** The table (grid) with that accessible name. */
export const table = (name: string) => screen.findByRole("grid", { name });

/** The row of a table whose text contains `text`. */
export function rowOf(grid: HTMLElement, text: string | RegExp): HTMLElement {
  const rows = within(grid)
    .getAllByRole("row")
    .filter((row) =>
      typeof text === "string" ? flat(row.textContent).includes(text) : text.test(flat(row.textContent)),
    );
  if (rows.length === 0) throw new Error(`no row with ${String(text)} in ${grid.getAttribute("aria-label")}`);
  return rows[0]!;
}

export async function pick(user: User, grid: HTMLElement, text: string | RegExp) {
  await user.click(rowOf(grid, text));
}

export const dialog = (name: string | RegExp, options: { timeout?: number } = {}) =>
  screen.findByRole("dialog", { name }, options);

export const closed = (name: string | RegExp) =>
  waitFor(() => expect(screen.queryByRole("dialog", { name })).toBeNull());

const labelPattern = (label: string | RegExp) =>
  typeof label === "string" ? new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\*?$`) : label;

/** Replaces the text of a field. */
export async function fill(user: User, within_: HTMLElement, label: string | RegExp, text: string) {
  const field = within(within_).getByLabelText(labelPattern(label)) as HTMLInputElement;
  await user.clear(field);
  if (text) await user.type(field, text);
}

/** Opens a select and chooses an option by its text. */
export async function choose(user: User, within_: HTMLElement, label: string | RegExp, option: string | RegExp) {
  await user.click(within(within_).getByRole("combobox", { name: label }));
  await user.click(await screen.findByRole("option", { name: option }));
}

export const submit = (user: User, within_: HTMLElement, name: string | RegExp) =>
  user.click(within(within_).getByRole("button", { name }));

/** What the project holds in the tax records, to prove an undo brought everything back. */
export function taxSnapshot(ledger: Ledger): string {
  const kinds = Object.keys(tax.model.KINDS);
  return JSON.stringify([
    kinds.map((kind) => [kind, [...ledger.entities(kind).values()]]),
    ledger.operations.size,
    [...ledger.accounts.values()].length,
  ]);
}

export const NAME = {
  ana: "Ana",
  bruno: "Bruno",
} as const;

/** An income category by name. */
export function incomeCategory(ledger: Ledger, name: string) {
  return ledger.categories(AccountType.INCOME).find((a) => a.name === name)!;
}

export function member(ledger: Ledger, name: string) {
  return [...ledger.members.values()].find((m) => m.name === name)!;
}

export function account(ledger: Ledger, name: string) {
  return [...ledger.accounts.values()].find((a) => a.name === name)!;
}

const d = (y: number, m: number, day: number): IsoDate => makeDate(y, m, day);

/**
 * Stocks sold in the demonstration year: a taxable month in April (sales above the exemption limit) and an
 * exempt one in February. Rates are the test's own: nothing fiscal is embedded in the app.
 */
export function seedVariableIncome(ledger: Ledger, options: { rates?: boolean } = {}) {
  const bank = account(ledger, "Banco A");
  const ana = member(ledger, "Ana");
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
  const bank = account(ledger, "Banco A");
  const ana = member(ledger, "Ana");
  const rent = ledger.addAccount(
    LedgerAccountSchema.parse({ name: "Aluguel recebido", type: AccountType.INCOME, subtype: AccountSubtype.CATEGORY }),
  );
  ledger.recordIncome(bank.id, rent.id, "1500.00", d(YEAR, 3, 1), "Aluguel", { member_id: ana.id });
  return rent;
}

export type { Id };
