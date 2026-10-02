"""Password prompt shown by the transient vault worker, never by the main UI."""

from PySide6.QtCore import Qt
from PySide6.QtWidgets import (
    QApplication,
    QDialog,
    QDialogButtonBox,
    QFormLayout,
    QLabel,
    QLineEdit,
    QVBoxLayout,
)

from opesvault.vault.errors import ErrorCode
from opesvault.vault.worker import Purpose

_TITLES: dict[Purpose, str] = {
    "open": "Abrir cofre",
    "save": "Salvar cofre",
    "create": "Criar cofre",
    "change_current": "Trocar senha — senha atual",
    "change_new": "Trocar senha — nova senha",
    "unlock": "Desbloquear",
}

_ERRORS: dict[ErrorCode, str] = {
    ErrorCode.WRONG_PASSWORD: "Senha incorreta. Tente novamente.",
    ErrorCode.PASSWORD_MISMATCH: "As senhas não coincidem.",
}


class _PasswordDialog(QDialog):
    def __init__(self, purpose: Purpose, error: ErrorCode | None) -> None:
        super().__init__()
        self.setWindowTitle(f"OpesVault — {_TITLES[purpose]}")
        self.setWindowFlag(Qt.WindowType.WindowStaysOnTopHint, True)
        layout = QVBoxLayout(self)
        if error is not None and error in _ERRORS:
            message = QLabel(_ERRORS[error])
            message.setStyleSheet("color: #b00020; font-weight: bold;")
            layout.addWidget(message)
        form = QFormLayout()
        self.password = self._password_field()
        form.addRow("Senha:", self.password)
        self.confirm: QLineEdit | None = None
        if purpose in ("create", "change_new"):
            self.confirm = self._password_field()
            form.addRow("Confirmar senha:", self.confirm)
            layout.addWidget(QLabel("Sem a senha, o cofre não pode ser recuperado."))
        layout.addLayout(form)
        buttons = QDialogButtonBox(QDialogButtonBox.StandardButton.Ok | QDialogButtonBox.StandardButton.Cancel)
        buttons.accepted.connect(self.accept)
        buttons.rejected.connect(self.reject)
        layout.addWidget(buttons)

    @staticmethod
    def _password_field() -> QLineEdit:
        field = QLineEdit()
        field.setEchoMode(QLineEdit.EchoMode.Password)
        field.setContextMenuPolicy(Qt.ContextMenuPolicy.NoContextMenu)
        return field


class DialogPasswordProvider:
    def __init__(self) -> None:
        self._app = QApplication.instance() or QApplication([])

    def ask(self, purpose: Purpose, previous_error: ErrorCode | None) -> str | None:
        error = previous_error
        while True:
            dialog = _PasswordDialog(purpose, error)
            dialog.raise_()
            dialog.activateWindow()
            accepted = dialog.exec() == QDialog.DialogCode.Accepted
            password = dialog.password.text()
            confirm = dialog.confirm.text() if dialog.confirm is not None else password
            dialog.password.clear()
            if dialog.confirm is not None:
                dialog.confirm.clear()
            dialog.deleteLater()
            if not accepted:
                return None
            if not password:
                error = ErrorCode.WRONG_PASSWORD
                continue
            if confirm != password:
                error = ErrorCode.PASSWORD_MISMATCH
                continue
            return password
