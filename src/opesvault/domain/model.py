"""Domain entities (docs/04). Immutable Pydantic models; the Ledger owns mutation."""

from datetime import date, datetime
from decimal import Decimal
from enum import StrEnum
from typing import Annotated, Any
from uuid import UUID, uuid4

from pydantic import BaseModel, ConfigDict, Field, PlainSerializer, field_validator

from opesvault.domain.money import BRL, to_decimal

# Decimals serialize as strings so JSON never round-trips through float.
Amount = Annotated[Decimal, PlainSerializer(lambda d: format(d, "f"), return_type=str, when_used="json")]


def new_id() -> UUID:
    return uuid4()


class _Entity(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")

    id: UUID = Field(default_factory=new_id)


class YearMonth(BaseModel):
    """A competence month (year + month)."""

    model_config = ConfigDict(frozen=True)

    year: int = Field(ge=1900, le=2999)
    month: int = Field(ge=1, le=12)

    @classmethod
    def of(cls, d: date) -> "YearMonth":
        return cls(year=d.year, month=d.month)

    @classmethod
    def parse(cls, text: str) -> "YearMonth":
        year, month = text.split("-")
        return cls(year=int(year), month=int(month))

    def __str__(self) -> str:
        return f"{self.year:04d}-{self.month:02d}"

    def first_day(self) -> date:
        return date(self.year, self.month, 1)

    def last_day(self) -> date:
        return date.fromordinal(self.add(1).first_day().toordinal() - 1)

    def add(self, months: int) -> "YearMonth":
        index = self.year * 12 + (self.month - 1) + months
        return YearMonth(year=index // 12, month=index % 12 + 1)

    def __lt__(self, other: "YearMonth") -> bool:
        return (self.year, self.month) < (other.year, other.month)

    def __le__(self, other: "YearMonth") -> bool:
        return (self.year, self.month) <= (other.year, other.month)


# ── people and accounts ─────────────────────────────────


class MemberRole(StrEnum):
    """Who answers for the family's money (holder) and who depends on it (dependent).

    Informative: it labels people in lists and forms; it grants or blocks nothing.
    """

    HOLDER = "holder"
    DEPENDENT = "dependent"


class Member(_Entity):
    name: str = Field(min_length=1, max_length=120)
    active: bool = True
    role: MemberRole = MemberRole.HOLDER


class AccountType(StrEnum):
    ASSET = "asset"
    LIABILITY = "liability"
    EQUITY = "equity"
    INCOME = "income"
    EXPENSE = "expense"


class AccountSubtype(StrEnum):
    CHECKING = "checking"
    SAVINGS = "savings"
    CASH = "cash"
    BROKERAGE_CASH = "brokerage_cash"
    INVESTMENT = "investment"
    OTHER_ASSET = "other_asset"
    CREDIT_CARD = "credit_card"
    LOAN = "loan"
    OTHER_LIABILITY = "other_liability"
    OPENING_EQUITY = "opening_equity"
    CATEGORY = "category"
    TAX_PAYABLE = "tax_payable"


LIQUID_SUBTYPES = frozenset(
    {AccountSubtype.CHECKING, AccountSubtype.SAVINGS, AccountSubtype.CASH, AccountSubtype.BROKERAGE_CASH}
)


class LedgerAccount(_Entity):
    """Everything postings can hit: bank accounts, cards, equity and categories."""

    name: str = Field(min_length=1, max_length=120)
    type: AccountType
    subtype: AccountSubtype
    currency: str = BRL
    institution: str | None = None
    masked_number: str | None = Field(default=None, max_length=32)
    holders: tuple[UUID, ...] = ()
    parent_id: UUID | None = None
    archived: bool = False

    @property
    def is_liquid(self) -> bool:
        return self.subtype in LIQUID_SUBTYPES

    @property
    def is_balance_sheet(self) -> bool:
        return self.type in (AccountType.ASSET, AccountType.LIABILITY, AccountType.EQUITY)


class AdditionalCard(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")

    member_id: UUID
    last4: str = Field(pattern=r"^\d{4}$")


class Card(_Entity):
    """A credit card; its obligations live in `liability_account_id`."""

    name: str = Field(min_length=1, max_length=120)
    liability_account_id: UUID
    holder_id: UUID
    last4: str = Field(pattern=r"^\d{4}$")
    closing_day: int = Field(ge=1, le=31)
    due_day: int = Field(ge=1, le=31)
    settlement_account_id: UUID | None = None
    additional: tuple[AdditionalCard, ...] = ()


# ── operations ──────────────────────────────────────────


class OperationKind(StrEnum):
    OPENING_BALANCE = "opening_balance"
    INCOME = "income"
    EXPENSE = "expense"
    TRANSFER = "transfer"
    CARD_PURCHASE = "card_purchase"
    CARD_PAYMENT = "card_payment"
    CARD_CHARGE = "card_charge"  # interest, fees, IOF on the card
    REFUND = "refund"
    INVESTMENT_CONTRIBUTION = "investment_contribution"
    INVESTMENT_WITHDRAWAL = "investment_withdrawal"
    INVESTMENT_INCOME = "investment_income"
    TAX_PAYMENT = "tax_payment"
    REVERSAL = "reversal"
    OTHER = "other"


class OriginKind(StrEnum):
    MANUAL = "manual"
    IMPORT = "import"
    RECURRENCE = "recurrence"
    SYSTEM = "system"


class Origin(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")

    kind: OriginKind = OriginKind.MANUAL
    import_id: UUID | None = None
    evidence_ids: tuple[UUID, ...] = ()


class Posting(BaseModel):
    """Debit when amount > 0, credit when amount < 0."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    account_id: UUID
    amount: Amount
    member_id: UUID | None = None  # rateio: which member this share belongs to

    @field_validator("amount", mode="wrap")
    @classmethod
    def _exact(cls, value: object, handler: Any) -> Decimal:
        # Fast path for the common, already-exact inputs (strings from the vault, Decimals in code).
        kind = type(value)
        if kind is str or kind is Decimal:
            return handler(value)
        return to_decimal(value)


class InstallmentRef(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")

    plan_id: UUID
    number: int = Field(ge=1)
    total: int = Field(ge=1)


class OperationStatus(StrEnum):
    ACTIVE = "active"
    CANCELLED = "cancelled"


class Operation(_Entity):
    kind: OperationKind
    description: str = Field(max_length=500)
    currency: str = BRL
    postings: tuple[Posting, ...]
    # Dates are separate on purpose (docs/02 §6, docs/04 §5); unknown stays None.
    occurred_on: date | None = None
    booked_on: date | None = None
    accrual_month: YearMonth | None = None
    due_on: date | None = None
    settled_on: date | None = None
    origin: Origin = Origin()
    member_id: UUID | None = None
    card_id: UUID | None = None
    cardholder_id: UUID | None = None
    installment: InstallmentRef | None = None
    reversal_of: UUID | None = None
    forecast_id: UUID | None = None
    status: OperationStatus = OperationStatus.ACTIVE
    notes: str | None = Field(default=None, max_length=2000)
    version: int = 1

    @property
    def cash_date(self) -> date | None:
        return self.settled_on or self.booked_on or self.occurred_on

    @property
    def competence(self) -> YearMonth | None:
        if self.accrual_month is not None:
            return self.accrual_month
        reference = self.occurred_on or self.booked_on or self.settled_on
        return YearMonth.of(reference) if reference else None

    @property
    def active(self) -> bool:
        return self.status is OperationStatus.ACTIVE


# ── history ─────────────────────────────────────────────


class HistoryAction(StrEnum):
    CREATE = "create"
    UPDATE = "update"
    CANCEL = "cancel"
    ARCHIVE = "archive"
    CLOSE_PERIOD = "close_period"
    REOPEN_PERIOD = "reopen_period"
    APPROVE_IMPORT = "approve_import"


class HistoryEntry(_Entity):
    """Traceability, not tamper-proof evidence (docs/03 §1)."""

    entity_kind: str
    entity_id: UUID
    action: HistoryAction
    version: int
    before: dict[str, object] | None = None
    after: dict[str, object] | None = None
    operator: str | None = None
    reason: str | None = None
    at: datetime
