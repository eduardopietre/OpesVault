"""UI-side access to the vault: every operation spawns a transient worker.

Blocking calls: run them off the Qt UI thread.
"""

import subprocess
import sys
from pathlib import Path
from typing import TYPE_CHECKING
from uuid import UUID

from opesvault.vault.errors import ErrorCode, VaultError
from opesvault.vault.framing import read_message, write_message
from opesvault.vault.model import Document, OpenedVault, RevisionInfo, Snapshot, SnapshotDelta
from opesvault.vault.protocol import (
    AnyRequest,
    ChangePasswordRequest,
    OpenRequest,
    SaveDeltaRequest,
    SaveRequest,
    UnlockRequest,
    WorkerRequest,
    WorkerResponse,
)

if TYPE_CHECKING:
    from opesvault.session import FrozenSnapshot

WORKER_FLAG = "--vault-worker"
_EXIT_TIMEOUT_S = 30


def is_compiled() -> bool:
    import opesvault

    return hasattr(opesvault, "__compiled__")


def default_worker_command() -> list[str]:
    if is_compiled():
        # Nuitka standalone: the executable itself is the entry point.
        return [sys.argv[0], WORKER_FLAG]
    return [sys.executable, "-m", "opesvault", WORKER_FLAG]


def _allow_child_foreground() -> None:
    """Let the worker's password dialog take focus instead of flashing in the taskbar."""
    if sys.platform == "win32":
        import ctypes

        asfw_any = -1
        ctypes.windll.user32.AllowSetForegroundWindow(asfw_any)


class VaultClient:
    def __init__(self, worker_command: list[str] | None = None) -> None:
        self._command = worker_command or default_worker_command()

    def _call(self, request: AnyRequest, blobs: tuple[bytes, ...]) -> tuple[WorkerResponse, tuple[bytes, ...]]:
        _allow_child_foreground()
        proc = subprocess.Popen(
            self._command,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            close_fds=True,
        )
        assert proc.stdin is not None and proc.stdout is not None
        try:
            try:
                write_message(proc.stdin, WorkerRequest(request=request), blobs)
                proc.stdin.close()
            except (BrokenPipeError, OSError):
                pass  # The worker died early; its exit is reported below.
            try:
                response, out_blobs = read_message(proc.stdout, WorkerResponse)
            except VaultError:
                # No answer from a save: it may have stopped mid-replace.
                code = ErrorCode.INTERNAL if isinstance(request, OpenRequest) else ErrorCode.UNCERTAIN
                response, out_blobs = WorkerResponse(error=code), ()
        finally:
            proc.stdout.close()
            try:
                proc.wait(timeout=_EXIT_TIMEOUT_S)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait()
        return response, out_blobs

    def open_raw(self, path: Path) -> OpenedVault:
        response, blobs = self._call(OpenRequest(path=path), ())
        if response.error is not None:
            raise VaultError(response.error)
        if response.revision is None or response.documents is None or len(blobs) != len(response.documents) + 1:
            raise VaultError(ErrorCode.PROTOCOL_ERROR)
        documents = tuple(Document(meta=m, data=b) for m, b in zip(response.documents, blobs[:-1], strict=True))
        # The worker verified each document's hash against the vault; here the framing is checked.
        if any(len(d.data) != d.meta.size for d in documents):
            raise VaultError(ErrorCode.PROTOCOL_ERROR)
        return OpenedVault(revision=response.revision, records_blob=blobs[-1], documents=documents)

    def open(self, path: Path) -> tuple[RevisionInfo, Snapshot]:
        """Typed snapshot (slower); the UI uses `open_raw`."""
        opened = self.open_raw(path)
        return opened.revision, opened.to_snapshot()

    def save(self, path: Path, snapshot: Snapshot, base_revision_id: UUID | None) -> RevisionInfo:
        request = SaveRequest(path=path, base_revision_id=base_revision_id, manifest=snapshot.manifest)
        response, _ = self._call(request, snapshot.blobs)
        if response.error is not None:
            raise VaultError(response.error)
        if response.revision is None:
            raise VaultError(ErrorCode.UNCERTAIN)
        return response.revision

    def change_password(self, path: Path, base_revision_id: UUID) -> RevisionInfo:
        response, _ = self._call(ChangePasswordRequest(path=path, base_revision_id=base_revision_id), ())
        if response.error is not None:
            raise VaultError(response.error)
        if response.revision is None:
            raise VaultError(ErrorCode.UNCERTAIN)
        return response.revision

    def unlock(self, path: Path, base_revision_id: UUID) -> None:
        """Raises VaultError unless the password typed in the worker opens this revision."""
        response, _ = self._call(UnlockRequest(path=path, base_revision_id=base_revision_id), ())
        if response.error is not None:
            raise VaultError(response.error)
        if response.revision is None or response.revision.revision_id != base_revision_id:
            raise VaultError(ErrorCode.PROTOCOL_ERROR)

    def save_delta(
        self, path: Path, delta: SnapshotDelta, blobs: tuple[bytes, ...], base_revision_id: UUID
    ) -> RevisionInfo:
        request = SaveDeltaRequest(path=path, base_revision_id=base_revision_id, delta=delta)
        response, _ = self._call(request, blobs)
        if response.error is not None:
            raise VaultError(response.error)
        if response.revision is None:
            raise VaultError(ErrorCode.UNCERTAIN)
        return response.revision

    def save_frozen(self, frozen: "FrozenSnapshot") -> RevisionInfo:
        """Saves what a session froze: a full snapshot or only its changes."""
        if frozen.delta is not None:
            assert frozen.base_revision_id is not None
            return self.save_delta(frozen.path, frozen.delta, frozen.delta_blobs, frozen.base_revision_id)
        assert frozen.snapshot is not None
        return self.save(frozen.path, frozen.snapshot, frozen.base_revision_id)
