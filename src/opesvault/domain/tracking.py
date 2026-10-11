"""Collections that report every change to their ledger: what makes saves incremental, caches
invalidate and unsaved edits undoable (docs/03, opesvault.undo).

A write to a tracked collection touches the ledger (`Ledger._touch`, `dirty`, `change_count`)
and is journaled with its previous value; values loaded while opening a vault are not changes.
"""

from collections.abc import Iterator
from typing import TYPE_CHECKING, Any
from uuid import UUID

from opesvault.domain.model import HistoryEntry

if TYPE_CHECKING:
    from opesvault.domain.ledger import Ledger


class _Missing:
    """Marks 'no value' in the change journal (None is a valid stored value)."""

    def __repr__(self) -> str:
        return "MISSING"


MISSING: Any = _Missing()


class TrackedDict(dict):  # type: ignore[type-arg]
    """Entity collection that reports every change, so saves can be incremental and
    caches can be invalidated even when a module writes to the collection directly."""

    def __init__(self, ledger: "Ledger", kind: str) -> None:
        super().__init__()
        self._ledger = ledger
        self._kind = kind

    def __setitem__(self, key: UUID, value: Any) -> None:
        before = dict.get(self, key, MISSING)
        super().__setitem__(key, value)
        self._ledger._touch(self._kind, key)
        self._ledger._journal_add(("entity", self._kind, key, before, value))

    def __delitem__(self, key: UUID) -> None:
        before = dict.get(self, key, MISSING)
        super().__delitem__(key)
        self._ledger._touch(self._kind, key)
        self._ledger._journal_add(("entity", self._kind, key, before, MISSING))

    def pop(self, key: UUID, *default: Any) -> Any:  # type: ignore[override]
        before = dict.get(self, key, MISSING)
        value = super().pop(key, *default)
        self._ledger._touch(self._kind, key)
        if before is not MISSING:
            self._ledger._journal_add(("entity", self._kind, key, before, MISSING))
        return value

    def load(self, key: UUID, value: Any) -> None:
        """Insert while opening a vault: not a change."""
        super().__setitem__(key, value)


class TrackedList(list):  # type: ignore[type-arg]
    """History list. Entries loaded from a vault may stay as raw JSON until first read:
    a session that never looks at old history never pays for parsing it."""

    def __init__(self, ledger: "Ledger") -> None:
        super().__init__()
        self._ledger = ledger
        self._raw: list[str] = []

    def load_raw(self, payloads: list[str]) -> None:
        self._raw = payloads

    def _ensure(self) -> None:
        if self._raw:
            raw, self._raw = self._raw, []
            parsed = [HistoryEntry.model_validate_json(p) for p in raw]
            current = list(list.__iter__(self))
            list.clear(self)
            list.extend(self, parsed + current)

    def append(self, entry: Any) -> None:
        super().append(entry)
        self._ledger._touch("history", entry.id)
        self._ledger._journal_add(("history", entry))

    def discard(self, entry: Any) -> None:
        """Removes an entry appended in this session (undo of an unsaved change)."""
        list.remove(self, entry)
        self._ledger._touch("history", entry.id)

    def recent(self) -> Iterator[Any]:
        """Entries appended in this session, newest first, without parsing old ones."""
        return reversed(list(list.__iter__(self))) if self._raw else reversed(self)

    def __len__(self) -> int:
        return list.__len__(self) + len(self._raw)

    def __iter__(self) -> Iterator[Any]:
        self._ensure()
        return list.__iter__(self)

    def __reversed__(self) -> Iterator[Any]:
        self._ensure()
        return list.__reversed__(self)

    def __getitem__(self, index: Any) -> Any:
        self._ensure()
        return list.__getitem__(self, index)

    def sort(self, *args: Any, **kwargs: Any) -> None:
        self._ensure()
        list.sort(self, *args, **kwargs)
