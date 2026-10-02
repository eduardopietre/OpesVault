"""In-memory editing session of one open vault (docs/03 §5)."""

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any
from uuid import UUID, uuid4

from opesvault.vault.model import Document, Record, RevisionInfo, Snapshot


@dataclass(frozen=True)
class FrozenSnapshot:
    """A snapshot handed to a save, tagged with the edit it reflects."""

    snapshot: Snapshot
    edit_seq: int
    base_revision_id: UUID | None


@dataclass
class Session:
    path: Path
    vault_id: UUID
    revision: RevisionInfo | None = None
    records: list[Record] = field(default_factory=list)
    documents: list[Document] = field(default_factory=list)
    _edit_seq: int = 0
    _saved_seq: int = 0

    @classmethod
    def new(cls, path: Path) -> "Session":
        session = cls(path=path, vault_id=uuid4())
        session._edit_seq = 1  # A never-saved vault starts dirty.
        return session

    @classmethod
    def from_snapshot(cls, path: Path, revision: RevisionInfo, snapshot: Snapshot) -> "Session":
        return cls(
            path=path,
            vault_id=snapshot.manifest.vault_id,
            revision=revision,
            records=list(snapshot.manifest.records),
            documents=list(snapshot.documents),
        )

    @property
    def dirty(self) -> bool:
        return self._edit_seq != self._saved_seq

    def add_record(self, kind: str, payload: dict[str, Any]) -> Record:
        record = Record(id=uuid4(), kind=kind, payload=payload)
        self.records.append(record)
        self._edit_seq += 1
        return record

    def add_document(self, original_name: str, data: bytes) -> Document:
        document = Document.from_bytes(original_name, data)
        self.documents.append(document)
        self._edit_seq += 1
        return document

    def freeze(self) -> FrozenSnapshot:
        snapshot = Snapshot.build(self.vault_id, tuple(self.records), tuple(self.documents))
        base = self.revision.revision_id if self.revision is not None else None
        return FrozenSnapshot(snapshot=snapshot, edit_seq=self._edit_seq, base_revision_id=base)

    def mark_saved(self, frozen: FrozenSnapshot, revision: RevisionInfo) -> None:
        """Edits made after `freeze()` stay unsaved (docs/03 §5)."""
        self.revision = revision
        self._saved_seq = frozen.edit_seq
