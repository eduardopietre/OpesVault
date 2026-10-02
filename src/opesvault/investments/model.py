"""Investment entities (docs/04 §1, docs/06).

Three families never mix: valuations (observed value at a date), money flows
(contributions, withdrawals, distributions) and taxes (effective or simulated).
"""

from datetime import date
from decimal import Decimal
from enum import StrEnum
from uuid import UUID

from pydantic import Field

from opesvault.domain.ledger import Ledger
from opesvault.domain.model import Amount, _Entity


class AssetClass(StrEnum):
    FIXED_INCOME = "fixed_income"
    TREASURY = "treasury"
    STOCK = "stock"
    REIT = "reit"  # FII
    FUND = "fund"
    ETF = "etf"
    PENSION = "pension"
    CRYPTO = "crypto"
    OTHER = "other"


ASSET_CLASS_LABELS = {
    AssetClass.FIXED_INCOME: "Renda fixa",
    AssetClass.TREASURY: "Tesouro Direto",
    AssetClass.STOCK: "Ações",
    AssetClass.REIT: "Fundos imobiliários",
    AssetClass.FUND: "Fundos",
    AssetClass.ETF: "ETF",
    AssetClass.PENSION: "Previdência",
    AssetClass.CRYPTO: "Criptoativos",
    AssetClass.OTHER: "Outros",
}

# Classes where selling more than held makes no sense (no short selling, docs/04 §2).
NO_SHORT = frozenset(AssetClass)


class Asset(_Entity):
    name: str = Field(min_length=1, max_length=200)
    asset_class: AssetClass
    ticker: str | None = Field(default=None, max_length=20)
    currency: str = "BRL"


class TrackingMode(StrEnum):
    VALUE = "value"  # observed totals only (docs/06 §1)
    QUANTITY = "quantity"  # trades with quantity and price


class Position(_Entity):
    asset_id: UUID
    account_id: UUID  # ledger asset account holding the cost basis
    holder_id: UUID | None = None
    mode: TrackingMode = TrackingMode.VALUE
    opened_on: date
    cost_known: bool = True  # False: tracked from a reference value; gain since acquisition is unknown
    closed: bool = False


class ValueNature(StrEnum):
    GROSS = "gross"  # before exit taxes
    NET_INFORMED = "net_informed"
    NET_ESTIMATED = "net_estimated"
    UNSPECIFIED = "unspecified"


NATURE_LABELS = {
    ValueNature.GROSS: "Bruto",
    ValueNature.NET_INFORMED: "Líquido informado",
    ValueNature.NET_ESTIMATED: "Líquido estimado",
    ValueNature.UNSPECIFIED: "Não especificado",
}


class Valuation(_Entity):
    position_id: UUID
    on: date
    value: Amount
    nature: ValueNature
    source: str = Field(default="manual", max_length=120)
    quantity: Amount | None = None
    unit_price: Amount | None = None
    note: str | None = Field(default=None, max_length=500)
    selected: bool = True  # among sources disagreeing on the same date, exactly one is used
    evidence_id: UUID | None = None


class EventKind(StrEnum):
    CONTRIBUTION = "contribution"  # aporte (cash into the position)
    WITHDRAWAL = "withdrawal"  # resgate/venda (cash out)
    DISTRIBUTION = "distribution"  # provento paid outside the position
    BUY = "buy"
    SELL = "sell"
    SPLIT = "split"  # desdobramento/grupamento: factor on quantity, cost unchanged
    BONUS = "bonus"  # bonificação: extra quantity with informed cost
    TAX_PAYMENT = "tax_payment"


class EventQuality(StrEnum):
    COMPLETE = "complete"
    INCOMPLETE = "incomplete"  # e.g. only the net is known: deductions to be itemized


class InvestmentEvent(_Entity):
    position_id: UUID
    kind: EventKind
    on: date
    gross: Amount | None = None
    quantity: Amount | None = None
    unit_price: Amount | None = None
    cost_attributed: Amount | None = None
    cost_method: str | None = None
    tax_withheld: Amount = Decimal("0")
    tax_due_later: Amount = Decimal("0")
    fees: Amount = Decimal("0")
    net: Amount | None = None
    cash_account_id: UUID | None = None
    operation_ids: tuple[UUID, ...] = ()
    quality: EventQuality = EventQuality.COMPLETE
    factor: Amount | None = None  # SPLIT
    lot_id: UUID | None = None
    note: str | None = Field(default=None, max_length=500)

    @property
    def realized_gain(self) -> Decimal | None:
        if (
            self.kind not in (EventKind.WITHDRAWAL, EventKind.SELL)
            or self.gross is None
            or self.cost_attributed is None
        ):
            return None
        return self.gross - self.cost_attributed


class TaxRuleKind(StrEnum):
    FIXED = "fixed"
    RATE_ON_POSITIVE_GAIN = "rate_on_positive_gain"
    RATE_ON_INFORMED_BASE = "rate_on_informed_base"


class TaxRule(_Entity):
    """User-parameterized rule (docs/06 §7). Never a legal default."""

    name: str = Field(min_length=1, max_length=120)
    version: str = "1"
    kind: TaxRuleKind
    rate: Amount | None = None  # e.g. 0.15
    fixed_amount: Amount | None = None
    valid_from: date | None = None
    valid_to: date | None = None
    source: str = Field(default="informado pelo usuário", max_length=300)
    simulated: bool = True


for _kind, _model in (
    ("asset", Asset),
    ("position", Position),
    ("valuation", Valuation),
    ("investment_event", InvestmentEvent),
    ("tax_rule", TaxRule),
):
    Ledger.register_kind(_kind, _model)
