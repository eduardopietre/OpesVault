"""Password prompt shown by the transient vault worker, never by the main UI."""

from PySide6.QtCore import Qt
from PySide6.QtWidgets import (
    QApplication,
    QDialog,
    QDialogButtonBox,
    QFormLayout,
    QLineEdit,
    QVBoxLayout,
)

from opesvault.ui.theme import restyle
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


_HEADLINES: dict[Purpose, str] = {
    "open": "Digite a senha do cofre",
    "save": "Digite a senha para salvar",
    "create": "Crie a senha do cofre",
    "change_current": "Digite a senha atual",
    "change_new": "Escolha a nova senha",
    "unlock": "Digite a senha para mostrar o conteúdo",
}
_CONFIRM_LABELS: dict[Purpose, str] = {
    "open": "Abrir",
    "save": "Salvar",
    "create": "Criar cofre",
    "change_current": "Continuar",
    "change_new": "Trocar senha",
    "unlock": "Desbloquear",
}


class _PasswordDialog(QDialog):
    def __init__(self, purpose: Purpose, error: ErrorCode | None) -> None:
        from opesvault.ui.components import text

        super().__init__()
        self.setWindowTitle(f"OpesVault — {_TITLES[purpose]}")
        self.setWindowFlag(Qt.WindowType.WindowStaysOnTopHint, True)
        self.setMinimumWidth(380)
        layout = QVBoxLayout(self)
        layout.setSpacing(10)
        layout.addWidget(text(_HEADLINES[purpose], "headline"))
        self.message = text("", wrap=True)
        self.message.setProperty("tone", "negative")
        self.message.setAccessibleName("Erro")
        layout.addWidget(self.message)
        form = QFormLayout()
        self.password = self._password_field()
        self.password.setAccessibleName("Senha")
        form.addRow("Senha:", self.password)
        self.confirm: QLineEdit | None = None
        creating = purpose in ("create", "change_new")
        if creating:
            self.confirm = self._password_field()
            self.confirm.setAccessibleName("Confirmar senha")
            form.addRow("Confirmar:", self.confirm)
        layout.addLayout(form)
        if creating:
            layout.addWidget(
                text(
                    "Sem a senha, o cofre não pode ser aberto por ninguém, nem recuperado. Guarde-a em lugar seguro.",
                    "caption",
                    wrap=True,
                )
            )
        buttons = QDialogButtonBox(QDialogButtonBox.StandardButton.Ok | QDialogButtonBox.StandardButton.Cancel)
        self.ok = buttons.button(QDialogButtonBox.StandardButton.Ok)
        self.ok.setText(_CONFIRM_LABELS[purpose])
        self.ok.setProperty("role", "primary")
        buttons.button(QDialogButtonBox.StandardButton.Cancel).setText("Cancelar")
        buttons.accepted.connect(self.accept)
        buttons.rejected.connect(self.reject)
        layout.addWidget(buttons)
        self.password.textChanged.connect(self._validate)
        if self.confirm is not None:
            self.confirm.textChanged.connect(self._validate)
        self._show_error(_ERRORS.get(error) if error is not None else None)
        self._validate()

    def _show_error(self, message: str | None) -> None:
        self.message.setText(message or "")
        self.message.setVisible(bool(message))

    def _validate(self) -> None:
        """Live feedback instead of a failed submission: empty or mismatched never gets sent."""
        password = self.password.text()
        ready = bool(password)
        if self.confirm is not None:
            typed = self.confirm.text()
            mismatch = bool(typed) and typed != password
            self.confirm.setProperty("invalid", mismatch)
            restyle(self.confirm)
            if mismatch:
                self._show_error("As senhas não coincidem.")
            elif self.message.text() == "As senhas não coincidem.":
                self._show_error(None)
            ready = ready and typed == password
        self.ok.setEnabled(ready)

    @staticmethod
    def _password_field() -> QLineEdit:
        field = QLineEdit()
        field.setEchoMode(QLineEdit.EchoMode.Password)
        field.setContextMenuPolicy(Qt.ContextMenuPolicy.NoContextMenu)
        return field


class DialogPasswordProvider:
    def __init__(self) -> None:
        existing = QApplication.instance()
        self._app = existing if isinstance(existing, QApplication) else QApplication([])
        if existing is None:  # the worker process: same look as the main window
            from opesvault.ui.theme import apply_theme

            apply_theme(self._app)

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
