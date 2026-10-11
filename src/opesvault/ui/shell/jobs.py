"""Vault work off the UI thread: the worker process and parsing never block the window (RNF-05)."""

from collections.abc import Callable
from typing import Any

from PySide6.QtCore import QObject, QRunnable, Signal

from opesvault.vault.errors import ErrorCode, VaultError


class _Signals(QObject):
    done = Signal(object)
    failed = Signal(object)


class VaultJob(QRunnable):
    """Runs `fn` in the thread pool; emits its result, or an ErrorCode (never the exception text)."""

    def __init__(self, fn: Callable[[], Any]) -> None:
        super().__init__()
        self.fn = fn
        self.signals = _Signals()

    def run(self) -> None:
        try:
            result = self.fn()
        except VaultError as exc:
            self.signals.failed.emit(exc.code)
        except Exception as exc:
            from opesvault.diagnostics import record

            record("JOB_FAILED", exc)
            self.signals.failed.emit(ErrorCode.INTERNAL)
        else:
            self.signals.done.emit(result)
