"""Applies optional Ollama category suggestions to pending import items.

Two steps, so the model never runs on the UI thread and the ledger is only touched there:
`ask_ai` reads the pending items and asks the model (background), `apply_suggestions`
writes what came back (UI thread). Spending and income items are asked separately, each
with only the categories that make sense for it.
"""

from dataclasses import dataclass
from uuid import UUID

from opesvault.ai.ollama import OllamaClient
from opesvault.domain.ledger import Ledger
from opesvault.domain.model import AccountType
from opesvault.domain.settings import get_settings
from opesvault.importing.model import ItemKind, ItemStatus
from opesvault.importing.pipeline import items, items_of

SPENDING = (ItemKind.PURCHASE, ItemKind.DEBIT, ItemKind.CARD_CHARGE)
INCOME = (ItemKind.CREDIT,)


@dataclass(frozen=True)
class PlannedSuggestion:
    item_id: UUID
    category_id: UUID
    source: str


def client_from_settings(ledger: Ledger) -> OllamaClient | None:
    settings = get_settings(ledger)
    if not settings.ai_enabled or not settings.ai_model:
        return None
    return OllamaClient(settings.ai_model)


def ask_ai(ledger: Ledger, batch_id: UUID, client: OllamaClient) -> list[PlannedSuggestion]:
    """Asks the model for the pending items without a category. Reads only; never writes."""
    pending = [
        i
        for i in items_of(ledger, batch_id)
        if i.status in (ItemStatus.READY, ItemStatus.NEEDS_REVIEW) and i.target_account_id is None
    ]
    planned: list[PlannedSuggestion] = []
    for kinds, account_type in ((SPENDING, AccountType.EXPENSE), (INCOME, AccountType.INCOME)):
        group = [i for i in pending if i.kind in kinds]
        names = {a.name: a.id for a in ledger.categories(account_type)}
        if not group or not names:
            continue
        for suggestion in client.suggest_categories([i.description for i in group], sorted(names)):
            planned.append(PlannedSuggestion(group[suggestion.index].id, names[suggestion.category], suggestion.source))
    return planned


def apply_suggestions(ledger: Ledger, planned: list[PlannedSuggestion]) -> int:
    """Fills targets still empty (the user may have chosen meanwhile). Returns how many."""
    store = items(ledger)
    count = 0
    for plan in planned:
        item = store.get(plan.item_id)
        if item is None or item.target_account_id is not None:
            continue
        store[item.id] = item.model_copy(
            update={"target_account_id": plan.category_id, "suggestion_source": plan.source}
        )
        count += 1
    return count


def suggest_with_ai(ledger: Ledger, batch_id: UUID, client: OllamaClient | None = None) -> int:
    """Both steps at once (scripts and tests). Returns how many were suggested."""
    client = client or client_from_settings(ledger)
    if client is None:
        return 0
    return apply_suggestions(ledger, ask_ai(ledger, batch_id, client))
