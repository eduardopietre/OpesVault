/** Per-project settings (no secrets). Stored as a single entity. Port of `domain/settings.py`. */
import { z } from "zod";

import { uuid5 } from "../lib/ids.ts";
import { zId } from "../lib/schema.ts";
import { Ledger } from "./ledger.ts";

export const SETTINGS_ID = uuid5("6f1c3d2a-1b7e-4b8e-9f00-0c0ffee0a001", "settings");

export const VaultSettingsSchema = z.strictObject({
  id: zId.default(SETTINGS_ID),
  ai_enabled: z.boolean().default(false),
  ai_model: z.string().max(120).nullable().default(null),
  backup_keep: z.number().int().min(1).max(500).default(10),
  backup_dir: z.string().nullable().default(null),
  save_reminder_minutes: z.number().int().min(0).max(600).default(30),
  auto_backup: z.boolean().default(false), // copy each saved revision to backup_dir
  pinned_backups: z.array(z.string()).readonly().default([]),
});
export type VaultSettings = Readonly<z.output<typeof VaultSettingsSchema>>;

Ledger.registerKind("settings", VaultSettingsSchema);

export function getSettings(ledger: Ledger): VaultSettings {
  return ledger.entities<VaultSettings>("settings").get(SETTINGS_ID) ?? VaultSettingsSchema.parse({});
}

/** Validates the changed settings (Python: `model_validate` of the copy) and stores the copy. */
export function updateSettings(ledger: Ledger, changes: Partial<VaultSettings>): VaultSettings {
  const updated: VaultSettings = { ...getSettings(ledger), ...changes };
  VaultSettingsSchema.parse(JSON.parse(JSON.stringify(updated)));
  const existing = ledger.entities("settings").has(SETTINGS_ID);
  return ledger.put("settings", updated, { reason: existing ? "configurações" : null });
}
