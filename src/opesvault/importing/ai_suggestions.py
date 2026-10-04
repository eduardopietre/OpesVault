"""Applies optional Ollama category suggestions to pending import items.

Three steps, so the model never runs on the UI thread and the ledger is only touched there:

1. `plan_requests` (UI thread) copies what will be sent: the pending descriptions, the
   allowed categories and a few examples the family already approved.
2. `ask` (background) talks to the model. It never sees the ledger, so the user can keep
   reviewing while it runs.
3. `apply_suggestions` (UI thread) fills only the items still pending and without a category.

Spending and income items are asked separately, each with only its own categories. The same
description repeated in a statement (a monthly subscription, installments) is asked once.
"""

import re
import threading
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import date
from uuid import UUID

from opesvault.ai.ollama import MAX_EXAMPLES, AiUnavailable, OllamaClient
from opesvault.domain.ledger import Ledger
from opesvault.domain.model import AccountType
from opesvault.domain.settings import get_settings
from opesvault.importing.model import ExtractedItem, ItemKind, ItemStatus
from opesvault.importing.rules import normalize
from opesvault.importing.store import items, items_of

SPENDING = (ItemKind.PURCHASE, ItemKind.DEBIT, ItemKind.CARD_CHARGE)
INCOME = (ItemKind.CREDIT,)
PENDING = (ItemStatus.READY, ItemStatus.NEEDS_REVIEW)

# Words that say how something was paid, not what it was: they do not make two descriptions alike.
_NOISE = {
    "PIX", "TED", "DOC", "PAG", "COMPRA", "CARTAO", "DEBITO", "CREDITO", "ENVIADO", "RECEBIDO", "PARC",
    "PAGAMENTO", "TRANSF", "TRANSFERENCIA", "LTDA", "COM", "BRASIL", "PARCELA",
}  # fmt: skip


@dataclass(frozen=True)
class PlannedSuggestion:
    item_id: UUID
    category_id: UUID
    source: str


@dataclass(frozen=True)
class AiRequest:
    """One group (spending or income) as it will be sent; a plain copy, safe to use off the UI thread."""

    descriptions: tuple[str, ...]  # distinct descriptions
    item_ids: tuple[tuple[UUID, ...], ...]  # the items behind each description
    categories: dict[str, UUID]
    examples: tuple[tuple[str, str], ...]

    @property
    def items(self) -> int:
        return sum(len(ids) for ids in self.item_ids)


@dataclass
class AiOutcome:
    planned: list[PlannedSuggestion] = field(default_factory=list)
    asked: int = 0  # items asked about
    failed: int = 0  # items left unanswered (bad answer, interruption)
    cancelled: bool = False


def client_from_settings(ledger: Ledger) -> OllamaClient | None:
    settings = get_settings(ledger)
    if not settings.ai_enabled or not settings.ai_model:
        return None
    return OllamaClient(settings.ai_model)


def _pending(ledger: Ledger, batch_id: UUID) -> list[ExtractedItem]:
    return [
        i
        for i in items_of(ledger, batch_id)
        if i.status in PENDING and i.target_account_id is None and i.kind in SPENDING + INCOME
    ]


def pending_count(ledger: Ledger, batch_id: UUID) -> int:
    """Items the model could help with: pending, without a category, of a kind it classifies."""
    return len(_pending(ledger, batch_id))


def _key(description: str) -> str:
    """Two descriptions that differ only in numbers (installment, store number) are the same question."""
    return re.sub(r"\d+", "#", normalize(description))


def _words(description: str) -> set[str]:
    return {w for w in re.findall(r"[A-Z]{3,}", normalize(description)) if w not in _NOISE}


def _examples(ledger: Ledger, categories: dict[str, UUID], asked: list[str]) -> tuple[tuple[str, str], ...]:
    """Approved items of these categories, the most alike to what is being asked first.

    Exact repeats never reach the model (the history suggestion already covers them), so the
    examples teach the family's criteria for similar places, not the answer to a known one.
    """
    names = {v: k for k, v in categories.items()}
    asked_keys = {_key(d) for d in asked}
    wanted = set().union(*(_words(d) for d in asked)) if asked else set()
    latest: dict[str, ExtractedItem] = {}
    for item in items(ledger).values():
        if item.status is not ItemStatus.APPROVED or item.target_account_id not in names:
            continue
        key = _key(item.description)
        if key in asked_keys:
            continue
        current = latest.get(key)
        if current is None or (item.occurred_on or date.min) > (current.occurred_on or date.min):
            latest[key] = item

    def rank(item: ExtractedItem) -> tuple[int, date]:
        return len(_words(item.description) & wanted), item.occurred_on or date.min

    chosen = sorted(latest.values(), key=rank, reverse=True)[:MAX_EXAMPLES]
    return tuple((i.description, names[i.target_account_id]) for i in chosen if i.target_account_id)


def plan_requests(ledger: Ledger, batch_id: UUID) -> list[AiRequest]:
    """What `ask` will send for this batch (UI thread: it reads the ledger)."""
    pending = _pending(ledger, batch_id)
    requests: list[AiRequest] = []
    for kinds, account_type in ((SPENDING, AccountType.EXPENSE), (INCOME, AccountType.INCOME)):
        categories = {a.name: a.id for a in ledger.categories(account_type)}
        grouped: dict[str, list[ExtractedItem]] = {}
        for item in pending:
            if item.kind in kinds:
                grouped.setdefault(_key(item.description), []).append(item)
        if not grouped or not categories:
            continue
        descriptions = [same[0].description for same in grouped.values()]
        requests.append(
            AiRequest(
                descriptions=tuple(descriptions),
                item_ids=tuple(tuple(i.id for i in same) for same in grouped.values()),
                categories=categories,
                examples=_examples(ledger, categories, descriptions),
            )
        )
    return requests


def ask(
    client: OllamaClient,
    requests: list[AiRequest],
    on_progress: Callable[[int, int], None] | None = None,
    cancel: threading.Event | None = None,
) -> AiOutcome:
    """Asks the model (background thread; no ledger access). Progress counts distinct descriptions.

    Raises AiUnavailable only when nothing at all could be asked.
    """
    outcome = AiOutcome()
    total = sum(len(r.descriptions) for r in requests)
    done = 0
    for request in requests:
        outcome.asked += request.items
        if cancel is not None and cancel.is_set():
            outcome.cancelled = True
            outcome.failed += request.items
            continue
        base = done

        def report(handled: int, base: int = base) -> None:
            if on_progress is not None:
                on_progress(base + handled, total)

        try:
            run = client.suggest_categories(
                request.descriptions,
                sorted(request.categories),
                request.examples,
                on_progress=report,
                cancelled=cancel.is_set if cancel is not None else None,
            )
        except AiUnavailable:
            if outcome.planned or done:
                outcome.failed += request.items
                break
            raise
        done += len(request.descriptions)
        outcome.cancelled |= run.cancelled
        for suggestion in run.suggestions:
            category = request.categories[suggestion.category]
            for item_id in request.item_ids[suggestion.index]:
                outcome.planned.append(PlannedSuggestion(item_id, category, suggestion.source))
        outcome.failed += sum(len(request.item_ids[n]) for n in run.failed)
    return outcome


def ask_ai(ledger: Ledger, batch_id: UUID, client: OllamaClient) -> list[PlannedSuggestion]:
    """Plans and asks in one go (scripts and tests). Reads only; never writes."""
    return ask(client, plan_requests(ledger, batch_id)).planned


def apply_suggestions(ledger: Ledger, planned: list[PlannedSuggestion]) -> int:
    """Fills items still pending and without a category (the user may have chosen meanwhile)."""
    store = items(ledger)
    count = 0
    for plan in planned:
        item = store.get(plan.item_id)
        if item is None or item.target_account_id is not None or item.status not in PENDING:
            continue
        store[item.id] = item.model_copy(
            update={"target_account_id": plan.category_id, "suggestion_source": plan.source}
        )
        count += 1
    return count


def suggest_with_ai(ledger: Ledger, batch_id: UUID, client: OllamaClient | None = None) -> int:
    """All steps at once (scripts and tests). Returns how many were suggested."""
    client = client or client_from_settings(ledger)
    if client is None:
        return 0
    return apply_suggestions(ledger, ask_ai(ledger, batch_id, client))


# ── models used in this session, released when the vault closes ──

_used: set[str] = set()
_used_lock = threading.Lock()


def remember_used(client: OllamaClient) -> None:
    with _used_lock:
        _used.add(client.model)


def release_models(*, wait: bool = False) -> None:
    """Unloads the models this process used, and with them the prompts Ollama still caches."""
    with _used_lock:
        models = sorted(_used)
        _used.clear()
    if not models:
        return

    def unload() -> None:
        for model in models:
            OllamaClient(model).unload()

    worker = threading.Thread(target=unload, name="ollama-unload", daemon=True)
    worker.start()
    if wait:
        worker.join(timeout=len(models) * 2.5)
