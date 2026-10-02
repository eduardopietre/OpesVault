"""Technical log: error codes and code locations only (RNF-02, docs/03 §6, phase 10).

What is written: time, app version, a code, the exception *type*, an opaque incident id
and the chain of OpesVault functions with line numbers. What is never written: exception
messages, arguments, local variables, file paths of user documents or vaults, names,
values or document text. Exception messages are excluded because domain errors are
written for the user and may quote what they typed.
"""

import contextlib
import json
import os
import sys
import threading
import traceback
from collections.abc import Callable
from datetime import UTC, datetime
from pathlib import Path
from types import TracebackType
from uuid import uuid4

MAX_BYTES = 256 * 1024
_lock = threading.Lock()


def log_dir() -> Path:
    override = os.environ.get("OPV_LOG_DIR")
    if override:
        return Path(override)
    if sys.platform == "win32":
        base = Path(os.environ.get("LOCALAPPDATA") or Path.home() / "AppData" / "Local")
        return base / "OpesVault" / "logs"
    base = Path(os.environ.get("XDG_STATE_HOME") or Path.home() / ".local" / "state")
    return base / "opesvault" / "logs"


def log_path() -> Path:
    return log_dir() / "opesvault.log"


def code_locations(tb: TracebackType | None, limit: int = 12) -> list[str]:
    """'package.module.function:line' for frames inside OpesVault; library frames are dropped."""
    locations = []
    for frame in traceback.extract_tb(tb):
        parts = Path(frame.filename).parts
        if "opesvault" not in parts:
            continue
        module = ".".join(parts[len(parts) - 1 - parts[::-1].index("opesvault") :]).removesuffix(".py")
        locations.append(f"{module}.{frame.name}:{frame.lineno}")
    return locations[-limit:]


def record(code: str, exc: BaseException | None = None) -> str:
    """Appends one line and returns the incident id shown to the user. Never raises."""
    incident = uuid4().hex[:12]
    entry: dict[str, object] = {
        "at": datetime.now(UTC).isoformat(timespec="seconds"),
        "version": _version(),
        "code": code,
        "incident": incident,
    }
    if exc is not None:
        entry["type"] = type(exc).__name__
        entry["where"] = code_locations(exc.__traceback__)
    try:
        with _lock:
            path = log_path()
            path.parent.mkdir(parents=True, exist_ok=True)
            if path.exists() and path.stat().st_size > MAX_BYTES:
                os.replace(path, path.with_suffix(".log.1"))
            with path.open("a", encoding="utf-8") as handle:
                handle.write(json.dumps(entry, ensure_ascii=True) + "\n")
    except OSError:
        pass  # a full or read-only disk must not turn an error into a crash
    return incident


def _version() -> str:
    from opesvault import __version__

    return __version__


def install(on_unhandled: Callable[[str], None] | None = None) -> None:
    """Routes uncaught exceptions (main thread, Qt slots, other threads) to `record`.

    The default hooks print a traceback with messages to stderr; these replace them so
    nothing descriptive reaches a console that might be captured.
    """

    def hook(exc_type: type[BaseException], exc: BaseException, tb: TracebackType | None) -> None:
        if issubclass(exc_type, KeyboardInterrupt):
            return
        exc.__traceback__ = tb
        incident = record("UNHANDLED", exc)
        if on_unhandled is not None:
            # The reporter itself must never loop back into the hook.
            with contextlib.suppress(Exception):
                on_unhandled(incident)

    def thread_hook(args: threading.ExceptHookArgs) -> None:
        if args.exc_value is not None:
            args.exc_value.__traceback__ = args.exc_traceback
            record("UNHANDLED_THREAD", args.exc_value)

    sys.excepthook = hook
    threading.excepthook = thread_hook
