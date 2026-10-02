"""Transient vault process (docs/03 §3).

Started once per open/save. It asks for the password itself, performs a single
SQLCipher operation, answers over its stdout pipe and exits, so neither the
password nor the derived key ever reaches the UI process.
"""

import os
import sys
from typing import IO, Literal, Protocol

from opesvault.vault import sqlcipher_store
from opesvault.vault.errors import ErrorCode, VaultError
from opesvault.vault.framing import read_message, write_message
from opesvault.vault.model import Snapshot
from opesvault.vault.protocol import (
    ChangePasswordRequest,
    OpenRequest,
    SaveDeltaRequest,
    SaveRequest,
    WorkerRequest,
    WorkerResponse,
)

Purpose = Literal["open", "save", "create", "change_current", "change_new"]
MAX_PASSWORD_ATTEMPTS = 3


class PasswordProvider(Protocol):
    def ask(self, purpose: Purpose, previous_error: ErrorCode | None) -> str | None:
        """Return the password, or None if the user cancelled."""
        ...


def _purpose(req: OpenRequest | SaveRequest | SaveDeltaRequest) -> Purpose:  # change requests use their own prompts
    if isinstance(req, OpenRequest):
        return "open"
    return "create" if req.base_revision_id is None else "save"


def _change_password(req: ChangePasswordRequest, provider: PasswordProvider) -> WorkerResponse:
    previous: ErrorCode | None = None
    for _ in range(MAX_PASSWORD_ATTEMPTS):
        current = provider.ask("change_current", previous)
        if current is None:
            return WorkerResponse(error=ErrorCode.CANCELLED)
        try:
            info, snapshot = sqlcipher_store.load(req.path, current)
        except VaultError as exc:
            del current
            if exc.code is not ErrorCode.WRONG_PASSWORD:
                return WorkerResponse(error=exc.code)
            previous = exc.code
            continue
        if info.revision_id != req.base_revision_id:
            return WorkerResponse(error=ErrorCode.REVISION_MISMATCH)
        new = provider.ask("change_new", None)
        if new is None:
            return WorkerResponse(error=ErrorCode.CANCELLED)
        try:
            saved = sqlcipher_store.save(req.path, current, snapshot, info.revision_id, new_password=new)
        except VaultError as exc:
            return WorkerResponse(error=exc.code)
        finally:
            del current, new
        return WorkerResponse(revision=saved)
    return WorkerResponse(error=ErrorCode.WRONG_PASSWORD)


def handle(
    req: OpenRequest | SaveRequest | SaveDeltaRequest | ChangePasswordRequest,
    blobs: tuple[bytes, ...],
    provider: PasswordProvider,
    fault_hook: sqlcipher_store.FaultHook | None = None,
) -> tuple[WorkerResponse, tuple[bytes, ...]]:
    if isinstance(req, ChangePasswordRequest):
        return _change_password(req, provider), ()
    snapshot: Snapshot | None = None
    if isinstance(req, SaveRequest):
        snapshot = Snapshot(manifest=req.manifest, blobs=blobs)
        if not snapshot.check_consistency():
            return WorkerResponse(error=ErrorCode.PROTOCOL_ERROR), ()

    previous: ErrorCode | None = None
    for _ in range(MAX_PASSWORD_ATTEMPTS):
        password = provider.ask(_purpose(req), previous)
        if password is None:
            return WorkerResponse(error=ErrorCode.CANCELLED), ()
        try:
            if isinstance(req, OpenRequest):
                opened = sqlcipher_store.load_raw(req.path, password)
                return (
                    WorkerResponse(revision=opened.revision, documents=tuple(d.meta for d in opened.documents)),
                    (*(d.data for d in opened.documents), opened.records_blob),
                )
            if isinstance(req, SaveDeltaRequest):
                info = sqlcipher_store.save_delta(
                    req.path, password, req.delta, blobs, req.base_revision_id, fault_hook
                )
                return WorkerResponse(revision=info), ()
            assert snapshot is not None
            info = sqlcipher_store.save(req.path, password, snapshot, req.base_revision_id, fault_hook)
            return WorkerResponse(revision=info), ()
        except VaultError as exc:
            if exc.code is not ErrorCode.WRONG_PASSWORD:
                return WorkerResponse(error=exc.code), ()
            previous = exc.code
        finally:
            # Best effort only: Python strings are immutable and cannot be wiped (docs/03 §2).
            del password
    return WorkerResponse(error=ErrorCode.WRONG_PASSWORD), ()


def serve(
    stdin: IO[bytes],
    stdout: IO[bytes],
    provider: PasswordProvider,
    fault_hook: sqlcipher_store.FaultHook | None = None,
) -> int:
    try:
        envelope, blobs = read_message(stdin, WorkerRequest)
    except VaultError as exc:
        write_message(stdout, WorkerResponse(error=exc.code))
        return 1
    try:
        response, out_blobs = handle(envelope.request, blobs, provider, fault_hook)
    except OSError:
        response, out_blobs = WorkerResponse(error=ErrorCode.IO_ERROR), ()
    except Exception:
        # No traceback: it could carry paths or values into some console or log.
        response, out_blobs = WorkerResponse(error=ErrorCode.INTERNAL), ()
    write_message(stdout, response, out_blobs)
    return 0 if response.error is None else 1


def take_protocol_streams() -> tuple[IO[bytes], IO[bytes]]:
    """Detach stdin/stdout for the protocol and point fds 0-2 at the null device.

    Qt, plugins or C libraries printing to stdout would otherwise corrupt the
    framing, and anything they print to stderr must not reach a console.
    """
    proto_in = os.fdopen(os.dup(0), "rb")
    proto_out = os.fdopen(os.dup(1), "wb")
    devnull = os.open(os.devnull, os.O_RDWR)
    for fd in (0, 1, 2):
        os.dup2(devnull, fd)
    os.close(devnull)
    sys.stdout = sys.stderr = open(os.devnull, "w")  # noqa: SIM115 - lives as long as the process
    return proto_in, proto_out


class _LazyDialogProvider:
    """Defers loading Qt until a password is actually needed."""

    def __init__(self) -> None:
        self._inner: PasswordProvider | None = None

    def ask(self, purpose: Purpose, previous_error: ErrorCode | None) -> str | None:
        if self._inner is None:
            from opesvault.ui.password_dialog import DialogPasswordProvider

            self._inner = DialogPasswordProvider()
        return self._inner.ask(purpose, previous_error)


def worker_main() -> int:
    proto_in, proto_out = take_protocol_streams()
    with proto_in, proto_out:
        return serve(proto_in, proto_out, _LazyDialogProvider())
