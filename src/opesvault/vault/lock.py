"""Single-editor lock for a vault (docs/03 §5, ADR-09).

The lock is a sidecar file rather than a handle on the vault itself, because the
vault file is replaced on every save. It holds no financial content.
"""

import os
import sys
from pathlib import Path
from types import TracebackType

from opesvault.vault.errors import ErrorCode, VaultError

LOCK_SUFFIX = ".lock"


def lock_path_for(vault: Path) -> Path:
    return vault.with_name(vault.name + LOCK_SUFFIX)


class VaultLock:
    def __init__(self, vault: Path) -> None:
        self.path = lock_path_for(vault)
        self._fd: int | None = None

    def acquire(self) -> None:
        fd = os.open(self.path, os.O_RDWR | os.O_CREAT | getattr(os, "O_BINARY", 0), 0o600)
        try:
            if sys.platform == "win32":
                import msvcrt

                os.lseek(fd, 0, os.SEEK_SET)
                msvcrt.locking(fd, msvcrt.LK_NBLCK, 1)
            else:
                import fcntl

                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            os.close(fd)
            raise VaultError(ErrorCode.LOCKED) from None
        self._fd = fd

    def release(self) -> None:
        if self._fd is None:
            return
        fd, self._fd = self._fd, None
        try:
            if sys.platform == "win32":
                import msvcrt

                os.lseek(fd, 0, os.SEEK_SET)
                msvcrt.locking(fd, msvcrt.LK_UNLCK, 1)
        finally:
            # The empty file is left behind on purpose: deleting it would race with
            # another instance that already opened it and is about to lock it.
            os.close(fd)

    @property
    def held(self) -> bool:
        return self._fd is not None

    def __enter__(self) -> "VaultLock":
        self.acquire()
        return self

    def __exit__(self, *_exc: type[BaseException] | BaseException | TracebackType | None) -> None:
        self.release()
