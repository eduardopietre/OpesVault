/** Where import data lives in the ledger: batches, extracted items and their evidence. Port of `importing/store.py`. */
import type { Ledger } from "../domain/ledger.ts";
import type { Id } from "../lib/ids.ts";
import type { Evidence, ExtractedItem, ImportBatch } from "./model.ts";

export function batches(ledger: Ledger) {
  return ledger.entities<ImportBatch>("import_batch");
}

export function items(ledger: Ledger) {
  return ledger.entities<ExtractedItem>("extracted_item");
}

export function evidence(ledger: Ledger) {
  return ledger.entities<Evidence>("evidence");
}

export function itemsOf(ledger: Ledger, batchId: Id): ExtractedItem[] {
  return [...items(ledger).values()].filter((i) => i.batch_id === batchId);
}
