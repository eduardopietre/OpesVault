"""Per-vault settings (no secrets). Stored as a single entity."""

from uuid import UUID, uuid5

from pydantic import BaseModel, ConfigDict, Field

from opesvault.domain.ledger import Ledger

SETTINGS_ID = uuid5(UUID("6f1c3d2a-1b7e-4b8e-9f00-0c0ffee0a001"), "settings")


class VaultSettings(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")

    id: UUID = SETTINGS_ID
    ai_enabled: bool = False
    ai_model: str | None = Field(default=None, max_length=120)
    backup_keep: int = Field(default=10, ge=1, le=500)
    backup_dir: str | None = None
    save_reminder_minutes: int = Field(default=30, ge=0, le=600)


Ledger.register_kind("settings", VaultSettings)


def get_settings(ledger: Ledger) -> VaultSettings:
    current = ledger.entities("settings").get(SETTINGS_ID)
    return current if isinstance(current, VaultSettings) else VaultSettings()


def update_settings(ledger: Ledger, **changes: object) -> VaultSettings:
    updated = get_settings(ledger).model_copy(update=changes)
    VaultSettings.model_validate(updated.model_dump())
    existing = SETTINGS_ID in ledger.entities("settings")
    return ledger.put("settings", updated, reason="configurações" if existing else None)
