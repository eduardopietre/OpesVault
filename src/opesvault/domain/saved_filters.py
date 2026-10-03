"""Saved Ledger filters ("Cartão da Ana este mês"), kept in the vault (docs/09 §1.3 A).

They name accounts and members of this family, so they live in the vault and never in the
computer's preferences.
"""

from uuid import UUID

from pydantic import Field

from opesvault.domain.ledger import DomainError, Ledger
from opesvault.domain.model import _Entity

PERIODS = ("all", "month", "this_month", "last_month", "last_3", "this_year")


class SavedFilter(_Entity):
    name: str = Field(min_length=1, max_length=60)
    period: str = "all"  # one of PERIODS; a custom range is not saved (it would go stale)
    account_id: UUID | None = None
    member_id: UUID | None = None
    text: str = Field(default="", max_length=200)
    status: str = "all"
    origin: str | None = None
    tag: str | None = Field(default=None, max_length=40)


Ledger.register_kind("saved_filter", SavedFilter)


def saved(ledger: Ledger) -> list[SavedFilter]:
    return sorted(ledger.entities("saved_filter").values(), key=lambda f: f.name.casefold())


def save_filter(ledger: Ledger, flt: SavedFilter) -> SavedFilter:
    name = " ".join(flt.name.split())
    if not name:
        raise DomainError("Dê um nome ao filtro.")
    if flt.period not in PERIODS:
        raise DomainError("Período personalizado não é salvo; escolha um período com nome.")
    existing = next((f for f in saved(ledger) if f.name.casefold() == name.casefold()), None)
    flt = flt.model_copy(update={"name": name})
    if existing is not None:
        return ledger.put("saved_filter", flt.model_copy(update={"id": existing.id}), reason="filtro substituído")
    return ledger.put("saved_filter", flt)


def delete_filter(ledger: Ledger, filter_id: UUID) -> None:
    collection = ledger.entities("saved_filter")
    if filter_id in collection:
        del collection[filter_id]
