"""Readable merchant names suggested by the local AI ("IFD*IFOOD.COM AGENCIA" → "iFood").

The same three steps as the category suggestions (`ai_suggestions`): `plan_names` copies the
descriptions on the UI thread, `ask_names` talks to the model in the background without the
ledger, and `apply_names` approves, on the UI thread, only the names the user kept in the
review. One description per merchant key is asked (`merchants.key_of`), so a store seen in a
hundred operations costs one line. The approval records which model suggested the name.
"""

import threading
from collections.abc import Callable
from dataclasses import dataclass, field
from uuid import UUID

from opesvault.ai.ollama import OllamaClient
from opesvault.domain import merchants
from opesvault.domain.ledger import DomainError, Ledger
from opesvault.importing import learning


@dataclass(frozen=True)
class NameRequest:
    """One line per merchant key; a plain copy, safe to use off the UI thread."""

    descriptions: tuple[str, ...]
    keys: tuple[str, ...]
    counts: tuple[int, ...]  # operations behind each key
    current: tuple[str, ...]  # the name shown today (approved or cleaned)


@dataclass(frozen=True)
class NameProposal:
    key: str
    description: str
    count: int
    current: str
    name: str
    source: str


@dataclass
class NameOutcome:
    proposals: list[NameProposal] = field(default_factory=list)
    asked: int = 0  # merchant keys asked about
    failed: int = 0  # left unanswered (bad answer, interruption)
    cancelled: bool = False


def plan_names(ledger: Ledger, operation_ids: list[UUID], *, renamed: bool = False) -> NameRequest:
    """The merchants of these operations (only income and expenses: a transfer is no merchant).

    Merchants that already have an approved name are left out unless `renamed`.
    """
    approved = {a.key for a in merchants.aliases(ledger).values()}
    found: dict[str, list[str]] = {}
    for op_id in operation_ids:
        op = ledger.operations.get(op_id)
        if op is None or not op.active or learning.category_of(ledger, op) is None:
            continue
        key = merchants.key_of(op.description)
        if len(key) < 3 or (key in approved and not renamed):
            continue
        found.setdefault(key, []).append(op.description)
    keys = tuple(found)
    return NameRequest(
        descriptions=tuple(found[k][0] for k in keys),
        keys=keys,
        counts=tuple(len(found[k]) for k in keys),
        current=tuple(merchants.merchant_of(ledger, found[k][0]) for k in keys),
    )


def ask_names(
    client: OllamaClient,
    request: NameRequest,
    on_progress: Callable[[int, int], None] | None = None,
    cancel: threading.Event | None = None,
) -> NameOutcome:
    """Asks the model (background thread; no ledger access). Names equal to today's are dropped.

    Raises AiUnavailable only when nothing at all could be asked.
    """
    total = len(request.descriptions)
    outcome = NameOutcome(asked=total)
    if not total:
        return outcome

    def report(handled: int) -> None:
        if on_progress is not None:
            on_progress(handled, total)

    run = client.suggest_names(
        request.descriptions, on_progress=report, cancelled=cancel.is_set if cancel is not None else None
    )
    outcome.cancelled = run.cancelled
    outcome.failed = len(run.failed)
    for s in run.suggestions:
        if s.name == request.current[s.index]:  # "Ifood" → "iFood" is still worth offering
            continue
        outcome.proposals.append(
            NameProposal(
                request.keys[s.index],
                request.descriptions[s.index],
                request.counts[s.index],
                request.current[s.index],
                s.name,
                s.source,
            )
        )
    return outcome


def apply_names(ledger: Ledger, chosen: list[tuple[NameProposal, str]]) -> tuple[int, list[str]]:
    """Approves the names the user kept (possibly edited). Returns how many and what was refused."""
    count = 0
    refused: list[str] = []
    for proposal, name in chosen:
        try:
            merchants.name_merchant(ledger, proposal.description, name, origin=f"sugestão {proposal.source}")
        except DomainError as exc:
            refused.append(f"{name}: {exc}")
            continue
        count += 1
    return count, refused
