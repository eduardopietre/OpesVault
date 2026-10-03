"""In-memory editing session of one open vault (docs/03 §5)."""

from dataclasses import dataclass, field
from pathlib import Path
from typing import TYPE_CHECKING
from uuid import UUID, uuid4

from opesvault.domain.ledger import Ledger
from opesvault.vault.model import Document, OpenedVault, Record, RevisionInfo, Snapshot, SnapshotDelta

if TYPE_CHECKING:
    from opesvault.undo import UndoStack


@dataclass(frozen=True)
class FrozenSnapshot:
    """What a save will write, tagged with the edit it reflects.

    Either a full snapshot (new or migrated vault) or only the changes since the saved
    revision (`delta` + the bytes of added documents).
    """

    path: Path
    edit_seq: int
    ledger_seq: int
    base_revision_id: UUID | None
    snapshot: Snapshot | None = None
    delta: SnapshotDelta | None = None
    delta_blobs: tuple[bytes, ...] = ()
    documents_added: frozenset[UUID] = frozenset()
    documents_removed: frozenset[UUID] = frozenset()


@dataclass
class Session:
    path: Path
    vault_id: UUID
    ledger: Ledger
    revision: RevisionInfo | None = None
    documents: list[Document] = field(default_factory=list)
    _doc_changes: int = 0
    _saved_seq: int = 0
    _docs_added: set[UUID] = field(default_factory=set)
    _docs_removed: set[UUID] = field(default_factory=set)
    force_full_save: bool = False

    @classmethod
    def new(cls, path: Path, family_name: str = "Projeto") -> "Session":
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

    @classmethod
    def from_opened(cls, path: Path, opened: OpenedVault) -> "Session":
        return cls(
            path=path,
            vault_id=opened.revision.vault_id,
            ledger=Ledger.from_raw(opened.record_lines()),
            revision=opened.revision,
            documents=list(opened.documents),
        )

    @property
    def _edit_seq(self) -> int:
        return self.ledger.change_count + self._doc_changes

    @property
    def dirty(self) -> bool:
        return self._edit_seq != self._saved_seq

    def undo_stack(self) -> "UndoStack":
        """Created on first use; journaling starts then, so loading never fills it."""
        stack = self.__dict__.get("_undo")
        if stack is None:
            from opesvault.undo import UndoStack

            stack = UndoStack(self)
            self.__dict__["_undo"] = stack
        return stack

    def add_document(self, original_name: str, data: bytes) -> Document:
        document = Document.from_bytes(original_name, data)
        self._insert_document(document)
        self.ledger._journal_add(("external", lambda forward, d=document: self._redo_add(d, forward)))
        return document

    def remove_document(self, document_id: UUID) -> None:
        document = next((d for d in self.documents if d.meta.id == document_id), None)
        self._drop_document(document_id)
        if document is not None:
            self.ledger._journal_add(("external", lambda forward, d=document: self._redo_add(d, not forward)))

    def _insert_document(self, document: Document) -> None:
        self.documents.append(document)
        if document.meta.id in self._docs_removed:
            self._docs_removed.discard(document.meta.id)  # removed and put back before a save
        else:
            self._docs_added.add(document.meta.id)
        self._doc_changes += 1

    def _drop_document(self, document_id: UUID) -> None:
        self.documents = [d for d in self.documents if d.meta.id != document_id]
        if document_id in self._docs_added:
            self._docs_added.discard(document_id)
        else:
            self._docs_removed.add(document_id)
        self._doc_changes += 1

    def _redo_add(self, document: Document, present: bool) -> None:
        """Undo/redo of a document: present=True puts it back, False takes it out."""
        if present:
            self._insert_document(document)
        else:
            self._drop_document(document.meta.id)

    def document(self, document_id: UUID) -> Document:
        for doc in self.documents:
            if doc.meta.id == document_id:
                return doc
        raise KeyError(document_id)

    def find_document_by_hash(self, sha256: str) -> Document | None:
        return next((d for d in self.documents if d.meta.sha256 == sha256), None)

    def full_snapshot(self) -> Snapshot:
        records = tuple(Record(id=rid, kind=kind, payload=payload) for rid, kind, payload in self.ledger.to_records())
        return Snapshot.build(self.vault_id, records, tuple(self.documents))

    def freeze(self) -> FrozenSnapshot:
        base = self.revision.revision_id if self.revision is not None else None
        common = {
            "path": self.path,
            "edit_seq": self._edit_seq,
            "ledger_seq": self.ledger.change_count,
            "base_revision_id": base,
            "documents_added": frozenset(self._docs_added),
            "documents_removed": frozenset(self._docs_removed),
        }
        if base is None or self.ledger.migrated_from is not None or self.force_full_save:
            return FrozenSnapshot(snapshot=self.full_snapshot(), **common)
        upserts: list[Record] = []
        deletes: list[UUID] = []
        for kind, key in self.ledger.dirty:
            payload = self.ledger.record_for(kind, key)
            if payload is None:
                deletes.append(key)
            else:
                upserts.append(Record(id=key, kind=kind, payload=payload))
        added = [d for d in self.documents if d.meta.id in self._docs_added]
        delta = SnapshotDelta(
            vault_id=self.vault_id,
            upserts=tuple(upserts),
            deletes=tuple(deletes),
            documents_added=tuple(d.meta for d in added),
            documents_removed=tuple(self._docs_removed),
            record_count=sum(self.ledger.row_counts().values()),
            document_count=len(self.documents),
        )
        return FrozenSnapshot(delta=delta, delta_blobs=tuple(d.data for d in added), **common)

    def mark_saved(self, frozen: FrozenSnapshot, revision: RevisionInfo) -> None:
        """Edits made after `freeze()` stay unsaved (docs/03 §5)."""
        self.revision = revision
        self._saved_seq = frozen.edit_seq
        self.ledger.mark_clean(frozen.ledger_seq)
        self._docs_added -= frozen.documents_added
        self._docs_removed -= frozen.documents_removed
        if frozen.snapshot is not None:
            self.ledger.migrated_from = None
            self.force_full_save = False
