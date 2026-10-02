"""Backups of saved revisions, restore helpers and leftover candidates (docs/03 §4, §7).

A backup is a byte copy of the encrypted vault file: it never needs the password
and never contains unsaved work. Names carry revision and time; nothing is ever
overwritten, and pruning only touches this app's backup names.
"""

import os
import re
import shutil
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

from opesvault.vault.atomic import fsync_file
from opesvault.vault.errors import ErrorCode, VaultError
from opesvault.vault.sqlcipher_store import CANDIDATE_INFIX, PLAIN_SQLITE_HEADER

_BACKUP_RE = re.compile(r"^(?P<stem>.+)\.rev(?P<rev>\d{5,})\.(?P<when>\d{8}-\d{6})\.opesvault$")


@dataclass(frozen=True)
class BackupFile:
    path: Path
    stem: str
    revision: int
    created: datetime


def backup_name(vault: Path, revision: int, when: datetime) -> str:
    return f"{vault.stem}.rev{revision:05d}.{when:%Y%m%d-%H%M%S}.opesvault"


def parse_backup(path: Path) -> BackupFile | None:
    match = _BACKUP_RE.match(path.name)
    if not match:
        return None
    return BackupFile(path, match["stem"], int(match["rev"]), datetime.strptime(match["when"], "%Y%m%d-%H%M%S"))


def create_backup(vault: Path, revision: int, dest_dir: Path, when: datetime | None = None) -> Path:
    """Copy the saved revision; retried if the vault is replaced during the copy."""
    if not vault.is_file():
        raise VaultError(ErrorCode.NOT_FOUND)
    dest_dir.mkdir(parents=True, exist_ok=True)
    target = dest_dir / backup_name(vault, revision, when or datetime.now())
    if target.exists():
        raise VaultError(ErrorCode.ALREADY_EXISTS)
    for _ in range(3):
        before = vault.stat()
        partial = target.with_name(target.name + ".parcial")
        shutil.copyfile(vault, partial)
        after = vault.stat()
        if (before.st_mtime_ns, before.st_size) == (after.st_mtime_ns, after.st_size):
            with partial.open("rb") as fh:
                if fh.read(len(PLAIN_SQLITE_HEADER)) == PLAIN_SQLITE_HEADER:
                    partial.unlink()
                    raise VaultError(ErrorCode.VERIFY_FAILED)
            if partial.stat().st_size != after.st_size:
                partial.unlink()
                continue
            fsync_file(partial)
            os.replace(partial, target)
            return target
        partial.unlink()
    raise VaultError(ErrorCode.IO_ERROR)


def list_backups(dest_dir: Path, stem: str | None = None) -> list[BackupFile]:
    if not dest_dir.is_dir():
        return []
    found = [b for p in dest_dir.iterdir() if (b := parse_backup(p)) is not None]
    if stem is not None:
        found = [b for b in found if b.stem == stem]
    return sorted(found, key=lambda b: (b.created, b.revision))


def prune_backups(dest_dir: Path, stem: str, keep: int, pinned: set[str]) -> list[Path]:
    """Delete the oldest unpinned backups beyond `keep`. The newest is never deleted."""
    if keep < 1:
        raise VaultError(ErrorCode.PROTOCOL_ERROR)
    backups = list_backups(dest_dir, stem)
    removable = [b for b in backups[:-1] if b.path.name not in pinned]
    excess = len([b for b in backups if b.path.name not in pinned]) - keep
    deleted = []
    for backup in removable[: max(excess, 0)]:
        backup.path.unlink()
        deleted.append(backup.path)
    return deleted


def stale_candidates(vault: Path) -> list[Path]:
    """Candidates left by an interrupted save. They are encrypted and never the valid vault."""
    prefix = vault.name + CANDIDATE_INFIX
    return sorted(p for p in vault.parent.iterdir() if p.name.startswith(prefix) and p != vault)


def remove_candidates(vault: Path, paths: list[Path]) -> int:
    prefix = vault.name + CANDIDATE_INFIX
    removed = 0
    for path in paths:
        if path.parent == vault.parent and path.name.startswith(prefix) and path != vault:
            path.unlink(missing_ok=True)
            removed += 1
    return removed


def copy_for_restore(backup: Path, destination: Path) -> Path:
    """Restore goes to a separate destination by default and never overwrites (docs/03 §7)."""
    if destination.exists():
        raise VaultError(ErrorCode.ALREADY_EXISTS)
    partial = destination.with_name(destination.name + ".parcial")
    shutil.copyfile(backup, partial)
    fsync_file(partial)
    os.replace(partial, destination)
    return destination
