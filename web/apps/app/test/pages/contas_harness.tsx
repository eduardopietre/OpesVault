/** Mounting Contas e cartões on the demonstration project (or an empty or read-only one) for its tests. */
import { mountApp, type MountOptions } from "../mount.tsx";

export async function openContas(path = "/contas", options: MountOptions = {}) {
  return mountApp(path, { width: 1600, heading: "Contas e cartões", ...options });
}

/** What the project holds, to prove an undo brought everything back. */
export function snapshot(ledger: {
  accounts: Map<string, unknown>;
  cards: Map<string, unknown>;
  members: Map<string, unknown>;
  operations: Map<string, unknown>;
}) {
  return JSON.stringify([
    [...ledger.accounts.values()],
    [...ledger.cards.values()],
    [...ledger.members.values()],
    ledger.operations.size,
  ]);
}
