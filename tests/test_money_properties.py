"""Properties of exact money (domain/money.py) over many generated values, not only examples.

Amounts cover cents, thousands, millions, negatives and ties at half a cent; every check is
reproducible from its seed.
"""

import random
from decimal import Decimal

import pytest

from opesvault.domain.money import (
    CENT,
    ZERO,
    MoneyError,
    allocate,
    format_brl,
    format_decimal_br,
    parse_brl,
    round_money,
    to_decimal,
)

CASES = 2000


def _rng(seed: str) -> random.Random:
    return random.Random(seed)  # noqa: S311 - reproducible test data, not secrets


def _cents(rng: random.Random) -> Decimal:
    magnitude = rng.choice([1, 100, 10_000, 1_000_000, 100_000_000_000])
    value = Decimal(rng.randint(0, magnitude)) * CENT
    return -value if rng.random() < 0.3 else value


def _fine(rng: random.Random) -> Decimal:
    """A value with more than two decimals, often exactly on a half cent."""
    base = _cents(rng)
    tail = rng.choice([Decimal("0.005"), Decimal("0.0049"), Decimal("0.0051"), Decimal("0.00999")])
    return base + (tail if base >= 0 else -tail)


def test_formatting_then_parsing_gives_the_rounded_amount_back() -> None:
    rng = _rng("brl-roundtrip")
    for _ in range(CASES):
        value = rng.choice([_cents, _fine])(rng)
        text = format_brl(value)
        assert parse_brl(text) == round_money(value), text
        assert text.count(",") == 1 and len(text.rsplit(",", 1)[1]) == 2


def test_the_sign_is_written_once_and_read_back() -> None:
    rng = _rng("brl-sign")
    for _ in range(CASES):
        value = _cents(rng)
        signed = format_brl(value, sign=True)
        assert signed.startswith("+") == (value > 0)
        assert signed.startswith("-") == (value < 0)
        assert parse_brl(signed) == value


def test_ties_go_away_from_zero_for_both_signs() -> None:
    rng = _rng("half-up")
    for _ in range(CASES):
        cents = Decimal(rng.randint(0, 10_000_000)) * CENT
        tie = cents + Decimal("0.005")
        assert round_money(tie) == cents + CENT
        assert round_money(-tie) == -(cents + CENT)
        assert round_money(cents + Decimal("0.0049")) == cents


def test_plain_numbers_keep_their_places() -> None:
    rng = _rng("decimal-br")
    for _ in range(CASES):
        value = _fine(rng)
        text = format_decimal_br(value, 2)
        assert parse_brl(text) == round_money(value), text
        assert "." not in text.rsplit(",", 1)[-1]


@pytest.mark.parametrize("parts", [1, 2, 3, 7, 12])
def test_allocation_always_sums_to_the_total_within_a_cent_of_each_share(parts: int) -> None:
    rng = _rng(f"allocate-{parts}")
    for _ in range(CASES // 4):
        total = _cents(rng)
        weights = [Decimal(rng.randint(0, 1000)) for _ in range(parts)]
        if sum(weights) == 0:
            weights[0] = Decimal(1)
        shares = allocate(total, weights)
        assert sum(shares, ZERO) == total
        exact = [total * w / sum(weights) for w in weights]
        assert all(abs(share - ideal) < CENT for share, ideal in zip(shares, exact, strict=True))
        assert all(share == round_money(share) for share in shares)
        assert allocate(total, weights) == shares  # the same split every time


def test_equal_weights_differ_by_at_most_a_cent() -> None:
    rng = _rng("allocate-equal")
    for _ in range(CASES // 4):
        total = _cents(rng)
        shares = allocate(total, [Decimal(1)] * rng.randint(2, 9))
        assert max(shares) - min(shares) <= CENT


def test_floats_and_garbage_never_become_money() -> None:
    for bad in (0.1, 1.0, float("nan"), True, None, [], "abc", "1,5", "NaN", "Infinity"):
        with pytest.raises(MoneyError):
            to_decimal(bad)
    rng = _rng("garbage")
    alphabet = "0123456789.,-+R$ DCx"
    for _ in range(CASES):
        text = "".join(rng.choice(alphabet) for _ in range(rng.randint(0, 12)))
        try:
            value = parse_brl(text)
        except MoneyError:
            continue
        assert value.is_finite() and any(ch.isdigit() for ch in text)
        assert parse_brl(format_brl(value)) == round_money(value)  # accepted text reads like money
