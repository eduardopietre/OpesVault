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

/**
 * The name typed at sign-up, by account (the server keeps only the e-mail). Account data, not project data;
 * "Esquecer este aparelho" erases it with the other preferences.
 */
export const accountNameKey = (accountId: string): string => `conta/${accountId}/nome`;

export const THEME_KEY = "aparencia/tema";
export const SIDEBAR_KEY = "barra-lateral/recolhida";

export function readTheme(store: PreferenceStore): ThemeChoice {
  const value = store.get(THEME_KEY);
  return value === "light" || value === "dark" ? value : "system";
}

const HOLDER_KEY = PREFIX + "aba";

/**
 * This tab's label for the edit lease, kept for the life of the tab (sessionStorage), so a reload gets
 * its own lease back at once instead of opening read-only until the old one expires (docs/19).
 * It is a random label, not project data.
 */
export function tabHolder(): string {
  try {
    const existing = sessionStorage.getItem(HOLDER_KEY);
    if (existing) return existing;
    const created = `tab-${crypto.randomUUID()}`;
    sessionStorage.setItem(HOLDER_KEY, created);
    return created;
  } catch {
    return `tab-${crypto.randomUUID()}`;
  }
}

/** How long a tab waits for its label to be freed (a reload: the page before lets it go as it unloads). */
const CLAIM_WAIT_MS = 2000;

/**
 * `tabHolder`, held by this page for as long as it lives (Web Locks). A duplicated tab inherits the same
 * sessionStorage, so it would share the label and the two tabs would hand the edit lease to each other without
 * end (docs/19 §9.2). The page that finds the label still held after the wait takes a new one of its own.
 */
export async function claimTabHolder(
  locks: LockManager | null | undefined = globalThis.navigator?.locks,
  waitMs = CLAIM_WAIT_MS,
): Promise<string> {
  if (!locks) return tabHolder();
  const claim = (label: string, signal?: AbortSignal) =>
    new Promise<boolean>((resolve) => {
      locks
        .request(`opesvault-aba-${label}`, signal ? { signal } : { ifAvailable: true }, (lock) => {
          resolve(lock !== null);
          // Held until the page goes away.
          return lock === null ? undefined : new Promise<never>(() => undefined);
        })
        .catch(() => resolve(false));
    });
  const label = tabHolder();
  if (await claim(label, AbortSignal.timeout(waitMs))) return label;
  for (;;) {
    const created = `tab-${crypto.randomUUID()}`;
    try {
      sessionStorage.setItem(HOLDER_KEY, created);
    } catch {
      // no sessionStorage: the label lives as long as this page
    }
    if (await claim(created)) return created;
  }
}
