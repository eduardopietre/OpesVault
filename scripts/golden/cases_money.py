"""domain/money.py: parsing, formatting and allocation."""

import random
from decimal import Decimal
from typing import Any

from opesvault.domain.money import allocate, format_brl, format_decimal_br, parse_brl
from scripts.golden.common import outcome

TEXTS = [
    "1.234,56",
    "R$ -10,00",
    "40,00-",
    "-R$ 3,50",
    "−R$ 3,50",
    "12,00 D",
    "12,00 C",
    "R$ 1.000.000,00",
    "0,01",
    "1234,5",
    "+5,00",
    "- 5,00",
    "5",
    "1,234.56",
    "",
    "R$",
    "--1,00",
    "-1,00-",
    "1.23,45",
    "\xa0R$\xa01,00",
    "12,345",
    "1.234",
    "R$ +2,00",
    "3,00 X",
]


def generate() -> dict[str, Any]:
    rng = random.Random(7)
    parses = [{"text": t, **outcome(parse_brl, t)} for t in TEXTS]
    values = ["0", "-0", "0.005", "-0.005", "1234567.891", "-1234.5", "0.015", "1E+3", "999.995", "-999.994", "12"]
    for _ in range(60):
        values.append(str(Decimal(rng.randint(-(10**9), 10**9)) / Decimal(10 ** rng.randint(0, 4))))
    formats = []
    for v in values:
        d = Decimal(v)
        formats.append(
            {
                "value": v,
                "brl": format_brl(d),
                "brl_sign": format_brl(d, sign=True),
                "plain": format_decimal_br(d),
                "places2": format_decimal_br(d, 2),
                "places4": format_decimal_br(d, 4),
            }
        )
    allocations = []
    for _ in range(80):
        total = Decimal(rng.randint(-(10**6), 10**6)) / 100
        weights = [Decimal(rng.randint(0, 1000)) / Decimal(rng.choice([1, 3, 7])) for _ in range(rng.randint(1, 6))]
        allocations.append(
            {"total": str(total), "weights": [str(w) for w in weights], **outcome(allocate, total, weights)}
        )
    allocations.append({"total": "0.005", "weights": ["1"], **outcome(allocate, Decimal("0.005"), [Decimal(1)])})
    return {"parse": parses, "format": formats, "allocate": allocations}
