"""UI-side access to the vault: every operation spawns a transient worker.

Blocking calls: run them off the Qt UI thread.
"""

import subprocess
import sys
from pathlib import Path
from uuid import UUID

from opesvault.vault.errors import ErrorCode, VaultError
from opesvault.vault.framing import read_message, write_message
from opesvault.vault.model import RevisionInfo, Snapshot
from opesvault.vault.protocol import OpenRequest, SaveRequest, WorkerRequest, WorkerResponse

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

    def _call(
        self, request: OpenRequest | SaveRequest, blobs: tuple[bytes, ...]
    ) -> tuple[WorkerResponse, tuple[bytes, ...]]:
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
                code = ErrorCode.UNCERTAIN if isinstance(request, SaveRequest) else ErrorCode.INTERNAL
                response, out_blobs = WorkerResponse(error=code), ()
        finally:
            proc.stdout.close()
            try:
                proc.wait(timeout=_EXIT_TIMEOUT_S)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait()
        return response, out_blobs

    def open(self, path: Path) -> tuple[RevisionInfo, Snapshot]:
        response, blobs = self._call(OpenRequest(path=path), ())
        if response.error is not None:
            raise VaultError(response.error)
        if response.revision is None or response.manifest is None:
            raise VaultError(ErrorCode.PROTOCOL_ERROR)
        snapshot = Snapshot(manifest=response.manifest, blobs=blobs)
        if not snapshot.check_consistency():
            raise VaultError(ErrorCode.PROTOCOL_ERROR)
        return response.revision, snapshot

    def save(self, path: Path, snapshot: Snapshot, base_revision_id: UUID | None) -> RevisionInfo:
        request = SaveRequest(path=path, base_revision_id=base_revision_id, manifest=snapshot.manifest)
        response, _ = self._call(request, snapshot.blobs)
        if response.error is not None:
            raise VaultError(response.error)
        if response.revision is None:
            raise VaultError(ErrorCode.UNCERTAIN)
        return response.revision
