"""Decisions: the question as title, the consequence as text and buttons that say what they do."""

from collections.abc import Sequence

from PySide6.QtWidgets import (
    QDialog,
    QDialogButtonBox,
    QVBoxLayout,
    QWidget,
)

from opesvault.ui.components.basics import text
from opesvault.ui.theme import SPACE_L, SPACE_S, SPACE_XL

Choice = tuple[str, str, str]


class Decision(QDialog):
    """A question as the title, the consequence below, and buttons named by what they do.

    No icon: the title already says it is a decision. Replaces QMessageBox.question, whose
    Yes/No buttons and generic title make the user read the body to know what is asked.
    """

    def __init__(self, parent: QWidget | None, title: str, message: str, choices: Sequence[Choice]) -> None:
        super().__init__(parent)
        self.setWindowTitle("OpesVault")
        self.choice: str | None = None
        heading = text(title, "headline", wrap=True)
        heading.setAccessibleName(title)
        body = text(message, "secondary", wrap=True)
        body.setVisible(bool(message))
        buttons = QDialogButtonBox()
        roles = {
            "accept": QDialogButtonBox.ButtonRole.AcceptRole,
            "destructive": QDialogButtonBox.ButtonRole.DestructiveRole,
            "reject": QDialogButtonBox.ButtonRole.RejectRole,
        }
        for key, label, role in choices:
            widget = buttons.addButton(label, roles[role])
            if widget is None:
                continue
            widget.setAutoDefault(False)
            if role == "accept":
                widget.setProperty("role", "primary")
                widget.setDefault(True)
            widget.clicked.connect(lambda _=False, k=key: self._choose(k))
        buttons.rejected.connect(self.reject)
        layout = QVBoxLayout(self)
        layout.setContentsMargins(SPACE_XL, SPACE_XL, SPACE_XL, SPACE_L)
        layout.setSpacing(SPACE_S)
        layout.addWidget(heading)
        layout.addWidget(body)
        layout.addSpacing(SPACE_L)
        layout.addWidget(buttons)
        self.setMinimumWidth(420)
        self.setMaximumWidth(560)

    def _choose(self, key: str) -> None:
        self.choice = key
        self.accept()


def decide(parent: QWidget | None, title: str, message: str, choices: Sequence[Choice]) -> str | None:
    """Shows a `Decision` and returns the chosen key, or None when cancelled (Esc, close)."""
    dialog = Decision(parent, title, message, choices)
    dialog.exec()
    choice = dialog.choice
    dialog.deleteLater()
    return choice


def confirm(parent: QWidget | None, title: str, message: str, action: str) -> bool:
    """A yes/cancel decision whose confirm button is the action itself ("Exportar", "Vincular")."""
    return decide(parent, title, message, [("ok", action, "accept"), ("cancel", "Cancelar", "reject")]) == "ok"
