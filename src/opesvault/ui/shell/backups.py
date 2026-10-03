"""Backups: copy after each save, back up now, verify a backup and restore one as a new vault."""

from datetime import date
from pathlib import Path
from typing import Any

from PySide6.QtWidgets import QFileDialog, QMessageBox

from opesvault.domain.ledger import DomainError
from opesvault.session import Session
from opesvault.ui.shell.contract import WindowParts
from opesvault.ui.shell.vault import VAULT_FILTER
from opesvault.vault.errors import VaultError


class BackupCommands(WindowParts):
    def _auto_backup(self) -> None:
        """After a save, a copy of that revision in the backup folder, when the vault asks for it."""
        from opesvault.domain.settings import get_settings
        from opesvault.vault.backup import create_backup, prune_backups

        session = self.session
        if session is None or session.revision is None:
            return
        settings = get_settings(session.ledger)
        if not (settings.auto_backup and settings.backup_dir):
            return
        try:
            target = Path(settings.backup_dir)
            create_backup(session.path, session.revision.revision, target)
            prune_backups(target, session.path.stem, settings.backup_keep, set(settings.pinned_backups))
        except (OSError, VaultError):
            self.statusBar().showMessage("Salvo, mas o backup automático falhou. Verifique a pasta de backups.", 30_000)

    def backup_now(self) -> None:
        from opesvault.domain.settings import get_settings
        from opesvault.vault.backup import create_backup, prune_backups

        session = self.session
        if session is None or session.revision is None or self.busy:
            return
        if session.dirty:
            QMessageBox.information(
                self, "Backup", "O backup copia a última revisão salva. Salve antes para incluir as alterações."
            )
        settings = get_settings(session.ledger)
        folder = settings.backup_dir or QFileDialog.getExistingDirectory(self, "Pasta de backups")
        if not folder:
            return
        try:
            target = create_backup(session.path, session.revision.revision, Path(folder))
            prune_backups(Path(folder), session.path.stem, settings.backup_keep, set(settings.pinned_backups))
        except (OSError, VaultError):
            QMessageBox.warning(self, "Backup", "Não foi possível criar o backup.")
            return
        QMessageBox.information(self, "Backup", f"Backup da revisão {session.revision.revision} criado:\n{target}")

    def restore_backup(self) -> None:
        """Restoring never overwrites: the backup becomes a new vault file the user names."""
        if self.busy or not self._confirm_discard("restaurar o backup", self.restore_backup):
            return
        name, _ = QFileDialog.getOpenFileName(self, "Backup a restaurar", "", VAULT_FILTER)
        if not name:
            return
        backup = Path(name)

        def loaded(result: Any) -> None:
            from opesvault.vault.backup import copy_for_restore

            if isinstance(result, DomainError):
                QMessageBox.warning(self, "Restaurar", str(result))
                return
            restored: Session = result
            assert restored.revision is not None
            revision = restored.revision
            QMessageBox.information(
                self,
                "Restaurar",
                f"Backup válido: revisão {revision.revision}, salva em {revision.saved_at:%d/%m/%Y %H:%M} (UTC).\n"
                "Escolha onde criar o cofre restaurado (um arquivo novo; nada é sobrescrito).",
            )
            suggested = str(backup.with_name(backup.stem.split(".rev")[0] + "-restaurado.opesvault"))
            dest, _ = QFileDialog.getSaveFileName(self, "Cofre restaurado", suggested, VAULT_FILTER)
            if not dest:
                return
            destination = Path(dest).with_suffix(".opesvault")
            try:
                copy_for_restore(backup, destination)
            except VaultError as exc:
                self._show_error(exc.code)
                return
            self._drop_session()
            if self._take_lock(destination):
                restored.path = destination
                self.session = restored
                self._after_open(destination)

        self._run(self._read_vault(backup), loaded)

    def verify_backup(self) -> None:
        """Opens a backup in the worker (its password typed there) and reports what it holds.

        A backup that was never opened is not a guarantee (docs/03): this proves the file decrypts,
        every page authenticates and the data reads as a ledger, without touching the open vault.
        """
        if self.busy:
            return
        from opesvault.domain.settings import get_settings

        folder = ""
        if self.session is not None:
            folder = get_settings(self.session.ledger).backup_dir or ""
        name, _ = QFileDialog.getOpenFileName(self, "Backup a verificar", folder, VAULT_FILTER)
        if not name:
            return
        current = self.session

        def loaded(result: Any) -> None:
            if isinstance(result, DomainError):
                QMessageBox.warning(self, "Verificar backup", str(result))
                return
            QMessageBox.information(self, "Verificar backup", backup_report(result, current))

        self._run(self._read_vault(Path(name)), loaded)

    def backup_alerts(self) -> list[Any]:
        """'Último backup há N dias', from the backup folder (the domain never reads the disk)."""
        from opesvault.domain.alerts import backup_alert
        from opesvault.domain.settings import get_settings
        from opesvault.vault.backup import list_backups

        session = self.session
        if session is None or session.revision is None:
            return []  # a vault never saved has nothing to back up yet
        settings = get_settings(session.ledger)
        if not settings.backup_dir:
            return backup_alert(None, date.today(), configured=False)
        try:
            found = list_backups(Path(settings.backup_dir), session.path.stem)
        except OSError:
            found = []
        newest = max((b.created.date() for b in found), default=None)
        return backup_alert(newest, date.today(), configured=True)


def backup_report(restored: Session, current: Session | None) -> str:
    """What a verified backup holds, compared with the open vault when it is the same family."""
    from opesvault.domain.model import OperationStatus

    revision = restored.revision
    ledger = restored.ledger
    operations = sum(1 for op in ledger.operations.values() if op.status is OperationStatus.ACTIVE)
    lines = [
        "Backup íntegro: abriu com a senha, todas as páginas foram autenticadas e os dados foram lidos.",
        "",
    ]
    if revision is not None:
        lines.append(f"Revisão {revision.revision}, salva em {revision.saved_at:%d/%m/%Y %H:%M} (UTC).")
    lines.append(
        f"{operations} lançamento(s) ativo(s), {len(ledger.accounts)} conta(s) e categoria(s), "
        f"{len(restored.documents)} documento(s)."
    )
    if current is not None and current.vault_id == restored.vault_id and current.revision is not None:
        behind = current.revision.revision - (revision.revision if revision else 0)
        if behind > 0:
            lines.append(f"É deste cofre, {behind} revisão(ões) atrás da aberta.")
        elif behind == 0:
            lines.append("É deste cofre, na mesma revisão da aberta.")
    elif current is not None:
        lines.append("É de outro cofre (outro arquivo ou outro projeto).")
    lines.append("")
    lines.append("Nada foi alterado: para usar o backup, Cofre › Restaurar backup.")
    return "\n".join(lines)
