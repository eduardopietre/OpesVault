"""Visual lock on inactivity (docs/03 §4): hides the content, does not purge it.

The data stays in RAM while locked; this protects against someone looking at the screen,
not against someone with access to the running process. Unlocking a saved vault asks
for the password in the transient worker, so the UI still never receives it.
"""

import time

from PySide6.QtCore import QEvent, QObject, QSettings, Qt, QTimer, Signal
from PySide6.QtWidgets import QHBoxLayout, QLabel, QPushButton, QVBoxLayout, QWidget

DEFAULT_MINUTES = 10
SETTINGS_KEY = "ui/lock_minutes"
INPUT_EVENTS = frozenset(
    {
        QEvent.Type.KeyPress,
        QEvent.Type.MouseButtonPress,
        QEvent.Type.MouseMove,
        QEvent.Type.Wheel,
        QEvent.Type.TouchBegin,
    }
)


def lock_minutes() -> int:
    """Per computer, outside the vault (like the recent files list). 0 disables."""
    value = QSettings("OpesVault", "OpesVault").value(SETTINGS_KEY, DEFAULT_MINUTES)
    try:
        return max(0, min(240, int(value)))  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return DEFAULT_MINUTES


def set_lock_minutes(minutes: int) -> None:
    QSettings("OpesVault", "OpesVault").setValue(SETTINGS_KEY, max(0, min(240, minutes)))


class IdleWatcher(QObject):
    """Application-wide event filter; emits `idle` once per idle period."""

    idle = Signal()

    def __init__(self, parent: QObject, minutes: int, clock: object = time.monotonic) -> None:
        super().__init__(parent)
        self.minutes = minutes
        self._clock = clock
        self.last_input = self._now()
        self._fired = False
        self.timer = QTimer(self)
        self.timer.setInterval(10_000)
        self.timer.timeout.connect(self.check)
        self.timer.start()

    def _now(self) -> float:
        return self._clock()  # type: ignore[operator, no-any-return]

    def eventFilter(self, watched: QObject, event: QEvent) -> bool:  # noqa: N802 - Qt override
        if event.type() in INPUT_EVENTS:
            self.last_input = self._now()
            self._fired = False
        return False

    def check(self) -> None:
        if self.minutes <= 0 or self._fired:
            return
        if self._now() - self.last_input >= self.minutes * 60:
            self._fired = True
            self.idle.emit()


class LockPanel(QWidget):
    unlock_requested = Signal()

    def __init__(self) -> None:
        super().__init__()
        self.setObjectName("Content")
        title = QLabel("Conteúdo oculto")
        title.setProperty("textStyle", "title")
        self.detail = QLabel()
        self.detail.setWordWrap(True)
        self.detail.setProperty("textStyle", "secondary")
        self.detail.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self.detail.setMaximumWidth(460)
        self.button = QPushButton("Desbloquear…")
        self.button.setProperty("role", "primary")
        self.button.setDefault(True)
        self.button.clicked.connect(self.unlock_requested)
        layout = QVBoxLayout(self)
        layout.setSpacing(12)
        layout.addStretch()
        layout.addWidget(title, alignment=Qt.AlignmentFlag.AlignHCenter)
        centered = QHBoxLayout()  # no alignment flag: keeps height-for-width wrapping
        centered.addStretch(1)
        centered.addWidget(self.detail, 100)
        centered.addStretch(1)
        layout.addLayout(centered)
        layout.addWidget(self.button, alignment=Qt.AlignmentFlag.AlignHCenter)
        layout.addStretch()

    def describe(self, *, needs_password: bool, unsaved: bool) -> None:
        lines = ["O OpesVault ocultou os dados por inatividade ou a pedido."]
        lines.append(
            "Para mostrar de novo, digite a senha do cofre."
            if needs_password
            else "Este cofre ainda não foi salvo, então não há senha a conferir."
        )
        if unsaved:
            lines.append("Há alterações não salvas; elas continuam na memória.")
        self.detail.setText("\n".join(lines))
