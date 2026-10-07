/** Mounting Investimentos on the demonstration project (or an empty or read-only one) for its tests. */
import { dom, investments, type Id, type Ledger } from "@opesvault/domain";
import { mountApp, type MountOptions } from "../mount.tsx";

export async function openInvestimentos(path = "/investimentos", options: MountOptions = {}) {
  return mountApp(path, { width: 1600, heading: "Investimentos", headingTimeout: 15_000, ...options });
}

/** What the investments of the project hold, to prove an undo brought everything back. */
export function snapshot(ledger: Ledger): string {
  const { service, trades, profile, benchmarks } = investments;
  return JSON.stringify([
    [...service.assets(ledger).values()],
    [...service.positions(ledger).values()],
    [...service.valuations(ledger).values()],
    [...service.events(ledger).values()],
    [...trades.lots(ledger).values()],
    [...profile.profiles(ledger).values()],
    [...benchmarks.benchmarks(ledger).values()],
    [...ledger.entities("tax_rule").values()],
    ledger.operations.size,
    ledger.accounts.size,
  ]);
}

/** The demonstration project's CDB (tracked by value, three gross valuations). */
export const cdbOf = (ledger: Ledger): Id => investments.service.positions(ledger).values().next().value!.id;

/** A bank account of the demo to move money from or to. */
export const cashOf = (ledger: Ledger): Id => [...dom.banking.bankAccounts(ledger).values()][0]!.checking_id!;
