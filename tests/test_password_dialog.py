from collections.abc import Callable

import pytest
from PySide6.QtCore import QTimer
from PySide6.QtWidgets import QApplication

from opesvault.ui import password_dialog
from opesvault.ui.password_dialog import DialogPasswordProvider, _PasswordDialog
from opesvault.vault.errors import ErrorCode


def _drive(actions: list[Callable[[_PasswordDialog], None]]) -> None:
    """Runs one action on each dialog as soon as it is shown."""
    queue = list(actions)

    def poke() -> None:
        dialog = QApplication.activeModalWidget()
        if isinstance(dialog, _PasswordDialog) and queue:
            queue.pop(0)(dialog)
        if queue:
            QTimer.singleShot(10, poke)

    QTimer.singleShot(10, poke)


def _answer(password: str, confirm: str | None = None) -> Callable[[_PasswordDialog], None]:
    def act(dialog: _PasswordDialog) -> None:
        dialog.password.setText(password)
        if dialog.confirm is not None:
            dialog.confirm.setText(password if confirm is None else confirm)
        dialog.accept()

    return act


@pytest.fixture
def provider() -> DialogPasswordProvider:
    return DialogPasswordProvider()


def test_returns_typed_password(provider: DialogPasswordProvider) -> None:
    _drive([_answer("segredo")])
    assert provider.ask("open", None) == "segredo"


def test_cancel_returns_none(provider: DialogPasswordProvider) -> None:
    _drive([lambda d: d.reject()])
    assert provider.ask("save", None) is None


def test_create_requires_matching_confirmation(provider: DialogPasswordProvider) -> None:
    _drive([_answer("um", confirm="dois"), _answer("certa")])
    assert provider.ask("create", None) == "certa"


def test_empty_password_is_asked_again(provider: DialogPasswordProvider) -> None:
    _drive([_answer(""), _answer("x")])
    assert provider.ask("open", None) == "x"


def test_previous_error_is_shown() -> None:
    dialog = _PasswordDialog("open", ErrorCode.WRONG_PASSWORD)
    texts = [w.text() for w in dialog.findChildren(password_dialog.QLabel)]
    assert "Senha incorreta. Tente novamente." in texts
