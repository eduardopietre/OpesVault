"""The Cofre menu end to end, through the real vault worker (development password from the environment).

Creating and saving a vault, backing it up by hand and after each save, verifying a backup,
restoring it as a new file, changing the password and exporting, with the file dialogs
answered by the test. The UI never sees a password: the worker reads it (scripts/dev_worker.py).
"""

from collections.abc import Iterator
from pathlib import Path

import pytest
from PySide6.QtCore import QThreadPool
from PySide6.QtWidgets import QApplication, QFileDialog, QInputDialog, QMessageBox

from opesvault.domain.settings import get_settings, update_settings
from opesvault.ui.main_window import MainWindow
from opesvault.vault.backup import list_backups
from opesvault.vault.client import VaultClient

from .conftest import PASSWORD, dev_worker_command


@pytest.fixture(scope="module")
def app() -> QApplication:
    instance = QApplication.instance()
    return instance if isinstance(instance, QApplication) else QApplication([])


class Answers:
    """What the file and text dialogs answer, and what the message boxes said."""

    def __init__(self, monkeypatch: pytest.MonkeyPatch) -> None:
        self.save: list[str] = []
        self.open: list[str] = []
        self.folder: list[str] = []
        self.text: list[tuple[str, bool]] = []
        self.said: list[str] = []
        answers = self
        monkeypatch.setattr(QFileDialog, "getSaveFileName", staticmethod(lambda *a, **k: (answers.save.pop(0), "")))
        monkeypatch.setattr(QFileDialog, "getOpenFileName", staticmethod(lambda *a, **k: (answers.open.pop(0), "")))
        monkeypatch.setattr(QFileDialog, "getExistingDirectory", staticmethod(lambda *a, **k: answers.folder.pop(0)))
        monkeypatch.setattr(QInputDialog, "getText", staticmethod(lambda *a, **k: answers.text.pop(0)))
        for kind in ("information", "warning"):
            monkeypatch.setattr(QMessageBox, kind, staticmethod(lambda *a, **k: answers.said.append(str(a[2]))))
        monkeypatch.setattr("opesvault.ui.shell.vault.confirm", lambda *a, **k: True)
        monkeypatch.setattr("opesvault.ui.setup_wizard.SetupWizard.exec", lambda self: 0)


@pytest.fixture
def answers(monkeypatch: pytest.MonkeyPatch) -> Answers:
    return Answers(monkeypatch)


@pytest.fixture
def window(app: QApplication, dev_worker_env: None) -> Iterator[MainWindow]:
    win = MainWindow()
    win.client = VaultClient(dev_worker_command())
    yield win
    win._drop_session()


def _wait(window: MainWindow) -> None:
    for _ in range(50):
        QThreadPool.globalInstance().waitForDone(10_000)
        QApplication.processEvents()
        if not window.busy:
            return
    raise AssertionError("the vault worker did not finish")


def _new_vault(window: MainWindow, answers: Answers, path: Path) -> None:
    answers.save.append(str(path))
    answers.text.append(("Projeto Teste", True))
    window.new_vault()
    _wait(window)
    assert window.session is not None and window.session.revision is not None, answers.said


def test_a_new_vault_is_created_saved_and_reopened(window: MainWindow, answers: Answers, tmp_path: Path) -> None:
    path = tmp_path / "casa.opesvault"
    _new_vault(window, answers, path)
    assert path.is_file() and window.status.text() == "Salvo · revisão 1"
    assert window.context_label.text() == "Projeto Teste"
    window.close_vault()
    assert window.session is None and window.shell.currentWidget() is window.welcome
    window.open_path(path)
    _wait(window)
    assert window.session is not None and window.session.revision is not None
    assert window.session.ledger.meta.family_name == "Projeto Teste"


def test_backup_by_hand_verify_and_restore_as_a_new_file(window: MainWindow, answers: Answers, tmp_path: Path) -> None:
    path = tmp_path / "casa.opesvault"
    folder = tmp_path / "backups"
    _new_vault(window, answers, path)
    answers.folder.append(str(folder))
    window.backup_now()
    [backup] = list_backups(folder, "casa")
    assert any("Backup da revisão 1 criado" in said for said in answers.said)

    answers.open.append(str(backup.path))
    window.verify_backup()
    _wait(window)
    report = answers.said[-1]
    assert "Backup íntegro" in report and "mesma revisão da aberta" in report

    restored = tmp_path / "restaurado.opesvault"
    answers.open.append(str(backup.path))
    answers.save.append(str(restored))
    window.restore_backup()
    _wait(window)
    assert window.session is not None and window.session.path == restored and restored.is_file()
    assert path.is_file()  # restoring never overwrites the original


def test_each_save_is_copied_when_the_vault_asks_for_it(window: MainWindow, answers: Answers, tmp_path: Path) -> None:
    path = tmp_path / "casa.opesvault"
    folder = tmp_path / "copias"
    _new_vault(window, answers, path)
    assert window.session is not None
    update_settings(window.session.ledger, auto_backup=True, backup_dir=str(folder), backup_keep=2)
    window.on_changed()
    for _ in range(3):
        window.save_vault()
        _wait(window)
        window.session.ledger.add_member(f"Pessoa {len(window.session.ledger.members)}")
        window.on_changed()
    kept = list_backups(folder, "casa")
    assert len(kept) == 2  # the oldest copies are pruned to backup_keep
    assert get_settings(window.session.ledger).auto_backup
    assert window.backup_alerts() == []  # a fresh backup: nothing to warn about


def test_password_change_needs_a_saved_vault(
    window: MainWindow, answers: Answers, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    path = tmp_path / "casa.opesvault"
    _new_vault(window, answers, path)
    assert window.session is not None
    window.session.ledger.add_member("Carla")
    window.on_changed()
    window.change_password()
    assert answers.said[-1] == "Salve as alterações antes de trocar a senha."
    window.save_vault()
    _wait(window)
    monkeypatch.setenv("OPV_DEV_NEW_PASSWORD", PASSWORD + "-nova")
    window.change_password()
    _wait(window)
    assert "Senha trocada" in answers.said[-1]
    monkeypatch.setenv("OPV_DEV_PASSWORD", PASSWORD + "-nova")
    window.close_vault()
    window.open_path(path)
    _wait(window)
    assert window.session is not None  # opens with the new password


def test_exports_write_the_chosen_file(window: MainWindow, answers: Answers, tmp_path: Path) -> None:
    path = tmp_path / "casa.opesvault"
    _new_vault(window, answers, path)
    for kind, name in (("csv", "livro.csv"), ("json", "dados.json")):
        answers.save.append(str(tmp_path / name))
        window.export(kind)
        assert (tmp_path / name).stat().st_size > 0


def test_a_file_that_is_not_a_vault_is_refused(window: MainWindow, answers: Answers, tmp_path: Path) -> None:
    junk = tmp_path / "planilha.opesvault"
    junk.write_bytes(b"isto nao e um cofre" * 100)
    window.open_path(junk)
    _wait(window)
    assert window.session is None and window.lock is None  # nothing opened, the lock released
    # Without the key, junk and a vault with another password look the same: nothing is changed.
    assert answers.said and "não foi alterado" in answers.said[-1]
    assert junk.read_bytes() == b"isto nao e um cofre" * 100
