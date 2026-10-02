"""Exact money handling (docs/02 §6, docs/06 §9).

Floats are rejected everywhere: values enter as str, int or Decimal. The default
management rounding is cents with ties away from zero (ROUND_HALF_UP in Python).
"""

import re
from decimal import ROUND_HALF_UP, Decimal, InvalidOperation

CENT = Decimal("0.01")
ZERO = Decimal("0")
BRL = "BRL"

_BRL_PATTERN = re.compile(
    r"""^\s*
    (?P<lead>[-−+])?\s*          # leading sign (ASCII or Unicode minus)
    (?:R\$)?\s*
    (?P<lead2>[-−+])?\s*         # sign after the currency symbol ("R$ -10,00")
    (?P<int>\d{1,3}(?:\.\d{3})+|\d+)  # integer part, with or without thousand dots
    (?:,(?P<frac>\d+))?
    \s*(?P<trail>[-+DC])?\s*$         # trailing sign or D/C marker
    """,
    re.VERBOSE,
)


class MoneyError(ValueError):
    pass


def to_decimal(value: object) -> Decimal:
    """Convert to Decimal without ever passing through float."""
    if isinstance(value, (bool, float)):
        raise MoneyError("float or bool is not accepted for financial values")
    if isinstance(value, Decimal):
        result = value
    elif isinstance(value, int):
        result = Decimal(value)
    elif isinstance(value, str):
        try:
            result = Decimal(value.strip())
        except InvalidOperation:
            raise MoneyError("invalid decimal") from None
    else:
        raise MoneyError(f"unsupported type: {type(value).__name__}")
    if not result.is_finite():
        raise MoneyError("non-finite value")
    return result


def round_money(value: Decimal, quantum: Decimal = CENT) -> Decimal:
    return value.quantize(quantum, rounding=ROUND_HALF_UP)


def is_cents(value: Decimal) -> bool:
    return value == value.quantize(CENT)


def parse_brl(text: str) -> Decimal:
    """Parse Brazilian-formatted amounts: '1.234,56', 'R$ -10,00', '40,00-', '-R$ 3,50' (also with U+2212), '12,00 D'.

    A trailing 'D' means debit (negative) and 'C' credit (positive), as in
    brokerage notes. Raises MoneyError on anything ambiguous.
    """
    match = _BRL_PATTERN.match(text.replace("\xa0", " "))
    if not match:
        raise MoneyError("not a BRL amount")
    integer = match["int"].replace(".", "")
    frac = match["frac"] or ""
    value = Decimal(f"{integer}.{frac}" if frac else integer)
    signs = [s for s in (match["lead"], match["lead2"], match["trail"]) if s]
    if len(signs) > 1:
        raise MoneyError("conflicting signs")
    if signs and signs[0] in ("-", "−", "D"):
        value = -value
    return value


def format_brl(value: Decimal, *, sign: bool = False) -> str:
    """'R$ 1.234,56' with Brazilian separators; negatives as '-R$ 1.234,56'."""
    quantized = round_money(value)
    negative = quantized < 0
    integer, _, frac = f"{abs(quantized):.2f}".partition(".")
    groups: list[str] = []
    while len(integer) > 3:
        groups.insert(0, integer[-3:])
        integer = integer[:-3]
    groups.insert(0, integer)
    body = f"R$ {'.'.join(groups)},{frac}"
    if negative:
        return f"-{body}"
    return f"+{body}" if sign and quantized > 0 else body


def format_decimal_br(value: Decimal, places: int | None = None) -> str:
    """Plain Brazilian number formatting for quantities and rates."""
    if places is not None:
        value = value.quantize(Decimal(1).scaleb(-places), rounding=ROUND_HALF_UP)
    text = format(value, "f")
    integer, _, frac = text.partition(".")
    negative = integer.startswith("-")
    integer = integer.lstrip("-")
    groups: list[str] = []
    while len(integer) > 3:
        groups.insert(0, integer[-3:])
        integer = integer[:-3]
    groups.insert(0, integer)
    out = ".".join(groups) + ("," + frac if frac else "")
    return ("-" if negative else "") + out


def allocate(total: Decimal, weights: list[Decimal]) -> list[Decimal]:
    """Split `total` (in cents) proportionally to weights; residual cents are explicit.

    Uses the largest-remainder method so the parts always sum exactly to the total
    (docs/04 §1 rateio, docs/06 §9: residuals are never silently lost).
    """
    if not weights or any(w < 0 for w in weights) or sum(weights) == 0:
        raise MoneyError("invalid weights")
    if not is_cents(total):
        raise MoneyError("total must be in cents")
    cents = int(total / CENT)
    weight_sum = sum(weights)
    raw = [Decimal(cents) * w / weight_sum for w in weights]
    floors = [int(r.to_integral_value(rounding="ROUND_FLOOR")) for r in raw]
    remainder = cents - sum(floors)
    order = sorted(range(len(raw)), key=lambda i: (raw[i] - floors[i], -i), reverse=True)
    for i in order[: abs(remainder)]:
        floors[i] += 1 if remainder > 0 else -1
    return [Decimal(f) * CENT for f in floors]
