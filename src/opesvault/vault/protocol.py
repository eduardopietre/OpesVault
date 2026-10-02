"""Messages exchanged with the transient vault worker. Passwords never appear here."""

from pathlib import Path
from typing import Annotated, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field

from opesvault.vault.errors import ErrorCode
from opesvault.vault.model import DocumentMeta, RevisionInfo, SnapshotDelta, SnapshotManifest


class OpenRequest(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")

    op: Literal["open"] = "open"
    path: Path


class SaveRequest(BaseModel):
    """Document bytes travel as message blobs, in `manifest.documents` order."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    op: Literal["save"] = "save"
    path: Path
    base_revision_id: UUID | None
    manifest: SnapshotManifest


class SaveDeltaRequest(BaseModel):
    """Incremental save; added documents travel as blobs in `delta.documents_added` order."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    op: Literal["save_delta"] = "save_delta"
    path: Path
    base_revision_id: UUID
    delta: SnapshotDelta


class ChangePasswordRequest(BaseModel):
    """Re-encrypts the saved revision with a new password; both are typed in the worker."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    op: Literal["change_password"] = "change_password"
    path: Path
    base_revision_id: UUID


class UnlockRequest(BaseModel):
    """Proves the person at the screen knows the password of the open revision (visual lock)."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    op: Literal["unlock"] = "unlock"
    path: Path
    base_revision_id: UUID


AnyRequest = OpenRequest | SaveRequest | SaveDeltaRequest | ChangePasswordRequest | UnlockRequest


class WorkerRequest(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")

    request: Annotated[AnyRequest, Field(discriminator="op")]


class WorkerResponse(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")

    error: ErrorCode | None = None
    revision: RevisionInfo | None = None
    manifest: SnapshotManifest | None = None
    # Open responses: document metadata, then blobs = documents + one blob of record lines.
    documents: tuple[DocumentMeta, ...] | None = None
