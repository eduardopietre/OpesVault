"""Messages exchanged with the transient vault worker. Passwords never appear here."""

from pathlib import Path
from typing import Annotated, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field

from opesvault.vault.errors import ErrorCode
from opesvault.vault.model import RevisionInfo, SnapshotManifest


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


class WorkerRequest(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")

    request: Annotated[OpenRequest | SaveRequest, Field(discriminator="op")]


class WorkerResponse(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")

    error: ErrorCode | None = None
    revision: RevisionInfo | None = None
    manifest: SnapshotManifest | None = None
