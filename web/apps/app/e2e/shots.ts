/** The screenshots for review (docs/18 §5.3): every size, light and dark, written to web/build/telas. */
import { fileURLToPath } from "node:url";
import { test, type Page } from "@playwright/test";
import { SCHEMES, SIZES, settle } from "./helpers.ts";

/** Where the screenshots go. */
export const OUT = fileURLToPath(new URL("../../../build/telas/", import.meta.url));

export interface Size {
  readonly width: number;
  readonly height: number;
}

/** "1280x800-claro": the size and scheme that end a screenshot's name. */
export const shotSuffix = (size: Size, scheme: "light" | "dark"): string =>
  `${size.width}x${size.height}-${scheme === "light" ? "claro" : "escuro"}`;

/**
 * Declares the tests of `body` once per size and scheme, each group named by its suffix (after `prefix`), in that
 * viewport and scheme with reduced motion.
 */
export function forEachScreen(
  body: (screen: { size: Size; scheme: "light" | "dark"; suffix: string }) => void,
  options: { sizes?: readonly Size[]; prefix?: string } = {},
): void {
  for (const size of options.sizes ?? SIZES) {
    for (const scheme of SCHEMES) {
      const suffix = shotSuffix(size, scheme);
      test.describe(options.prefix ? `${options.prefix} ${suffix}` : suffix, () => {
        test.use({ viewport: size, colorScheme: scheme, contextOptions: { reducedMotion: "reduce" } });
        body({ size, scheme, suffix });
      });
    }
  }
}

/** Saves what the window shows (or the whole page) as `<name>.png`. */
export async function screenshot(page: Page, name: string, options: { fullPage?: boolean } = {}): Promise<void> {
  await page.screenshot({ path: `${OUT}${name}.png`, ...options });
}

/**
 * The whole page in one picture: the shell scrolls inside the window, so the window is made tall (at least
 * `minHeight`) for the shot, and then restored.
 */
export async function pageShot(page: Page, size: Size, name: string, minHeight = 1500): Promise<void> {
  await page.setViewportSize({ width: size.width, height: Math.max(size.height, minHeight) });
  await settle(page, 900);
  await screenshot(page, name);
  await page.setViewportSize(size);
  await settle(page, 300);
}
