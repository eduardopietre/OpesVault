/**
 * Exportar CSV (RF-20): the operations the filters show, one row per posting (debit positive, credit
 * negative), in exactly the format of the domain's `ledgerCsv`, which exports the whole book. The file leaves
 * the project's protection, so the page asks before it is made.
 */
import { cashDate, competence, exporting, sortedBy, ymStr, type Ledger, type Operation } from "@opesvault/domain";
import { csvRow } from "../../data/csv.ts";

/** The CSV of these operations; with every operation of the book it equals `exporting.ledgerCsv`. */
export function operationsCsv(ledger: Ledger, operations: readonly Operation[]): Uint8Array {
  let out = csvRow(exporting.LEDGER_COLUMNS);
  const members = new Map([...ledger.members.values()].map((m) => [m.id, m.name]));
  const ordered = sortedBy([...operations], (o) => [cashDate(o) ?? o.occurred_on ?? "0001-01-01", o.id]);
  for (const op of ordered) {
    const comp = competence(op);
    for (const posting of op.postings) {
      const account = ledger.account(posting.account_id);
      out += csvRow([
        op.id,
        op.version,
        op.status,
        op.kind,
        exporting.spreadsheetText(op.description),
        op.occurred_on ?? "",
        cashDate(op) ?? "",
        comp ? ymStr(comp) : "",
        exporting.spreadsheetText(account.name),
        account.type,
        posting.amount.toFixed(),
        op.currency,
        posting.member_id ? exporting.spreadsheetText(members.get(posting.member_id) ?? "") : "",
        op.origin.kind,
      ]);
    }
  }
  return new TextEncoder().encode(String.fromCharCode(0xfeff) + out);
}
