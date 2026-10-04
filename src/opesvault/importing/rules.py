"""User-defined categorization rules: "description contains X → category Y" (docs/05 §6).

Rules are suggestions, like everything else in review: they fill the category of
pending items and never approve anything. A user rule wins over the history of past
choices and over the built-in keyword rules; a category picked by hand always wins
over every rule.
"""

import re
import unicodedata
from collections.abc import Iterable
from uuid import UUID

from pydantic import Field

from opesvault.domain.ledger import DomainError, Ledger
from opesvault.domain.model import AccountSubtype, AccountType, _Entity

MIN_PATTERN = 3


def normalize(text: str) -> str:
    """Uppercase without accents and with single spaces: how descriptions are compared."""
    stripped = "".join(c for c in unicodedata.normalize("NFKD", text) if not unicodedata.combining(c))
    return re.sub(r"\s+", " ", stripped).strip().upper()


class CategoryRule(_Entity):
    pattern: str = Field(min_length=MIN_PATTERN, max_length=120)  # normalized text the description must contain
    target_account_id: UUID  # an income or expense category
    account_id: UUID | None = None  # only for documents of this account or card liability
    active: bool = True
    created_from_item: UUID | None = None
    version: int = 1


Ledger.register_kind("category_rule", CategoryRule)


def rules(ledger: Ledger) -> dict[UUID, CategoryRule]:
    return ledger.entities("category_rule")


def suggest_pattern(description: str) -> str:
    """A starting pattern from one description: drops installments, numbers and card ids.

    'UBER *TRIP 8812 PARCELA 2/3' → 'UBER *TRIP'; 'LOJA TV (6x)' → 'LOJA TV'. The user can still edit it.
    """
    text = normalize(description)
    text = re.sub(r"\bPARC(ELA)?\.?\s*\d+\s*/\s*\d+\b", " ", text)
    text = re.sub(r"\(\s*\d+\s*X\s*\)|\b\d+\s*X\b", " ", text)  # "(6x)", "10X": installments
    text = re.sub(r"\b\d+\s*/\s*\d+\b", " ", text)
    text = re.sub(r"[\d#]+", " ", text)
    # what is left of a removed number: "( )", a lone "-", "*" or "."
    words = [w for w in text.split() if any(c.isalpha() for c in w)]
    text = " ".join(words).strip(" -*.")
    return text or normalize(description)


def _check(ledger: Ledger, rule: CategoryRule) -> None:
    pattern = normalize(rule.pattern)
    if len(pattern) < MIN_PATTERN:
        raise DomainError(f"O texto da regra precisa ter ao menos {MIN_PATTERN} caracteres.")
    target = ledger.accounts.get(rule.target_account_id)
    if target is None or target.subtype is not AccountSubtype.CATEGORY:
        raise DomainError("Escolha uma categoria de receita ou despesa.")
    if rule.account_id is not None and rule.account_id not in ledger.accounts:
        raise DomainError("Conta da regra inexistente.")
    for other in rules(ledger).values():
        if other.id != rule.id and other.active and other.pattern == pattern and other.account_id == rule.account_id:
            raise DomainError("Já existe uma regra ativa com esse texto para essa conta.")


def add_rule(
    ledger: Ledger,
    pattern: str,
    target_id: UUID,
    account_id: UUID | None = None,
    from_item: UUID | None = None,
) -> CategoryRule:
    if len(normalize(pattern)) < MIN_PATTERN:
        raise DomainError(f"O texto da regra precisa ter ao menos {MIN_PATTERN} caracteres.")
    rule = CategoryRule(
        pattern=normalize(pattern),
        target_account_id=target_id,
        account_id=account_id,
        created_from_item=from_item,
    )
    _check(ledger, rule)
    return ledger.put("category_rule", rule)


def update_rule(ledger: Ledger, rule: CategoryRule, reason: str) -> CategoryRule:
    current = rules(ledger).get(rule.id)
    if current is None:
        raise DomainError("Regra inexistente.")
    if len(normalize(rule.pattern)) < MIN_PATTERN:
        raise DomainError(f"O texto da regra precisa ter ao menos {MIN_PATTERN} caracteres.")
    updated = rule.model_copy(update={"pattern": normalize(rule.pattern), "version": current.version + 1})
    if updated.active:
        _check(ledger, updated)
    return ledger.put("category_rule", updated, reason=reason)


def set_active(ledger: Ledger, rule_id: UUID, active: bool, reason: str) -> CategoryRule:
    """Rules are switched off, not erased, so the history keeps why a category was suggested."""
    current = rules(ledger).get(rule_id)
    if current is None:
        raise DomainError("Regra inexistente.")
    return update_rule(ledger, current.model_copy(update={"active": active}), reason)


def match(
    ledger: Ledger, description: str, account_id: UUID | None, wanted: AccountType | Iterable[AccountType]
) -> CategoryRule | None:
    """The most specific active rule: one limited to this account first, then the longest text."""
    kinds = {wanted} if isinstance(wanted, AccountType) else set(wanted)
    text = normalize(description)
    best: tuple[int, int, CategoryRule] | None = None
    for rule in rules(ledger).values():
        if not rule.active or rule.pattern not in text:
            continue
        if rule.account_id is not None and rule.account_id != account_id:
            continue
        target = ledger.accounts.get(rule.target_account_id)
        if target is None or target.archived or target.type not in kinds:
            continue
        score = (1 if rule.account_id is not None else 0, len(rule.pattern), rule)
        if best is None or score[:2] > best[:2]:
            best = score
    return best[2] if best else None


def usage(ledger: Ledger, rule_id: UUID) -> int:
    """How many review items this rule has categorized (approved or pending)."""
    from opesvault.importing.store import items

    return sum(1 for i in items(ledger).values() if i.suggestion_source == f"user_rule:{rule_id}")
