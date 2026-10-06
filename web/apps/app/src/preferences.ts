/**
 * Preferences of this device (docs/16 §4 rule 8): theme, sidebar, collapsed sections. The only module that
 * touches localStorage (a lint rule enforces it); nothing of the project goes there. Storage may be missing
 * (private windows, blocked site data), so every access is guarded and the app works without it.
 */
import { memoryPreferences, type PreferenceStore, type ThemeChoice } from "@opesvault/ui";

const PREFIX = "opesvault:";

export function devicePreferences(): PreferenceStore {
  const fallback = memoryPreferences();
  return {
    keys() {
      const found = new Set(fallback.keys?.() ?? []);
      try {
        for (let i = 0; i < localStorage.length; i++) {
          const key = localStorage.key(i);
          if (key?.startsWith(PREFIX)) found.add(key.slice(PREFIX.length));
        }
      } catch {
        // Storage unavailable: only the in-memory values exist.
      }
      return [...found].sort();
    },
    clear() {
      for (const key of this.keys?.() ?? []) this.set(key, null);
      fallback.clear?.();
      try {
        sessionStorage.removeItem(PREFIX + "aba");
      } catch {
        // Nothing to forget.
      }
    },
    get(key) {
      try {
        return localStorage.getItem(PREFIX + key) ?? fallback.get(key);
      } catch {
        return fallback.get(key);
      }
    },
    set(key, value) {
      fallback.set(key, value);
      try {
        if (value === null) localStorage.removeItem(PREFIX + key);
        else localStorage.setItem(PREFIX + key, value);
      } catch {
        // Storage unavailable: the in-memory value lasts for this tab.
      }
    },
  };
}

/** Minutes without use before the project locks on this device (docs/19 §9.1); a device preference. */
export const IDLE_LOCK_KEY = "seguranca/bloqueio";
export const IDLE_LOCK_CHOICES = [1, 5, 15, 30, 60, 120] as const;
export const IDLE_LOCK_DEFAULT = 15;

export function readIdleLock(store: PreferenceStore): number {
  const value = Number(store.get(IDLE_LOCK_KEY));
  return (IDLE_LOCK_CHOICES as readonly number[]).includes(value) ? value : IDLE_LOCK_DEFAULT;
}

export const THEME_KEY = "aparencia/tema";
export const SIDEBAR_KEY = "barra-lateral/recolhida";

export function readTheme(store: PreferenceStore): ThemeChoice {
  const value = store.get(THEME_KEY);
  return value === "light" || value === "dark" ? value : "system";
}

/**
 * This tab's label for the edit lease, kept for the life of the tab (sessionStorage), so a reload gets
 * its own lease back at once instead of opening read-only until the old one expires (docs/19).
 * It is a random label, not project data.
 */
export function tabHolder(): string {
  const key = PREFIX + "aba";
  try {
    const existing = sessionStorage.getItem(key);
    if (existing) return existing;
    const created = `tab-${crypto.randomUUID()}`;
    sessionStorage.setItem(key, created);
    return created;
  } catch {
    return `tab-${crypto.randomUUID()}`;
  }
}
