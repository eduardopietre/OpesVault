"""Import pipeline (docs/05 §3): validate, extract, detect, parse, reconcile, review, approve.

Nothing here writes to disk. Approved items become ledger operations with their
evidence; everything else stays visible as pending.
"""

import hashlib
import re
import unicodedata
from collections import Counter
from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal
from uuid import UUID

from opesvault.domain.ledger import DomainError, Ledger
from opesvault.domain.model import (
    AccountSubtype,
    AccountType,
    HistoryAction,
    LedgerAccount,
    Operation,
    OperationKind,
    Origin,
    OriginKind,
    Posting,
)
from opesvault.domain.money import ZERO
from opesvault.importing.model import (
    BatchStatus,
    Correction,
    DocFormat,
    DocType,
    Evidence,
    ExtractedItem,
    ImportBatch,
    ItemKind,
    ItemStatus,
    Reconciliation,
)
from opesvault.importing.parsers import AMBIGUITY_MARGIN, DETECTION_THRESHOLD, PARSERS, parser_by_id
from opesvault.importing.parsers.base import ParsedItem, Parser, ParseResult
from opesvault.importing.parsers.brokerage import note_computed_net
from opesvault.importing.parsers.cards import card_reconciliation_total
from opesvault.importing.source import PROBLEM_MESSAGES, Source, SourceError, SourceProblem, load_source
from opesvault.session import Session

CARD_KINDS = {ItemKind.PURCHASE, ItemKind.CARD_CREDIT, ItemKind.CARD_PAYMENT, ItemKind.CARD_CHARGE}
BANK_KINDS = {ItemKind.DEBIT, ItemKind.CREDIT}
MATCH_WINDOW = timedelta(days=3)

# Keyword rules for category suggestions. Suggestions never approve anything (docs/05 §5).
KEYWORD_RULES: tuple[tuple[str, str], ...] = (
    (r"\bIOF\b", "Impostos e taxas"),
    (r"JUROS|MULTA|ENCARGO|ANUIDADE|TARIFA", "Juros e encargos"),
    (r"UBER|99\s*POP|POSTO|SHELL|IPIRANGA|ESTACIONA", "Transporte"),
    (r"IFOOD|MERCADO|SUPERMERC|PADARIA|RESTAURANTE|PAO DE ACUCAR|CARREFOUR", "Alimentação"),
    (r"NETFLIX|SPOTIFY|AMAZON PRIME|DISNEY|YOUTUBE|ASSINATURA", "Serviços e assinaturas"),
    (r"FARMACIA|DROGA|HOSPITAL|CLINICA|LABORAT", "Saúde"),
    (r"ESCOLA|FACULDADE|CURSO|LIVRARIA", "Educação"),
    (r"ALUGUEL|CONDOMINIO|ENERGIA|ENEL|SABESP|AGUA|INTERNET|VIVO|CLARO", "Moradia"),
    (r"SALARIO|PROVENTOS|FOLHA", "Salário"),
)


class ImportRefused(DomainError):
    pass


def _now() -> datetime:
    return datetime.now(UTC)


def normalize(text: str) -> str:
    stripped = "".join(c for c in unicodedata.normalize("NFKD", text) if not unicodedata.combining(c))
    return re.sub(r"\s+", " ", stripped).strip().upper()


def batches(ledger: Ledger) -> dict[UUID, ImportBatch]:
    return ledger.entities("import_batch")


def items(ledger: Ledger) -> dict[UUID, ExtractedItem]:
    return ledger.entities("extracted_item")


def evidence(ledger: Ledger) -> dict[UUID, Evidence]:
    return ledger.entities("evidence")


def items_of(ledger: Ledger, batch_id: UUID) -> list[ExtractedItem]:
    return [i for i in items(ledger).values() if i.batch_id == batch_id]


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
    return _parse_into_batch(session, document.meta.id, source, parser, request)


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
    del batches(ledger)[batch_id]
    request = ImportRequest(name=document.meta.original_name, data=document.data, parser_id=parser_id)
    return _parse_into_batch(session, document.meta.id, source, parser_by_id(parser_id), request)


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
    session: Session, document_id: UUID, source: Source, parser: Parser, request: ImportRequest
) -> ImportBatch:
    ledger = session.ledger
    result = parser.parse(source)
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


# ── validation, reconciliation, duplicates and suggestions ──


def item_problems(item: ExtractedItem) -> list[str]:
    problems = []
    if item.amount is None:
        problems.append("valor desconhecido")
    elif item.amount <= 0:
        problems.append("valor não positivo")
    if item.occurred_on is None:
        problems.append("data desconhecida")
    return problems


def reconcile(ledger: Ledger, batch: ImportBatch) -> tuple[Reconciliation, ...]:
    batch_items = [i for i in items_of(ledger, batch.id) if i.status is not ItemStatus.REJECTED]
    header = batch.header
    parsed = [
        ParsedItem(
            kind=i.kind,
            occurred_on=i.occurred_on,
            description=i.description,
            amount=i.amount,
            lines=[],
            credit=i.credit,
        )
        for i in batch_items
    ]
    if batch.doc_type is DocType.CARD_STATEMENT:
        computed = card_reconciliation_total(parsed, header.previous_balance) if header.total is not None else None
        return (
            Reconciliation(
                label="Total da fatura (saldo anterior + lançamentos − créditos − pagamentos)",
                expected=header.total,
                computed=computed,
                ok=None if computed is None or header.total is None else computed == header.total,
            ),
        )
    if batch.doc_type is DocType.BANK_STATEMENT:
        if header.opening_balance is None or header.closing_balance is None:
            return (
                Reconciliation(label="Saldo final do extrato", expected=header.closing_balance, computed=None, ok=None),
            )
        computed = header.opening_balance + sum(
            ((i.amount or ZERO) if i.kind is ItemKind.CREDIT else -(i.amount or ZERO) for i in batch_items), ZERO
        )
        return (
            Reconciliation(
                label="Saldo inicial + entradas − saídas = saldo final",
                expected=header.closing_balance,
                computed=computed,
                ok=computed == header.closing_balance,
            ),
        )
    if batch.doc_type is DocType.BROKERAGE_NOTE:
        computed = note_computed_net(parsed)
        return (
            Reconciliation(
                label="Líquido da nota (vendas − compras − custos)",
                expected=header.net_amount,
                computed=computed,
                ok=None if header.net_amount is None else computed == header.net_amount,
            ),
        )
    return ()


def _fingerprint(item: ExtractedItem) -> tuple[object, ...]:
    return (item.kind in CARD_KINDS, item.kind, item.occurred_on, item.amount, normalize(item.description))


def _find_duplicates(ledger: Ledger, batch: ImportBatch) -> None:
    """Mark items already present in the ledger (overlapping statements, TA-12/13/14).

    Identical lines are counted: if an earlier import approved one 'X 10,00' on a day
    and this file has two, the second is new (two equal purchases can be legitimate).
    """
    if batch.account_id is None:
        return
    previous: Counter[tuple[object, ...]] = Counter()
    linked: dict[tuple[object, ...], list[UUID]] = {}
    for other in batches(ledger).values():
        if other.id == batch.id or other.account_id != batch.account_id:
            continue
        for item in items_of(ledger, other.id):
            if item.status is ItemStatus.APPROVED and item.operation_id is not None:
                key = _fingerprint(item)
                previous[key] += 1
                linked.setdefault(key, []).append(item.operation_id)
    bank_ids = {
        i.bank_id: i.operation_id
        for b in batches(ledger).values()
        if b.id != batch.id and b.account_id == batch.account_id
        for i in items_of(ledger, b.id)
        if i.bank_id and i.status is ItemStatus.APPROVED
    }
    seen: Counter[tuple[object, ...]] = Counter()
    claimed: set[UUID] = set()
    for item in sorted(items_of(ledger, batch.id), key=lambda i: i.id.int):
        if item.status in (ItemStatus.APPROVED, ItemStatus.REJECTED):
            continue
        duplicate: UUID | None = None
        plan_match = None
        if item.installment and batch.card_id and item.amount is not None:
            from opesvault.domain.cards import find_plan_for_installment

            plan_match = find_plan_for_installment(
                ledger, batch.card_id, item.description, item.installment[0], item.installment[1], item.amount
            )
        if plan_match is not None:
            duplicate = plan_match.operation_id  # installment of a purchase already registered
        elif item.bank_id and item.bank_id in bank_ids:
            duplicate = bank_ids[item.bank_id]
        else:
            key = _fingerprint(item)
            seen[key] += 1
            if seen[key] <= previous[key]:
                duplicate = linked[key][seen[key] - 1]
            else:
                duplicate = _match_existing_operation(ledger, batch, item, claimed)
        if duplicate is not None:
            claimed.add(duplicate)
            ledger.entities("extracted_item")[item.id] = item.model_copy(
                update={"status": ItemStatus.DUPLICATE, "duplicate_of": duplicate}
            )


def _match_existing_operation(
    ledger: Ledger, batch: ImportBatch, item: ExtractedItem, claimed: set[UUID]
) -> UUID | None:
    """An operation created by another source (manual entry, the other side of a transfer, a bill
    payment seen in the bank) that already holds this fact. Value and date alone are a suggestion,
    shown to the user, never a silent merge (docs/05 §6)."""
    if item.amount is None or item.occurred_on is None or batch.account_id is None:
        return None
    if item.kind not in (ItemKind.DEBIT, ItemKind.CREDIT, ItemKind.CARD_PAYMENT):
        return None
    # An operation already backed by a document of this same account is not the other side.
    same_account_batches = {b.id for b in batches(ledger).values() if b.account_id == batch.account_id}
    already_linked = {
        i.operation_id
        for i in items(ledger).values()
        if i.operation_id is not None and i.batch_id in same_account_batches
    }
    for op in ledger.active_operations():
        if op.id in claimed or op.id in already_linked:
            continue
        when = op.cash_date or op.occurred_on
        if when is None or abs(when - item.occurred_on) > MATCH_WINDOW:
            continue
        for posting in op.postings:
            if posting.account_id != batch.account_id:
                continue
            account = ledger.account(batch.account_id)
            sign = 1 if account.type is AccountType.ASSET else -1
            increases_balance = posting.amount * sign > 0
            # Credits raise a bank balance; debits and card payments lower the balance/debt.
            if abs(posting.amount) == item.amount and increases_balance == (item.kind is ItemKind.CREDIT):
                return op.id
    return None


def _suggest(ledger: Ledger, item: ExtractedItem) -> tuple[UUID | None, str | None]:
    if item.kind in (ItemKind.TRADE, ItemKind.FEE, ItemKind.CARD_PAYMENT):
        return None, None
    wanted = AccountType.INCOME if item.kind in (ItemKind.CREDIT,) else AccountType.EXPENSE
    if item.kind is ItemKind.CARD_CREDIT:
        wanted = AccountType.EXPENSE  # a refund reduces the original expense category
    key = normalize(item.description)
    history = [
        i
        for i in items(ledger).values()
        if i.status is ItemStatus.APPROVED and i.target_account_id and normalize(i.description) == key
    ]
    if history:
        latest = max(history, key=lambda i: i.occurred_on or date.min)
        return latest.target_account_id, "history"
    for pattern, category_name in KEYWORD_RULES:
        if re.search(pattern, key):
            for account in ledger.categories(wanted):
                if account.name == category_name:
                    return account.id, "rule"
    return None, None


def refresh_batch(ledger: Ledger, batch_id: UUID) -> ImportBatch:
    """Re-run validation, duplicate detection, suggestions and reconciliation for a batch."""
    batch = batches(ledger)[batch_id]
    store = items(ledger)
    for item in items_of(ledger, batch_id):
        if item.status in (ItemStatus.APPROVED, ItemStatus.REJECTED, ItemStatus.DUPLICATE):
            continue
        update: dict[str, object] = {}
        if item.target_account_id is None:
            target, source = _suggest(ledger, item)
            if target is not None:
                update |= {"target_account_id": target, "suggestion_source": source}
        problems = item_problems(item)
        update["status"] = ItemStatus.NEEDS_REVIEW if problems else ItemStatus.READY
        store[item.id] = item.model_copy(update=update)
    _find_duplicates(ledger, batch)
    batch = batch.model_copy(update={"reconciliations": reconcile(ledger, batch)})
    batches(ledger)[batch_id] = batch
    ledger.change_count += 1
    return batch


# ── review actions ───────────────────────────────────


EDITABLE_FIELDS = {"description", "amount", "occurred_on", "kind", "target_account_id", "member_id"}


def correct_item(ledger: Ledger, item_id: UUID, field: str, value: object, reason: str | None = None) -> ExtractedItem:
    """User correction keeps old value, new value and declared author (docs/05 §4)."""
    if field not in EDITABLE_FIELDS:
        raise DomainError("Campo não editável.")
    item = items(ledger)[item_id]
    if item.status is ItemStatus.APPROVED:
        raise DomainError("Item já aprovado: corrija a operação no livro financeiro.")
    before = getattr(item, field)
    correction = Correction(
        field=field,
        before=None if before is None else str(before),
        after=None if value is None else str(value),
        operator=ledger.operator,
        reason=reason,
        at=_now(),
    )
    update: dict[str, object] = {field: value, "corrections": (*item.corrections, correction)}
    if field == "target_account_id":
        update["suggestion_source"] = None
    if item.status is ItemStatus.DUPLICATE and field != "target_account_id":
        update |= {"status": ItemStatus.NEEDS_REVIEW, "duplicate_of": None}
    updated = ledger.put("extracted_item", item.model_copy(update=update), reason=reason or f"correção de {field}")
    refresh_batch(ledger, item.batch_id)
    return items(ledger)[updated.id]


def keep_separate(ledger: Ledger, item_id: UUID, reason: str) -> None:
    """User decides a suspected duplicate is a distinct fact."""
    item = items(ledger)[item_id]
    if item.status is not ItemStatus.DUPLICATE:
        return
    ledger.put(
        "extracted_item",
        item.model_copy(update={"status": ItemStatus.READY, "duplicate_of": None}),
        reason=reason,
    )
    batch = batches(ledger)[item.batch_id]
    batches(ledger)[batch.id] = batch.model_copy(update={"reconciliations": reconcile(ledger, batch)})


def reject_items(ledger: Ledger, item_ids: list[UUID], reason: str) -> None:
    for item_id in item_ids:
        item = items(ledger)[item_id]
        if item.status is ItemStatus.APPROVED:
            raise DomainError("Item já aprovado não pode ser rejeitado; estorne a operação.")
        ledger.put("extracted_item", item.model_copy(update={"status": ItemStatus.REJECTED}), reason=reason)
    if item_ids:
        refresh_batch(ledger, items(ledger)[item_ids[0]].batch_id)
        _update_batch_status(ledger, items(ledger)[item_ids[0]].batch_id)


def set_batch_target(ledger: Ledger, batch_id: UUID, account_id: UUID | None, card_id: UUID | None) -> ImportBatch:
    batch = batches(ledger)[batch_id]
    if any(i.status is ItemStatus.APPROVED for i in items_of(ledger, batch_id)):
        raise DomainError("Lote com itens aprovados não pode mudar de conta.")
    if card_id is not None:
        account_id = ledger.cards[card_id].liability_account_id
    ledger.put(
        "import_batch",
        batch.model_copy(update={"account_id": account_id, "card_id": card_id}),
        reason="conta do documento",
    )
    return refresh_batch(ledger, batch_id)


@dataclass
class ApprovalResult:
    created: int = 0
    linked: int = 0
    skipped: int = 0


def approve(
    ledger: Ledger,
    batch_id: UUID,
    item_ids: list[UUID] | None = None,
    *,
    accept_divergence: str | None = None,
    partial_reason: str | None = None,
) -> ApprovalResult:
    """Turn items into operations. Blocking problems stop everything (docs/05 §7)."""
    batch = refresh_batch(ledger, batch_id)
    if batch.status in (BatchStatus.UNSUPPORTED, BatchStatus.AMBIGUOUS, BatchStatus.REJECTED):
        raise DomainError("Este lote não pode ser aprovado.")
    if batch.account_id is None and batch.doc_type is not DocType.BROKERAGE_NOTE:
        raise DomainError("Escolha a conta ou o cartão deste documento antes de aprovar.")
    divergent = [r for r in batch.reconciliations if r.ok is False]
    if divergent and not (accept_divergence and accept_divergence.strip()):
        raise DomainError("O total do documento não confere. Corrija os itens ou aceite a divergência com um motivo.")
    pending = [
        i
        for i in items_of(ledger, batch_id)
        if i.status in (ItemStatus.READY, ItemStatus.DUPLICATE, ItemStatus.NEEDS_REVIEW)
    ]
    selected = [i for i in pending if item_ids is None or i.id in item_ids]
    if item_ids is not None and len(selected) < len(pending) and not (partial_reason and partial_reason.strip()):
        raise DomainError("Aprovação parcial exige um motivo explícito.")
    blocked = [i for i in selected if i.status is ItemStatus.NEEDS_REVIEW]
    if blocked:
        raise DomainError(f"{len(blocked)} item(ns) precisam de revisão (valor ou data desconhecidos).")
    if batch.doc_type is DocType.BROKERAGE_NOTE:
        from opesvault.investments.notes import approve_note

        return approve_note(ledger, batch, selected)
    result = ApprovalResult()
    for item in selected:
        if item.status is ItemStatus.DUPLICATE and item.duplicate_of is not None:
            _link_evidence(ledger, item.duplicate_of, item)
            result.linked += 1
            continue
        op = _operation_for(ledger, batch, item)
        created = ledger.add_operation(op)
        ledger.put(
            "extracted_item",
            item.model_copy(update={"status": ItemStatus.APPROVED, "operation_id": created.id}),
            reason="aprovado",
            action=HistoryAction.APPROVE_IMPORT,
        )
        result.created += 1
    updates: dict[str, object] = {}
    if accept_divergence:
        updates["warnings"] = (*batch.warnings, f"Divergência aceita: {accept_divergence.strip()}")
    if partial_reason:
        updates["partial_reason"] = partial_reason.strip()
    if updates:
        batches(ledger)[batch_id] = batches(ledger)[batch_id].model_copy(update=updates)
    _update_batch_status(ledger, batch_id)
    return result


def _update_batch_status(ledger: Ledger, batch_id: UUID) -> None:
    batch = batches(ledger)[batch_id]
    states = {i.status for i in items_of(ledger, batch_id)}
    open_states = {ItemStatus.READY, ItemStatus.NEEDS_REVIEW, ItemStatus.DUPLICATE}
    if states and not states & open_states:
        status = BatchStatus.APPROVED if ItemStatus.APPROVED in states else BatchStatus.REJECTED
    elif ItemStatus.APPROVED in states:
        status = BatchStatus.PARTIAL
    else:
        status = BatchStatus.IN_REVIEW
    if status is not batch.status:
        ledger.put("import_batch", batch.model_copy(update={"status": status}), reason="situação do lote")


def _link_evidence(ledger: Ledger, operation_id: UUID, item: ExtractedItem) -> None:
    op = ledger.operations[operation_id]
    origin = op.origin.model_copy(update={"evidence_ids": (*op.origin.evidence_ids, *item.evidence_ids)})
    ledger.update_operation(op.model_copy(update={"origin": origin}), reason="nova evidência de outro documento")
    ledger.put(
        "extracted_item",
        item.model_copy(update={"status": ItemStatus.APPROVED, "operation_id": operation_id}),
        reason="vinculado a operação existente",
        action=HistoryAction.APPROVE_IMPORT,
    )


def _default_category(ledger: Ledger, kind: AccountType, name: str) -> UUID:
    for account in ledger.categories(kind):
        if account.name == name:
            return account.id
    return ledger.add_account(LedgerAccount(name=name, type=kind, subtype=AccountSubtype.CATEGORY)).id


def _operation_for(ledger: Ledger, batch: ImportBatch, item: ExtractedItem) -> Operation:
    assert batch.account_id is not None and item.amount is not None
    value: Decimal = item.amount
    account = ledger.account(batch.account_id)
    origin = Origin(kind=OriginKind.IMPORT, import_id=batch.id, evidence_ids=item.evidence_ids)
    target = item.target_account_id
    common = {
        "description": item.description,
        "occurred_on": item.occurred_on,
        "origin": origin,
        "member_id": item.member_id,
        "card_id": batch.card_id,
    }
    notes = None
    if item.installment:
        notes = f"Parcela {item.installment[0]}/{item.installment[1]} (documento)"
    if item.foreign_amount is not None:
        notes = (notes + "; " if notes else "") + f"{item.foreign_currency} {item.foreign_amount}"
    common["notes"] = notes

    if item.kind is ItemKind.PURCHASE:
        target = target or _default_category(ledger, AccountType.EXPENSE, "Outras despesas")
        return Operation(
            kind=OperationKind.CARD_PURCHASE,
            postings=(Posting(account_id=target, amount=value), Posting(account_id=account.id, amount=-value)),
            **common,
        )
    if item.kind is ItemKind.CARD_CHARGE:
        target = target or _default_category(ledger, AccountType.EXPENSE, "Juros e encargos")
        return Operation(
            kind=OperationKind.CARD_CHARGE,
            postings=(Posting(account_id=target, amount=value), Posting(account_id=account.id, amount=-value)),
            **common,
        )
    if item.kind is ItemKind.CARD_CREDIT:
        target = target or _default_category(ledger, AccountType.EXPENSE, "Outras despesas")
        return Operation(
            kind=OperationKind.REFUND,
            postings=(Posting(account_id=account.id, amount=value), Posting(account_id=target, amount=-value)),
            **common,
        )
    if item.kind is ItemKind.CARD_PAYMENT:
        card = ledger.cards.get(batch.card_id) if batch.card_id else None
        source = target or (card.settlement_account_id if card else None)
        if source is None:
            raise DomainError("Informe a conta que pagou a fatura (ou defina a conta de pagamento do cartão).")
        return Operation(
            kind=OperationKind.CARD_PAYMENT,
            postings=(Posting(account_id=account.id, amount=value), Posting(account_id=source, amount=-value)),
            settled_on=item.occurred_on,
            **common,
        )
    if item.kind in (ItemKind.DEBIT, ItemKind.CREDIT):
        incoming = item.kind is ItemKind.CREDIT
        if target is None:
            target = _default_category(
                ledger,
                AccountType.INCOME if incoming else AccountType.EXPENSE,
                "Outras receitas" if incoming else "Outras despesas",
            )
        counterpart = ledger.account(target)
        kind = OperationKind.INCOME if incoming else OperationKind.EXPENSE
        if counterpart.type in (AccountType.ASSET, AccountType.LIABILITY):
            kind = (
                OperationKind.CARD_PAYMENT
                if counterpart.subtype is AccountSubtype.CREDIT_CARD
                else OperationKind.TRANSFER
            )
        sign = 1 if incoming else -1
        return Operation(
            kind=kind,
            postings=(
                Posting(account_id=account.id, amount=sign * value),
                Posting(account_id=target, amount=-sign * value),
            ),
            settled_on=item.occurred_on,
            **common,
        )
    raise DomainError("Tipo de item não aprovável aqui.")
