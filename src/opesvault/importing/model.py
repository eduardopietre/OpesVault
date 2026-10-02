"""Import entities: batches, evidence and extracted items (docs/04 §1, docs/05).

Extracted data is not approved data (docs/00 §4.1): items live here until the
user approves them, and only then become ledger operations.
"""

from datetime import date, datetime
from decimal import Decimal
from enum import StrEnum
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field

from opesvault.domain.ledger import Ledger
from opesvault.domain.model import Amount, _Entity


class DocFormat(StrEnum):
    PDF = "pdf"
    CSV = "csv"
    OFX = "ofx"


class DocType(StrEnum):
    CARD_STATEMENT = "card_statement"
    BANK_STATEMENT = "bank_statement"
    BROKERAGE_NOTE = "brokerage_note"
    INVESTMENT_STATEMENT = "investment_statement"


class BatchStatus(StrEnum):
    UNSUPPORTED = "unsupported"  # scanned, corrupt, unknown layout
    AMBIGUOUS = "ambiguous"  # several layouts match; user must choose
    IN_REVIEW = "in_review"
    PARTIAL = "partial"  # some items approved, others pending, by explicit choice
    APPROVED = "approved"
    REJECTED = "rejected"


class ItemKind(StrEnum):
    PURCHASE = "purchase"  # card purchase
    CARD_CREDIT = "card_credit"  # refund/credit on the card
    CARD_PAYMENT = "card_payment"  # payment received by the card
    CARD_CHARGE = "card_charge"  # interest, fees, IOF
    DEBIT = "debit"  # bank account outflow
    CREDIT = "credit"  # bank account inflow
    TRADE = "trade"  # brokerage note line
    FEE = "fee"  # brokerage note fee


class ItemStatus(StrEnum):
    NEEDS_REVIEW = "needs_review"
    READY = "ready"  # validated, waiting for approval
    APPROVED = "approved"
    REJECTED = "rejected"
    DUPLICATE = "duplicate"  # already in the ledger; approval links evidence only


class Evidence(_Entity):
    document_id: UUID
    page: int | None = None  # 1-based; None for structured files
    bbox: tuple[float, float, float, float] | None = None  # x0, top, x1, bottom in PDF points
    line: int | None = None  # 1-based line/record for CSV and OFX
    text: str = Field(max_length=2000)


class Correction(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")

    field: str
    before: str | None
    after: str | None
    operator: str | None
    reason: str | None
    at: datetime


class ExtractedItem(_Entity):
    batch_id: UUID
    kind: ItemKind
    occurred_on: date | None
    description: str = Field(max_length=500)
    amount: Amount | None  # always positive; direction comes from `kind`
    evidence_ids: tuple[UUID, ...] = ()
    installment: tuple[int, int] | None = None  # (number, total)
    card_last4: str | None = None
    bank_id: str | None = None  # FITID or bank's own identifier when available
    foreign_amount: Amount | None = None
    foreign_currency: str | None = None
    quantity: Amount | None = None  # brokerage trades
    unit_price: Amount | None = None
    ticker: str | None = None
    credit: bool = False
    status: ItemStatus = ItemStatus.NEEDS_REVIEW
    warnings: tuple[str, ...] = ()
    target_account_id: UUID | None = None  # category, counterpart account or card chosen in review
    member_id: UUID | None = None
    duplicate_of: UUID | None = None  # operation already holding this fact
    operation_id: UUID | None = None  # operation created/linked on approval
    corrections: tuple[Correction, ...] = ()
    suggestion_source: str | None = None  # "history", "rule", "ollama:<model>"; never documentary


class StatementHeader(BaseModel):
    """Document-level facts used for reconciliation (docs/05 §2)."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    institution: str | None = None
    holder: str | None = None
    account_hint: str | None = None
    period_start: date | None = None
    period_end: date | None = None
    due_on: date | None = None
    closing_on: date | None = None
    total: Amount | None = None  # card bill total
    previous_balance: Amount | None = None
    opening_balance: Amount | None = None
    closing_balance: Amount | None = None
    note_number: str | None = None
    trade_date: date | None = None
    settlement_date: date | None = None
    net_amount: Amount | None = None  # brokerage note net (positive = credit to client)


class Reconciliation(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")

    label: str
    expected: Amount | None
    computed: Amount | None
    ok: bool | None  # None when not comparable

    @property
    def difference(self) -> Decimal | None:
        if self.expected is None or self.computed is None:
            return None
        return self.computed - self.expected


class ImportBatch(_Entity):
    document_id: UUID
    parser_id: str | None
    parser_version: str | None
    doc_format: DocFormat
    doc_type: DocType | None = None
    status: BatchStatus
    created_at: datetime
    account_id: UUID | None = None  # bank account or card liability this document belongs to
    card_id: UUID | None = None
    header: StatementHeader = StatementHeader()
    reconciliations: tuple[Reconciliation, ...] = ()
    warnings: tuple[str, ...] = ()
    candidates: tuple[str, ...] = ()  # parser ids when AMBIGUOUS
    unmapped_lines: int = 0
    partial_reason: str | None = None


for _kind, _model in (("import_batch", ImportBatch), ("evidence", Evidence), ("extracted_item", ExtractedItem)):
    Ledger.register_kind(_kind, _model)
