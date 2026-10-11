"""Fixed lists the app embeds so it works offline: banks (COMPE) and IRPF codes.

Lists, not rules: they name things the way the Banco Central and the IRPF program name them.
No tax rate, limit or exemption value lives here (docs/00 §5).
"""

from dataclasses import dataclass
from functools import cache

from opesvault.catalogs.banks import BANKS


@dataclass(frozen=True)
class Bank:
    code: str  # COMPE, three digits
    ispb: str
    cnpj: str  # digits, '' when unknown
    short_name: str
    name: str

    @property
    def label(self) -> str:
        return f"{self.code} — {self.name}"


@cache
def banks() -> tuple[Bank, ...]:
    return tuple(Bank(*row) for row in BANKS)


@cache
def _by_code() -> dict[str, Bank]:
    return {b.code: b for b in banks()}


def bank(code: str | None) -> Bank | None:
    if not code:
        return None
    return _by_code().get(code.strip().zfill(3))


def search(text: str, limit: int = 20) -> list[Bank]:
    """Banks whose code or name contains the text (accents and case ignored)."""
    from opesvault.importing.rules import normalize

    needle = normalize(text)
    if not needle:
        return []
    found = [b for b in banks() if needle in b.code or needle in normalize(b.name) or needle in normalize(b.short_name)]
    return found[:limit]
