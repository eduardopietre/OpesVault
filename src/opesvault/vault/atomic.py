"""Durable, atomic replacement of the vault file by a verified candidate."""

import os
import sys
import time
from pathlib import Path

# Antivirus and indexers on Windows briefly open new files; a replace that
# hits their handle fails with a sharing violation and succeeds moments later.
_REPLACE_ATTEMPTS = 6
_REPLACE_BACKOFF_S = 0.25


def fsync_file(path: Path) -> None:
    fd = os.open(path, os.O_RDWR | getattr(os, "O_BINARY", 0))
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def _fsync_dir(path: Path) -> None:
    if sys.platform == "win32":
        return  # Directories cannot be fsynced on Windows; MOVEFILE_WRITE_THROUGH covers the rename.
    fd = os.open(path, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def _replace_windows(src: Path, dst: Path) -> None:
    assert sys.platform == "win32"
    import ctypes
    from ctypes import wintypes

    movefile_replace_existing = 0x1
    movefile_write_through = 0x8
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    move = kernel32.MoveFileExW
    move.argtypes = (wintypes.LPCWSTR, wintypes.LPCWSTR, wintypes.DWORD)
    move.restype = wintypes.BOOL
    # os.replace() does not pass MOVEFILE_WRITE_THROUGH, so the rename could be
    # reported done before it reaches the disk.
    if not move(str(src), str(dst), movefile_replace_existing | movefile_write_through):
        raise ctypes.WinError(ctypes.get_last_error())


def replace_durably(candidate: Path, target: Path) -> None:
    """Atomically move `candidate` over `target`; the old target stays valid on failure."""
    fsync_file(candidate)
    last_error: OSError | None = None
    for attempt in range(_REPLACE_ATTEMPTS):
        try:
            if sys.platform == "win32":
                _replace_windows(candidate, target)
            else:
                os.replace(candidate, target)
            break
        except PermissionError as exc:
            last_error = exc
            time.sleep(_REPLACE_BACKOFF_S * (attempt + 1))
        except OSError as exc:
            # winerror 32/33: sharing/lock violation from another process.
            if getattr(exc, "winerror", None) in (32, 33):
                last_error = exc
                time.sleep(_REPLACE_BACKOFF_S * (attempt + 1))
            else:
                raise
    else:
        assert last_error is not None
        raise last_error
    _fsync_dir(target.parent)
