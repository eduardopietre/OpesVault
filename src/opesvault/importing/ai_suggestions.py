"""Applies optional Ollama category suggestions to pending import items."""

from uuid import UUID

from opesvault.ai.ollama import OllamaClient
from opesvault.domain.ledger import Ledger
from opesvault.domain.model import AccountType
from opesvault.domain.settings import get_settings
from opesvault.importing.model import ItemKind, ItemStatus
from opesvault.importing.pipeline import items, items_of


def suggest_with_ai(ledger: Ledger, batch_id: UUID, client: OllamaClient | None = None) -> int:
    """Fill empty targets of pending items. Returns how many were suggested."""
    settings = get_settings(ledger)
    if client is None:
        if not settings.ai_enabled or not settings.ai_model:
            return 0
        client = OllamaClient(settings.ai_model)
    pending = [
        i
        for i in items_of(ledger, batch_id)
        if i.status in (ItemStatus.READY, ItemStatus.NEEDS_REVIEW)
        and i.target_account_id is None
        and i.kind in (ItemKind.PURCHASE, ItemKind.DEBIT, ItemKind.CREDIT, ItemKind.CARD_CHARGE)
    ]
    if not pending:
        return 0
    expense = {a.name: a.id for a in ledger.categories(AccountType.EXPENSE)}
    income = {a.name: a.id for a in ledger.categories(AccountType.INCOME)}
    suggestions = client.suggest_categories([i.description for i in pending], sorted({*expense, *income}))
    store = items(ledger)
    count = 0
    for suggestion in suggestions:
        item = pending[suggestion.index]
        pool = income if item.kind is ItemKind.CREDIT else expense
        target = pool.get(suggestion.category)
        if target is None:
            continue
        store[item.id] = item.model_copy(update={"target_account_id": target, "suggestion_source": suggestion.source})
        count += 1
    ledger.change_count += 1
    return count
