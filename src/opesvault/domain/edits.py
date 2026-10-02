"""Bulk edits over operations (reclassification). Each change keeps history and a reason."""

from dataclasses import dataclass
from uuid import UUID

from opesvault.domain.ledger import DomainError, Ledger
from opesvault.domain.model import AccountSubtype


@dataclass(frozen=True)
class BulkResult:
    changed: int
    skipped: int
    errors: tuple[str, ...] = ()


def reclassify(
    ledger: Ledger, operation_ids: list[UUID], target_id: UUID, reason: str, source_id: UUID | None = None
) -> BulkResult:
    """Move category postings to `target_id`.

    Without `source_id`, only operations with exactly one category posting of the same
    type are changed, so a split (rateio) is never collapsed by accident.
    """
    if not reason.strip():
        raise DomainError("A reclassificação exige um motivo.")
    target = ledger.account(target_id)
    if target.subtype is not AccountSubtype.CATEGORY:
        raise DomainError("Escolha uma categoria de destino.")
    changed = skipped = 0
    errors: list[str] = []
    for op_id in operation_ids:
        op = ledger.operations.get(op_id)
        if op is None or not op.active:
            skipped += 1
            continue
        candidates = [
            i
            for i, p in enumerate(op.postings)
            if ledger.account(p.account_id).type is target.type
            and ledger.account(p.account_id).subtype is AccountSubtype.CATEGORY
            and (source_id is None or p.account_id == source_id)
        ]
        if not candidates or (source_id is None and len(candidates) != 1):
            skipped += 1
            continue
        postings = list(op.postings)
        for i in candidates:
            postings[i] = postings[i].model_copy(update={"account_id": target_id})
        if tuple(postings) == op.postings:
            skipped += 1
            continue
        try:
            ledger.update_operation(op.model_copy(update={"postings": tuple(postings)}), reason)
        except DomainError as exc:
            errors.append(f"{op.description}: {exc}")
            skipped += 1
            continue
        changed += 1
    return BulkResult(changed, skipped, tuple(errors))
