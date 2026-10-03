"""CPF and CNPJ: check digits, normalization and display.

A tax id is personal data: it lives only inside the vault, is shown only where the user
asked for it and never goes to logs or exception messages that could be recorded.
"""

import re
from enum import StrEnum

from opesvault.domain.ledger import DomainError


class TaxIdKind(StrEnum):
    CPF = "cpf"
    CNPJ = "cnpj"


def digits(text: str) -> str:
    return re.sub(r"\D", "", text or "")


def _check(numbers: str, weights: list[int]) -> int:
    total = sum(int(d) * w for d, w in zip(numbers, weights, strict=True))
    rest = total % 11
    return 0 if rest < 2 else 11 - rest


def is_cpf(value: str) -> bool:
    n = digits(value)
    if len(n) != 11 or n == n[0] * 11:
        return False
    first = _check(n[:9], list(range(10, 1, -1)))
    second = _check(n[:10], list(range(11, 1, -1)))
    return n[9:] == f"{first}{second}"


def is_cnpj(value: str) -> bool:
    n = digits(value)
    if len(n) != 14 or n == n[0] * 14:
        return False
    first = _check(n[:12], [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2])
    second = _check(n[:13], [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2])
    return n[12:] == f"{first}{second}"


def kind_of(value: str) -> TaxIdKind | None:
    n = digits(value)
    if len(n) == 11 and is_cpf(n):
        return TaxIdKind.CPF
    if len(n) == 14 and is_cnpj(n):
        return TaxIdKind.CNPJ
    return None


def normalize(value: str, allowed: tuple[TaxIdKind, ...] = (TaxIdKind.CPF, TaxIdKind.CNPJ)) -> str:
    """Only the digits of a valid CPF or CNPJ; a typo is refused, never stored."""
    kind = kind_of(value)
    if kind is None or kind not in allowed:
        names = " ou ".join(k.value.upper() for k in allowed)
        raise DomainError(f"{names} inválido: confira os dígitos.")
    return digits(value)


def display(value: str | None) -> str:
    """000.000.000-00 or 00.000.000/0000-00; anything else as stored."""
    n = digits(value or "")
    if len(n) == 11:
        return f"{n[:3]}.{n[3:6]}.{n[6:9]}-{n[9:]}"
    if len(n) == 14:
        return f"{n[:2]}.{n[2:5]}.{n[5:8]}/{n[8:12]}-{n[12:]}"
    return value or ""


CNPJ_IN_TEXT = re.compile(r"\b\d{2}\.?\d{3}\.?\d{3}/?\d{4}-?\d{2}\b")
CPF_IN_TEXT = re.compile(r"\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b")


def find_cnpj(text: str) -> str | None:
    """The first valid CNPJ written in a document line."""
    for match in CNPJ_IN_TEXT.finditer(text):
        if is_cnpj(match.group()):
            return digits(match.group())
    return None
