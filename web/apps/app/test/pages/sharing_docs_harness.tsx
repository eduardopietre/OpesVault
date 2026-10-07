/** Mounts Reembolsos e acertos and Documentos with the demonstration project (or a new, empty one). */
import { type IsoDate } from "@opesvault/domain";
import type { Workspace } from "../../src/data/workspace.ts";
import { categoryNamed, memberNamed } from "../lookup.ts";
import { mountApp, type MountOptions } from "../mount.tsx";

export async function openAt(path: string, heading: string, options: MountOptions = {}) {
  return mountApp(path, { heading, ...options });
}

/**
 * Two purchases on Ana's card made for Bruno: Bruno owes Ana 200,00. (In the demonstration the account that
 * paid the pediatrician is joint, so nothing is owed between members until something like this exists.)
 */
export function shareExpenses(workspace: Workspace): void {
  workspace.act((ledger) => {
    const bruno = memberNamed(ledger, "Bruno").id;
    const card = [...ledger.cards.values()][0]!.id;
    const category = categoryNamed(ledger, "Lazer").id;
    ledger.recordCardPurchase(card, category, "120.00", "2026-03-08" as IsoDate, "Material escolar", null, {
      member_id: bruno,
    });
    ledger.recordCardPurchase(card, category, "80.00", "2026-03-09" as IsoDate, "Presente de aniversário", null, {
      member_id: bruno,
    });
  });
}
