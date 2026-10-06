/**
 * Preferences of this device (docs/16 §4 rule 8), injected by the app: the design system never touches
 * browser storage itself. Values are small strings (a collapsed section, the theme), never project data.
 */
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";

export interface PreferenceStore {
  get(key: string): string | null;
  set(key: string, value: string | null): void;
  /** The keys kept on this device (to say what it stores). */
  keys?(): readonly string[];
  /** Forgets every value (the "forget this device" command). */
  clear?(): void;
}

/** A store that forgets everything (tests, catalog, and when storage is unavailable). */
export function memoryPreferences(initial: Record<string, string> = {}): PreferenceStore {
  const values = new Map(Object.entries(initial));
  return {
    get: (key) => values.get(key) ?? null,
    set: (key, value) => {
      if (value === null) values.delete(key);
      else values.set(key, value);
    },
    keys: () => [...values.keys()],
    clear: () => values.clear(),
  };
}

const PreferenceContext = createContext<PreferenceStore>(memoryPreferences());

export function PreferencesProvider({ store, children }: { store: PreferenceStore; children: ReactNode }) {
  return <PreferenceContext.Provider value={store}>{children}</PreferenceContext.Provider>;
}

export function usePreferences(): PreferenceStore {
  return useContext(PreferenceContext);
}

/** A boolean preference; without a key it is plain component state. */
export function useStoredFlag(key: string | undefined, fallback: boolean): [boolean, (value: boolean) => void] {
  const store = usePreferences();
  const [value, setValue] = useState(() => {
    const stored = key ? store.get(key) : null;
    return stored === null ? fallback : stored === "1";
  });
  const update = useCallback(
    (next: boolean) => {
      setValue(next);
      if (key) store.set(key, next ? "1" : "0");
    },
    [key, store],
  );
  return [value, update];
}

export type ThemeChoice = "system" | "light" | "dark";

/** Applies the theme choice to the html element: no attribute follows the system. */
export function applyTheme(choice: ThemeChoice, root: HTMLElement = document.documentElement): void {
  if (choice === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", choice);
}

/** The theme in effect ("light" or "dark"), following the system and explicit choices live. */
export function useResolvedTheme(): "light" | "dark" {
  const read = () => {
    if (typeof document === "undefined") return "light";
    const explicit = document.documentElement.getAttribute("data-theme");
    if (explicit === "dark" || explicit === "light") return explicit;
    return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  };
  const [theme, setTheme] = useState<"light" | "dark">(read);
  useEffect(() => {
    const update = () => setTheme(read());
    const observer = new MutationObserver(update);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    const media = window.matchMedia?.("(prefers-color-scheme: dark)");
    media?.addEventListener("change", update);
    return () => {
      observer.disconnect();
      media?.removeEventListener("change", update);
    };
  }, []);
  return theme;
}
