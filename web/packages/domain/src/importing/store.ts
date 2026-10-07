/** Where import data lives in the ledger: batches, extracted items and their evidence. Port of `importing/store.py`. */
import type { Ledger } from "../domain/ledger.ts";
import { groupBy } from "../lib/collections.ts";
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

/** A batch's items in collection order; a fresh array the caller may change. */
export function itemsOf(ledger: Ledger, batchId: Id): ExtractedItem[] {
  const byBatch = ledger.cachedFor("importing.itemsOf", ["extracted_item"], () =>
    groupBy(items(ledger).values(), (i) => i.batch_id),
  );
  return [...(byBatch.get(batchId) ?? [])];
}
