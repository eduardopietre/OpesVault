"""Work that must not run on the UI thread (network, model calls), with progress back on it."""

from collections.abc import Callable
from typing import Any

import shiboken6
from PySide6.QtCore import QObject, QRunnable, QThreadPool, Signal, SignalInstance


def while_alive(signal: SignalInstance, owner: QObject, slot: Callable[..., Any]) -> None:
    """Connects `signal` to `slot` only for as long as `owner` exists.

    A worker's answer can arrive after the page that asked was destroyed (the window closed,
    the app exiting); a plain lambda would then touch deleted widgets.
    """

    def deliver(*args: Any) -> None:
        if shiboken6.isValid(owner):
            slot(*args)

    signal.connect(deliver)


class _Signals(QObject):
    done = Signal(object)
    progress = Signal(int, int)


class BackgroundJob(QRunnable):
    """Runs `fn(report)` in the thread pool. `done` delivers the result, or the exception, on the UI thread.

    `report(done, total)` may be called from the worker; it arrives as `progress` on the UI thread.
    Keep a reference to the job until `done` fires.
    """

    def __init__(self, fn: Callable[[Callable[[int, int], None]], object]) -> None:
        super().__init__()
        self.fn = fn
        self.signals = _Signals()

    def run(self) -> None:
        try:
            result = self.fn(self.signals.progress.emit)
        except Exception as exc:  # delivered to the caller, which decides what the user sees
            from opesvault.diagnostics import record

            record("BACKGROUND_FAILED", exc)
            result = exc
        self.signals.done.emit(result)

    def start(self) -> None:
        QThreadPool.globalInstance().start(self)
