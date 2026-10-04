"""Where import data lives in the ledger: batches, extracted items and their evidence."""

from uuid import UUID

from opesvault.domain.ledger import Ledger
from opesvault.importing.model import Evidence, ExtractedItem, ImportBatch


def batches(ledger: Ledger) -> dict[UUID, ImportBatch]:
    return ledger.entities("import_batch")


def items(ledger: Ledger) -> dict[UUID, ExtractedItem]:
    return ledger.entities("extracted_item")


def evidence(ledger: Ledger) -> dict[UUID, Evidence]:
    return ledger.entities("evidence")


def items_of(ledger: Ledger, batch_id: UUID) -> list[ExtractedItem]:
    return [i for i in items(ledger).values() if i.batch_id == batch_id]
