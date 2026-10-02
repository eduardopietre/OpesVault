"""In-memory editing session of one open vault (docs/03 §5)."""

from dataclasses import dataclass, field
from pathlib import Path
from uuid import UUID, uuid4

from opesvault.domain.ledger import Ledger
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
    ledger: Ledger
    revision: RevisionInfo | None = None
    documents: list[Document] = field(default_factory=list)
    _doc_changes: int = 0
    _saved_seq: int = 0

    @classmethod
    def new(cls, path: Path, family_name: str = "Família") -> "Session":
        # A never-saved vault starts dirty: creating the chart of accounts counts as edits.
        return cls(path=path, vault_id=uuid4(), ledger=Ledger.new(family_name))

    @classmethod
    def from_snapshot(cls, path: Path, revision: RevisionInfo, snapshot: Snapshot) -> "Session":
        rows = [(r.id, r.kind, r.payload) for r in snapshot.manifest.records]
        return cls(
            path=path,
            vault_id=snapshot.manifest.vault_id,
            ledger=Ledger.from_records(rows),
            revision=revision,
            documents=list(snapshot.documents),
        )

    @property
    def _edit_seq(self) -> int:
        return self.ledger.change_count + self._doc_changes

    @property
    def dirty(self) -> bool:
        return self._edit_seq != self._saved_seq

    def add_document(self, original_name: str, data: bytes) -> Document:
        document = Document.from_bytes(original_name, data)
        self.documents.append(document)
        self._doc_changes += 1
        return document

    def document(self, document_id: UUID) -> Document:
        for doc in self.documents:
            if doc.meta.id == document_id:
                return doc
        raise KeyError(document_id)

    def find_document_by_hash(self, sha256: str) -> Document | None:
        return next((d for d in self.documents if d.meta.sha256 == sha256), None)

    def freeze(self) -> FrozenSnapshot:
        records = tuple(Record(id=rid, kind=kind, payload=payload) for rid, kind, payload in self.ledger.to_records())
        snapshot = Snapshot.build(self.vault_id, records, tuple(self.documents))
        base = self.revision.revision_id if self.revision is not None else None
        return FrozenSnapshot(snapshot=snapshot, edit_seq=self._edit_seq, base_revision_id=base)

    def mark_saved(self, frozen: FrozenSnapshot, revision: RevisionInfo) -> None:
        """Edits made after `freeze()` stay unsaved (docs/03 §5)."""
        self.revision = revision
        self._saved_seq = frozen.edit_seq
