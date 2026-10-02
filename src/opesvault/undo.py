"""Undo/redo for edits not yet saved (Ctrl+Z / Ctrl+Shift+Z).

Each user action (everything between two `seal()` calls) is one step. Undo puts back
the exact objects that existed before, including removing the history entries the
action created: an unsaved change never reached the vault, so it leaves no trace when
undone. After a save the stack is cleared; corrections to saved data keep going
through the history with a reason (estorno, correção, cancelamento).
"""

from collections import Counter
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from opesvault.session import Session

MAX_STEPS = 200

# What a step changed, in the user's words, by persisted kind (most specific first).
KIND_LABELS: tuple[tuple[str, str], ...] = (
    ("operation", "lançamento"),
    ("extracted_item", "revisão de importação"),
    ("import_batch", "importação"),
    ("budget_line", "orçamento"),
    ("category_rule", "regra de categoria"),
    ("recurrence_rule", "recorrência"),
    ("forecast_link", "recorrência"),
    ("period_close", "fechamento do mês"),
    ("card", "cartão"),
    ("account", "conta"),
    ("member", "integrante"),
    ("settings", "configurações"),
)


@dataclass
class Step:
    entries: list[tuple[Any, ...]]
    label: str


def describe(entries: list[tuple[Any, ...]]) -> str:
    kinds = Counter(e[1] for e in entries if e[0] == "entity")
    if any(e[0] == "external" for e in entries) and not kinds:
        return "documento"
    for kind, label in KIND_LABELS:
        if kind in kinds:
            if kind == "operation" and kinds[kind] > 1:
                return "lançamentos"
            return label
    return "alteração"


@dataclass
class UndoStack:
    session: "Session"
    undo_steps: list[Step] = field(default_factory=list)
    redo_steps: list[Step] = field(default_factory=list)

    def __post_init__(self) -> None:
        if self.session.ledger.journal is None:
            self.session.ledger.journal = []

    @property
    def journal(self) -> list[tuple[Any, ...]]:
        ledger = self.session.ledger
        if ledger.journal is None:  # the ledger was replaced (e.g. tests); start recording it
            ledger.journal = []
        return ledger.journal

    def seal(self) -> Step | None:
        """Closes the current user action as one undo step."""
        entries = list(self.journal)
        self.journal.clear()
        if not entries:
            return None
        step = Step(entries, describe(entries))
        self.undo_steps.append(step)
        del self.undo_steps[:-MAX_STEPS]
        self.redo_steps.clear()  # a new action forks history: redo no longer applies
        return step

    def can_undo(self) -> bool:
        return bool(self.undo_steps) or bool(self.journal)

    def can_redo(self) -> bool:
        return bool(self.redo_steps)

    def undo_label(self) -> str | None:
        if self.journal:
            return describe(self.journal)
        return self.undo_steps[-1].label if self.undo_steps else None

    def redo_label(self) -> str | None:
        return self.redo_steps[-1].label if self.redo_steps else None

    def undo(self) -> Step | None:
        self.seal()
        if not self.undo_steps:
            return None
        step = self.undo_steps.pop()
        self.session.ledger.revert(step.entries)
        self.redo_steps.append(step)
        return step

    def redo(self) -> Step | None:
        if not self.redo_steps:
            return None
        step = self.redo_steps.pop()
        self.session.ledger.replay(step.entries)
        self.undo_steps.append(step)
        return step

    def checkpoint(self) -> int:
        """Seals pending edits before a save; returns how many steps the save will contain."""
        self.seal()
        return len(self.undo_steps)

    def saved(self, steps: int) -> None:
        """The first `steps` steps are now in the vault: they can no longer be undone here.

        Edits made while the save ran stay undoable; redo is dropped because it would
        re-apply on top of a different saved state.
        """
        del self.undo_steps[:steps]
        self.redo_steps.clear()

    def clear(self) -> None:
        """After a save: what is in the vault is no longer undoable here."""
        self.journal.clear()
        self.undo_steps.clear()
        self.redo_steps.clear()
