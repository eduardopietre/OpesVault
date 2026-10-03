"""Receipts attached to any operation, kept encrypted in the vault like imported documents
(docs/09 §1.3 A).

The file itself is a vault document (`Session.add_document`); the link is an entity beside the
operation, so attaching a receipt to an operation of a closed month is allowed and never
changes a figure. Only PDF and images are accepted, recognized by their content, not their
name; nothing is written to disk unencrypted.
"""

from typing import TYPE_CHECKING
from uuid import UUID

from opesvault.domain.ledger import DomainError, Ledger
from opesvault.domain.model import _Entity

if TYPE_CHECKING:
    from opesvault.session import Session

MAX_BYTES = 25 * 1024 * 1024
KINDS = {b"%PDF-": "pdf", b"\x89PNG\r\n\x1a\n": "png", b"\xff\xd8\xff": "jpeg"}


class Attachment(_Entity):
    operation_id: UUID
    document_id: UUID


Ledger.register_kind("attachment", Attachment)


def attachments(ledger: Ledger) -> dict[UUID, Attachment]:
    return ledger.entities("attachment")


def kind_of(data: bytes) -> str | None:
    """'pdf', 'png' or 'jpeg' from the first bytes; None for anything else."""
    return next((kind for magic, kind in KINDS.items() if data.startswith(magic)), None)


def of_operation(ledger: Ledger, operation_id: UUID) -> list[Attachment]:
    return [a for a in attachments(ledger).values() if a.operation_id == operation_id]


def of_document(ledger: Ledger, document_id: UUID) -> list[Attachment]:
    return [a for a in attachments(ledger).values() if a.document_id == document_id]


def attach(session: "Session", operation_id: UUID, original_name: str, data: bytes) -> Attachment:
    ledger = session.ledger
    if operation_id not in ledger.operations:
        raise DomainError("Operação inexistente.")
    if kind_of(data) is None:
        raise DomainError("Anexe um PDF ou uma imagem (PNG ou JPEG).")
    if len(data) > MAX_BYTES:
        raise DomainError("O arquivo passa de 25 MB.")
    import hashlib

    existing = session.find_document_by_hash(hashlib.sha256(data).hexdigest())
    document = existing if existing is not None else session.add_document(original_name, data)
    if any(a.document_id == document.meta.id for a in of_operation(ledger, operation_id)):
        raise DomainError("Este comprovante já está anexado a este lançamento.")
    return ledger.put("attachment", Attachment(operation_id=operation_id, document_id=document.meta.id))


def detach(session: "Session", attachment_id: UUID) -> None:
    """Removes the link; the file leaves the vault when nothing else uses it."""
    from opesvault.importing.pipeline import batches

    ledger = session.ledger
    found = attachments(ledger).get(attachment_id)
    if found is None:
        return
    del attachments(ledger)[attachment_id]
    still_used = of_document(ledger, found.document_id) or any(
        b.document_id == found.document_id for b in batches(ledger).values()
    )
    if not still_used:
        session.remove_document(found.document_id)
