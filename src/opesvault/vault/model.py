"""Session snapshot: the unit loaded from and written to a vault.

Phase 0 keeps the domain generic (opaque records + documents) so the vault
mechanics can be validated before the accounting model of docs/04 exists.
"""

import hashlib
import json
from collections.abc import Iterable, Iterator
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any
from uuid import UUID, uuid4

from pydantic import BaseModel, ConfigDict, Field

FORMAT_VERSION = 1


def utc_now() -> datetime:
    return datetime.now(UTC)


class Record(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")

    id: UUID
    kind: str = Field(min_length=1, max_length=64)
    payload: dict[str, Any]


class DocumentMeta(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")

    id: UUID
    sha256: str = Field(pattern=r"^[0-9a-f]{64}$")
    original_name: str = Field(max_length=512)
    size: int = Field(ge=0)


class Document(BaseModel):
    """Document metadata plus its original bytes, kept only in memory."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    meta: DocumentMeta
    data: bytes = Field(repr=False)

    @classmethod
    def from_bytes(cls, original_name: str, data: bytes) -> "Document":
        meta = DocumentMeta(
            id=uuid4(),
            sha256=hashlib.sha256(data).hexdigest(),
            original_name=original_name,
            size=len(data),
        )
        return cls(meta=meta, data=data)

    def verify(self) -> bool:
        return len(self.data) == self.meta.size and hashlib.sha256(self.data).hexdigest() == self.meta.sha256


class RevisionInfo(BaseModel):
    """Identifies one saved version of a vault. Contains no secrets."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    vault_id: UUID
    format_version: int
    revision: int = Field(ge=1)
    revision_id: UUID
    saved_at: datetime


class SnapshotManifest(BaseModel):
    """Everything in a snapshot except document bytes."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    vault_id: UUID
    format_version: int = FORMAT_VERSION
    records: tuple[Record, ...] = ()
    documents: tuple[DocumentMeta, ...] = ()


class Snapshot(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")

    manifest: SnapshotManifest
    blobs: tuple[bytes, ...] = Field(default=(), repr=False)

    @property
    def documents(self) -> tuple[Document, ...]:
        return tuple(Document(meta=m, data=b) for m, b in zip(self.manifest.documents, self.blobs, strict=True))

    @classmethod
    def build(cls, vault_id: UUID, records: tuple[Record, ...], documents: tuple[Document, ...]) -> "Snapshot":
        manifest = SnapshotManifest(vault_id=vault_id, records=records, documents=tuple(d.meta for d in documents))
        return cls(manifest=manifest, blobs=tuple(d.data for d in documents))

    def check_consistency(self) -> bool:
        if len(self.blobs) != len(self.manifest.documents):
            return False
        ids = [d.id for d in self.manifest.documents]
        if len(ids) != len(set(ids)):
            return False
        return all(d.verify() for d in self.documents)


class SnapshotDelta(BaseModel):
    """Changes since the saved revision; applied to a byte copy of the encrypted vault.

    Counts describe the full state after the change, so the result is verified as a
    whole and not only where it changed.
    """

    model_config = ConfigDict(frozen=True, extra="forbid")

    vault_id: UUID
    upserts: tuple[Record, ...] = ()
    deletes: tuple[UUID, ...] = ()
    documents_added: tuple[DocumentMeta, ...] = ()
    documents_removed: tuple[UUID, ...] = ()
    record_count: int = Field(ge=1)
    document_count: int = Field(ge=0)


@dataclass(frozen=True)
class OpenedVault:
    """A vault as delivered to the UI: records stay as JSON lines until the domain parses
    them once, so 100k rows are not validated three times on the way (docs/11 §5)."""

    revision: RevisionInfo
    records_blob: bytes  # "id\tkind\tpayload\n" lines; payload is compact JSON
    documents: tuple[Document, ...]

    def record_lines(self) -> Iterator[tuple[str, str, str]]:
        for line in self.records_blob.decode("utf-8").split("\n"):
            if line:
                rid, kind, payload = line.split("\t", 2)
                yield rid, kind, payload

    def to_snapshot(self) -> Snapshot:
        """Slow path for tools and tests that want typed records."""
        records = tuple(
            Record(id=UUID(rid), kind=kind, payload=json.loads(payload)) for rid, kind, payload in self.record_lines()
        )
        return Snapshot.build(self.revision.vault_id, records, self.documents)


def encode_record_lines(rows: Iterable[tuple[str, str, str]]) -> bytes:
    return "\n".join(f"{rid}\t{kind}\t{payload}" for rid, kind, payload in rows).encode("utf-8")
