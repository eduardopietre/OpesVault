/** Shared pieces of the end-to-end tests. */
import { expect, type Page } from "@playwright/test";

export const SIZES = [
  { width: 1920, height: 1080 },
  { width: 1280, height: 800 },
  { width: 900, height: 640 },
  { width: 768, height: 1024 },
  { width: 390, height: 844 },
] as const;

export const SCHEMES = ["light", "dark"] as const;

export const DEMO = {
  email: "demo@opesvault.app",
  password: "senha-de-demonstracao",
  projectPassword: "senha-do-projeto",
} as const;

/** Collects console errors, uncaught exceptions and CSP violations of a page. */
export function watchErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error" || message.type() === "warning") {
      const text = message.text();
      // The PWA worker is blocked on purpose in most tests.
      if (/service ?worker/i.test(text) && message.type() === "warning") return;
      errors.push(`${message.type()}: ${text}`);
    }
  });
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  return errors;
}

/** Opens a path with the demonstration project already open. */
export async function openDemo(page: Page, path: string): Promise<void> {
  await page.goto(`${path}?demo`);
  await expect(page.locator("h1").first()).toBeVisible();
}

/** The page never scrolls sideways. */
export async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => {
    const root = document.documentElement;
    const wide = [...document.querySelectorAll<HTMLElement>("body *")]
      .filter((element) => {
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.right > root.clientWidth + 1 && getComputedStyle(element).position !== "fixed";
      })
      .slice(0, 5)
      .map((element) => `${element.tagName.toLowerCase()}.${element.className.toString().slice(0, 60)}`);
    return { scroll: root.scrollWidth - root.clientWidth, wide };
  });
  expect(overflow.scroll, `horizontal overflow; widest elements: ${overflow.wide.join(" | ")}`).toBeLessThanOrEqual(0);
}

/** Lets entry animations and lazy charts settle. */
export async function settle(page: Page, ms = 400): Promise<void> {
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(ms);
}

/**
 * Records every address the app pushes or replaces from now on (also after a reload). A destination that reads
 * its link (`ref`, `act`) clears it from the address at once, so a test cannot read the link from `page.url()`.
 * Call it before `openDemo`; the function it returns lists the addresses of the current document.
 */
export async function recordAddresses(page: Page): Promise<() => Promise<string[]>> {
  await page.addInitScript(() => {
    const store = window as unknown as { __addresses: string[] };
    store.__addresses = [];
    for (const method of ["pushState", "replaceState"] as const) {
      const original = history[method].bind(history);
      history[method] = (data: unknown, unused: string, url?: string | URL | null) => {
        store.__addresses.push(String(url ?? ""));
        original(data, unused, url);
      };
    }
  });
  return () => page.evaluate(() => (window as unknown as { __addresses: string[] }).__addresses.slice());
}
