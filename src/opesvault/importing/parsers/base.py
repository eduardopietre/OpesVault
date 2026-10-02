"""Parser contract: one parser per institution + product + document type + layout version (docs/05 §1)."""

import re
from dataclasses import dataclass, field
from datetime import date
from decimal import Decimal
from typing import ClassVar

from opesvault.domain.money import MoneyError, parse_brl
from opesvault.importing.model import DocFormat, DocType, ItemKind, StatementHeader
from opesvault.importing.source import Line, Source

MONTHS_PT = {
    "JAN": 1,
    "FEV": 2,
    "MAR": 3,
    "ABR": 4,
    "MAI": 5,
    "JUN": 6,
    "JUL": 7,
    "AGO": 8,
    "SET": 9,
    "OUT": 10,
    "NOV": 11,
    "DEZ": 12,
}

AMOUNT_RE = r"-?−?(?:R\$\s*)?-?\d{1,3}(?:\.\d{3})*,\d{2}-?"


@dataclass
class ParsedItem:
    kind: ItemKind
    occurred_on: date | None
    description: str
    amount: Decimal | None
    lines: list[Line]
    installment: tuple[int, int] | None = None
    card_last4: str | None = None
    bank_id: str | None = None
    foreign_amount: Decimal | None = None
    foreign_currency: str | None = None
    quantity: Decimal | None = None
    unit_price: Decimal | None = None
    ticker: str | None = None
    credit: bool = False  # fee lines credited to the client
    warnings: list[str] = field(default_factory=list)


@dataclass
class ParseResult:
    header: StatementHeader
    items: list[ParsedItem]
    warnings: list[str] = field(default_factory=list)
    unmapped: list[Line] = field(default_factory=list)


class Parser:
    id: ClassVar[str]
    version: ClassVar[str]
    institution: ClassVar[str]
    product: ClassVar[str]
    doc_type: ClassVar[DocType]
    doc_format: ClassVar[DocFormat]
    # Synthetic layouts are built from public descriptions and must be confirmed with real documents.
    validated_with_real_documents: ClassVar[bool] = False
    limitations: ClassVar[str] = ""

    def detect(self, source: Source) -> float:
        """Confidence in [0, 1] that this parser understands the document."""
        raise NotImplementedError

    def parse(self, source: Source) -> ParseResult:
        raise NotImplementedError


def amount(text: str) -> Decimal:
    return parse_brl(text.replace("−", "-"))


def try_amount(text: str) -> Decimal | None:
    try:
        return amount(text)
    except MoneyError:
        return None


def dmy(text: str) -> date | None:
    """'31/01/2026' or '31/01/26'. Impossible dates return None (they are errors, docs/05 §4)."""
    match = re.fullmatch(r"(\d{2})/(\d{2})/(\d{2}|\d{4})", text.strip())
    if not match:
        return None
    day, month, year = int(match[1]), int(match[2]), int(match[3])
    if year < 100:
        year += 2000
    try:
        return date(year, month, day)
    except ValueError:
        return None


def resolve_year(day: int, month: int, reference: date) -> date | None:
    """Dates printed without year: pick the year that puts them on or before the reference date.

    The reference comes from the document (closing or due date), never the computer clock
    (docs/05 §4). Purchases dated after the reference belong to the previous year.
    """
    for year in (reference.year, reference.year - 1):
        try:
            candidate = date(year, month, day)
        except ValueError:
            continue
        if candidate <= reference:
            return candidate
    return None


def contains_all(text: str, *needles: str) -> bool:
    folded = text.casefold()
    return all(n.casefold() in folded for n in needles)
