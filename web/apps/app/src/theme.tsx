/** The theme choice of this device: system (default), light or dark, applied to the html element. */
import { applyTheme, usePreferences, type ThemeChoice } from "@opesvault/ui";
import { createContext, useCallback, useContext, useLayoutEffect, useMemo, useState, type ReactNode } from "react";
import { readTheme, THEME_KEY } from "./preferences.ts";

interface ThemeContextValue {
  theme: ThemeChoice;
  setTheme: (choice: ThemeChoice) => void;
}

const ThemeContext = createContext<ThemeContextValue>({ theme: "system", setTheme: () => undefined });

export function ThemeProvider({ children }: { children: ReactNode }) {
  const store = usePreferences();
  const [theme, setChoice] = useState<ThemeChoice>(() => readTheme(store));
  useLayoutEffect(() => applyTheme(theme), [theme]);
  const setTheme = useCallback(
    (choice: ThemeChoice) => {
      store.set(THEME_KEY, choice === "system" ? null : choice);
      setChoice(choice);
    },
    [store],
  );
  const value = useMemo(() => ({ theme, setTheme }), [theme, setTheme]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  return useContext(ThemeContext);
}

export const THEME_LABELS: Record<ThemeChoice, string> = { system: "Como o sistema", light: "Claro", dark: "Escuro" };
