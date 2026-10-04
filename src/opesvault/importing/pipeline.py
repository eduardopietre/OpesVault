"""Import pipeline (docs/05 §3): validate, extract, detect, parse, reconcile, review, approve.

Nothing here writes to disk. Approved items become ledger operations with their
evidence; everything else stays visible as pending. This module reads a document into a
batch; the later steps live in `checks` (problems, totals, duplicates), `suggestions`
(categories) and `approval` (review decisions). Callers use them through this module.
"""

import hashlib
from dataclasses import dataclass
from datetime import UTC, datetime
from uuid import UUID

from opesvault.domain.ledger import DomainError, Ledger
from opesvault.importing.approval import (
    EDITABLE_FIELDS,
    ApprovalResult,
    approve,
    correct_item,
    keep_separate,
    reject_items,
    set_batch_target,
    update_batch_status,
)
from opesvault.importing.checks import (
    BANK_KINDS,
    CARD_KINDS,
    MATCH_WINDOW,
    item_problems,
    normalize,
    reconcile,
    refresh_batch,
)
from opesvault.importing.model import (
    BatchStatus,
    DocFormat,
    DocType,
    Evidence,
    ExtractedItem,
    ImportBatch,
)
from opesvault.importing.parsers import AMBIGUITY_MARGIN, DETECTION_THRESHOLD, PARSERS, parser_by_id
from opesvault.importing.parsers.base import ParsedItem, Parser, ParseResult
from opesvault.importing.source import PROBLEM_MESSAGES, Source, SourceError, SourceProblem, load_source
from opesvault.importing.store import batches, evidence, items, items_of
from opesvault.importing.suggestions import KEYWORD_RULES, apply_rules
from opesvault.session import Session


class ImportRefused(DomainError):
    pass


def _now() -> datetime:
    return datetime.now(UTC)


# ── step 1-6: from bytes to a batch in review ───────


@dataclass
class ImportRequest:
    name: str
    data: bytes
    password: str | None = None  # used once, never stored (docs/05 §3)
    parser_id: str | None = None
    account_id: UUID | None = None
    card_id: UUID | None = None


def import_document(session: Session, request: ImportRequest) -> ImportBatch:
    ledger = session.ledger
    digest = hashlib.sha256(request.data).hexdigest()
    existing = session.find_document_by_hash(digest)
    if existing is not None and any(b.document_id == existing.meta.id for b in batches(ledger).values()):
        raise ImportRefused("Este arquivo já foi importado neste cofre (mesmo conteúdo).")

    try:
        source = load_source(request.name, request.data, request.password)
    except SourceError as exc:
        if exc.problem in (SourceProblem.PASSWORD_REQUIRED, SourceProblem.WRONG_PASSWORD):
            raise  # the UI asks for the PDF password and tries again; nothing is stored yet
        document = existing or session.add_document(request.name, request.data)
        return _store_batch(
            ledger,
            ImportBatch(
                document_id=document.meta.id,
                parser_id=None,
                parser_version=None,
                doc_format=DocFormat.PDF if request.data[:4] == b"%PDF" else DocFormat.CSV,
                status=BatchStatus.UNSUPPORTED,
                created_at=_now(),
                warnings=(PROBLEM_MESSAGES[exc.problem],),
            ),
        )

    document = existing or session.add_document(request.name, request.data)
    parser, candidates = choose_parser(source, request.parser_id)
    if parser is None:
        status = BatchStatus.AMBIGUOUS if candidates else BatchStatus.UNSUPPORTED
        warning = (
            "Mais de um layout reconhece este documento; escolha o correto."
            if candidates
            else "Layout desconhecido: nenhum parser suportado reconhece este documento."
        )
        return _store_batch(
            ledger,
            ImportBatch(
                document_id=document.meta.id,
                parser_id=None,
                parser_version=None,
                doc_format=source.format,
                status=status,
                created_at=_now(),
                warnings=(warning,),
                candidates=tuple(candidates),
            ),
        )
    try:
        result = run_parser(parser, source)
    except ParseFailed as exc:
        # The document is kept so the user can try another layout; no item is invented.
        return _store_batch(
            ledger,
            ImportBatch(
                document_id=document.meta.id,
                parser_id=None,
                parser_version=None,
                doc_format=source.format,
                status=BatchStatus.UNSUPPORTED,
                created_at=_now(),
                warnings=(str(exc),),
                candidates=(parser.id,),
            ),
        )
    return _parse_into_batch(session, document.meta.id, source, parser, request, result)


class ParseFailed(DomainError):
    """A parser could not read a document it accepted; the message has no document content."""


def run_parser(parser: Parser, source: Source) -> ParseResult:
    """Runs a parser as untrusted code over untrusted input (docs/05 §3, phase 10).

    Any failure becomes a classified error with the parser id only: no traceback, no text
    from the document, so nothing sensitive can reach a message or a log.
    """
    if parser.doc_format is not source.format:
        raise ParseFailed(f"O layout {parser.id} não lê arquivos {source.format.value.upper()}.")
    try:
        return parser.parse(source)
    except Exception:
        raise ParseFailed(
            f"O layout {parser.id} não conseguiu interpretar este documento (código PARSE_FAILED). "
            "O arquivo foi guardado; tente outro layout ou registre manualmente."
        ) from None


def choose_parser(source: Source, forced: str | None = None) -> tuple[Parser | None, list[str]]:
    if forced is not None:
        return parser_by_id(forced), []
    scored = sorted(((p.detect(source), p) for p in PARSERS), key=lambda t: t[0], reverse=True)
    viable = [(score, p) for score, p in scored if score >= DETECTION_THRESHOLD]
    if not viable:
        return None, []
    best_score, best = viable[0]
    close = [p.id for score, p in viable if best_score - score < AMBIGUITY_MARGIN]
    if len(close) > 1:
        return None, close
    return best, []


def reparse_with(session: Session, batch_id: UUID, parser_id: str, password: str | None = None) -> ImportBatch:
    """Resolve an AMBIGUOUS batch by choosing the parser explicitly."""
    ledger = session.ledger
    batch = batches(ledger)[batch_id]
    if batch.status not in (BatchStatus.AMBIGUOUS, BatchStatus.UNSUPPORTED):
        raise DomainError("Só lotes sem layout definido podem ser reprocessados.")
    document = session.document(batch.document_id)
    source = load_source(document.meta.original_name, document.data, password)
    parser = parser_by_id(parser_id)
    result = run_parser(parser, source)  # fails before the old batch is touched
    del batches(ledger)[batch_id]
    request = ImportRequest(name=document.meta.original_name, data=document.data, parser_id=parser_id)
    return _parse_into_batch(session, document.meta.id, source, parser, request, result)


def _store_batch(ledger: Ledger, batch: ImportBatch) -> ImportBatch:
    return ledger.put("import_batch", batch)


def _doc_type(parser: Parser, source: Source) -> DocType:
    if source.ofx is not None and source.ofx.kind == "card":
        return DocType.CARD_STATEMENT
    return parser.doc_type


def _guess_target(
    ledger: Ledger, doc_type: DocType, result: ParseResult, source: Source
) -> tuple[UUID | None, UUID | None]:
    """Find the card or account this document belongs to from its own identifiers."""
    if doc_type is DocType.CARD_STATEMENT:
        last4s = {i.card_last4 for i in result.items if i.card_last4}
        for card in ledger.cards.values():
            if card.last4 in last4s or any(a.last4 in last4s for a in card.additional):
                return card.liability_account_id, card.id
        if len(ledger.cards) == 1:
            card = next(iter(ledger.cards.values()))
            return card.liability_account_id, card.id
        return None, None
    hint = (result.header.account_hint or "").replace(".", "").replace("-", "")
    if hint:
        for account in ledger.accounts.values():
            masked = (account.masked_number or "").replace(".", "").replace("-", "")
            if masked and (masked in hint or hint.endswith(masked[-4:])):
                return account.id, None
    return None, None


def _parse_into_batch(
    session: Session, document_id: UUID, source: Source, parser: Parser, request: ImportRequest, result: ParseResult
) -> ImportBatch:
    ledger = session.ledger
    doc_type = _doc_type(parser, source)
    account_id, card_id = request.account_id, request.card_id
    if card_id is not None:
        account_id = ledger.cards[card_id].liability_account_id
    if account_id is None:
        account_id, card_id = _guess_target(ledger, doc_type, result, source)
    warnings = list(result.warnings)
    if not parser.validated_with_real_documents:
        warnings.append("Layout ainda não validado com documentos reais: confira cada item com o original.")
    batch = ImportBatch(
        document_id=document_id,
        parser_id=parser.id,
        parser_version=parser.version,
        doc_format=source.format,
        doc_type=doc_type,
        status=BatchStatus.IN_REVIEW,
        created_at=_now(),
        account_id=account_id,
        card_id=card_id,
        header=result.header,
        warnings=tuple(warnings),
        unmapped_lines=len(result.unmapped),
    )
    _store_batch(ledger, batch)
    for parsed in result.items:
        _store_item(ledger, batch, parsed, document_id)
    refresh_batch(ledger, batch.id)
    return batches(ledger)[batch.id]


def _store_item(ledger: Ledger, batch: ImportBatch, parsed: ParsedItem, document_id: UUID) -> ExtractedItem:
    evidence_ids = []
    for line in parsed.lines:
        ev = ledger.put(
            "evidence",
            Evidence(
                document_id=document_id,
                page=line.page or None,
                bbox=line.bbox,
                line=line.number,
                text=line.text[:2000],
            ),
        )
        evidence_ids.append(ev.id)
    item = ExtractedItem(
        batch_id=batch.id,
        kind=parsed.kind,
        occurred_on=parsed.occurred_on,
        description=parsed.description,
        amount=parsed.amount,
        evidence_ids=tuple(evidence_ids),
        installment=parsed.installment,
        card_last4=parsed.card_last4,
        bank_id=parsed.bank_id,
        foreign_amount=parsed.foreign_amount,
        foreign_currency=parsed.foreign_currency,
        quantity=parsed.quantity,
        unit_price=parsed.unit_price,
        ticker=parsed.ticker,
        credit=parsed.credit,
        warnings=tuple(parsed.warnings),
    )
    return ledger.put("extracted_item", item)


__all__ = [
    "BANK_KINDS",
    "CARD_KINDS",
    "EDITABLE_FIELDS",
    "KEYWORD_RULES",
    "MATCH_WINDOW",
    "ApprovalResult",
    "ImportRefused",
    "ImportRequest",
    "ParseFailed",
    "apply_rules",
    "approve",
    "batches",
    "choose_parser",
    "correct_item",
    "evidence",
    "import_document",
    "item_problems",
    "items",
    "items_of",
    "keep_separate",
    "normalize",
    "reconcile",
    "refresh_batch",
    "reject_items",
    "reparse_with",
    "run_parser",
    "set_batch_target",
    "update_batch_status",
]
