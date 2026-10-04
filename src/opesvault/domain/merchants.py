"""Readable merchant names: "IFD*IFOOD.COM AGENCIA" → "iFood" (docs/09 §1.3 D).

The bank's description stays untouched in the operation. A name approved by the user is an
alias kept beside it, matched by the cleaned description, so search, reports and rules can
read "iFood" without changing a single record. The cleaning is deterministic; the local AI
may suggest names elsewhere, but nothing here depends on it.
"""

import re
from collections import defaultdict
from dataclasses import dataclass
from datetime import date
from decimal import Decimal
from uuid import UUID

from pydantic import Field

from opesvault.domain.ledger import DomainError, Ledger
from opesvault.domain.model import AccountType, Operation, _Entity
from opesvault.domain.money import ZERO

# Payment processors that prefix the merchant on card statements.
PREFIXES = re.compile(
    r"^(?:IFD|MP|PAG|PG|EC|EBN|PP|DL|SUMUP|STONE|PAYPAL|GOOGLE|APPLE\.COM/BILL|HTM|CIELO|GETNET)\s*\*\s*"
)
NOISE = {"LTDA", "ME", "EIRELI", "SA", "S/A", "BR", "BRA", "BRASIL", "COM", "WWW", "AGENCIA", "PARCELA"}
MAX_WORDS = 3


class MerchantAlias(_Entity):
    key: str = Field(min_length=1, max_length=120)  # normalized cleaned description
    name: str = Field(min_length=1, max_length=60)


Ledger.register_kind("merchant_alias", MerchantAlias)


def aliases(ledger: Ledger) -> dict[UUID, MerchantAlias]:
    return ledger.entities("merchant_alias")


def clean(description: str) -> str:
    """The merchant part of a card or bank description, in title case ('Padaria Real')."""
    text = description.upper().strip()
    text = PREFIXES.sub("", text)
    text = re.sub(r"\(\d+/\d+\)|\d+/\d+", " ", text)  # installment marks
    text = re.sub(r"\.COM(\.BR)?\b", " ", text)
    words = [w for w in re.split(r"[\s*/\-_.,]+", text) if w]
    kept = [w for w in words if w not in NOISE and not any(c.isdigit() for c in w)]
    if not kept:
        return description.strip()[:60] or "?"
    return " ".join(w.capitalize() for w in kept[:MAX_WORDS])


def key_of(description: str) -> str:
    from opesvault.importing.rules import normalize

    return normalize(clean(description))


def merchant_of(ledger: Ledger, description: str) -> str:
    """The approved name for this description, or the cleaned description."""
    key = key_of(description)
    found = next((a for a in aliases(ledger).values() if a.key == key), None)
    return found.name if found is not None else clean(description)


def name_merchant(ledger: Ledger, description: str, name: str, origin: str | None = None) -> MerchantAlias:
    """Approves a readable name for every operation whose description cleans to the same key.

    `origin` goes to the history with the approval (a name the local AI suggested records the
    model and prompt version that suggested it, docs/05 §5).
    """
    display = " ".join(name.split())
    if not display:
        raise DomainError("Informe o nome do estabelecimento.")
    if len(display) > 60:
        raise DomainError("Use até 60 caracteres.")
    key = key_of(description)
    current = next((a for a in aliases(ledger).values() if a.key == key), None)
    if current is None:
        return ledger.put("merchant_alias", MerchantAlias(key=key, name=display), reason=origin)
    if current.name == display:
        return current
    return ledger.put("merchant_alias", current.model_copy(update={"name": display}), reason=origin or "nome alterado")


def remove_alias(ledger: Ledger, alias_id: UUID) -> None:
    if alias_id in aliases(ledger):
        del aliases(ledger)[alias_id]


@dataclass(frozen=True)
class MerchantTotal:
    name: str
    expense: Decimal
    count: int
    approved: bool  # the name was approved by the user (otherwise it is the cleaned description)


def totals(ledger: Ledger, start: date, end: date) -> list[MerchantTotal]:
    """Expense per merchant between two dates (occurrence date), largest first."""
    approved = {a.key for a in aliases(ledger).values()}
    sums: dict[str, Decimal] = defaultdict(lambda: ZERO)
    counts: dict[str, int] = defaultdict(int)
    flags: dict[str, bool] = {}
    for op in ledger.active_operations():
        when = op.occurred_on or op.cash_date
        if when is None or not start <= when <= end:
            continue
        value = _expense(ledger, op)
        if value == 0:
            continue
        name = merchant_of(ledger, op.description)
        sums[name] += value
        counts[name] += 1
        flags[name] = flags.get(name, False) or key_of(op.description) in approved
    out = [MerchantTotal(n, v, counts[n], flags[n]) for n, v in sums.items() if v]
    return sorted(out, key=lambda m: m.expense, reverse=True)


def _expense(ledger: Ledger, op: Operation) -> Decimal:
    return sum((p.amount for p in op.postings if ledger.account(p.account_id).type is AccountType.EXPENSE), ZERO)
