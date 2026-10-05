/**
 * Token values that code needs (motion, layout bands, chart colors). Colors live in styles/tokens.css;
 * code reads them at run time with `cssVar`, so light and dark stay in one place.
 */

/** Spacing scale in px (theme.py SPACE_*). */
export const SPACE = { xs: 4, s: 8, m: 12, l: 16, xl: 24, xxl: 32 } as const;

/** The four responsive bands (docs/18 §5.1), by viewport width in px. */
export const BAND = { tablet: 640, medium: 1024, wide: 1440 } as const;
export type Band = "phone" | "tablet" | "medium" | "wide";

export function bandOf(width: number): Band {
  if (width >= BAND.wide) return "wide";
  if (width >= BAND.medium) return "medium";
  if (width >= BAND.tablet) return "tablet";
  return "phone";
}

/** Motion durations in seconds (docs/18 §5.2: 120, 200 and 320 ms). */
export const DURATION = { fast: 0.12, base: 0.2, slow: 0.32 } as const;

/** Cubic-bezier curves, matching --ov-ease-* in tokens.css. */
export const EASE = {
  standard: [0.2, 0, 0, 1],
  enter: [0, 0, 0, 1],
  exit: [0.3, 0, 1, 1],
} as const satisfies Record<string, readonly [number, number, number, number]>;

/** Springs for things that are handled: dialogs, sheets, panels. */
export const SPRING = {
  dialog: { type: "spring", stiffness: 520, damping: 38, mass: 0.9 },
  sheet: { type: "spring", stiffness: 420, damping: 40, mass: 1 },
  panel: { type: "spring", stiffness: 380, damping: 36, mass: 1 },
  indicator: { type: "spring", stiffness: 600, damping: 44, mass: 0.8 },
} as const;

/** The chart series colors, in their fixed order (never cycled; a 7th series folds into "Outros"). */
export const CHART_SERIES_VARS = [
  "--ov-chart-1",
  "--ov-chart-2",
  "--ov-chart-3",
  "--ov-chart-4",
  "--ov-chart-5",
  "--ov-chart-6",
] as const;

/** The current value of a CSS custom property on the root element ("" outside a browser). */
export function cssVar(name: string, element?: Element): string {
  if (typeof document === "undefined") return "";
  return getComputedStyle(element ?? document.documentElement)
    .getPropertyValue(name)
    .trim();
}
