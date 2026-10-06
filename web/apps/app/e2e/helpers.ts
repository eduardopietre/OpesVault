/** Shared pieces of the end-to-end tests. */
import AxeBuilder from "@axe-core/playwright";
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

/**
 * Waits until every running animation (Web Animations: motion, CSS transitions) has finished, so an
 * accessibility audit never measures the contrast of text halfway through a fade.
 */
export async function animationsDone(page: Page): Promise<void> {
  await page.evaluate(async () => {
    for (let round = 0; round < 5; round++) {
      const running = document
        .getAnimations()
        .filter((a) => a.playState === "running" && a.effect?.getTiming().iterations !== Infinity);
      if (!running.length) return;
      await Promise.race([
        Promise.all(running.map((a) => a.finished.catch(() => undefined))),
        new Promise((r) => setTimeout(r, 2000)),
      ]);
    }
  });
}

/** An accessibility audit of the resting state of the page (WCAG 2.x A and AA, plus 2.2 AA). */
export async function audit(page: Page, label: string) {
  await page.mouse.move(1, 1); // a hovered button is another color: audit the resting state
  await settle(page, 250);
  await animationsDone(page);
  const result = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    // a notice fading in or out has the contrast of its half-transparent text for a moment
    .exclude("[data-tone]")
    .analyze();
  expect(
    result.violations.map(
      (violation) =>
        `${label}: ${violation.id} (${violation.impact}) ${violation.nodes
          .map((node) => `${node.target.join(" ")} ${node.failureSummary ?? ""}`)
          .slice(0, 3)
          .join(", ")}`,
    ),
  ).toEqual([]);
}

/**
 * A table by its name. The same data is a card list ("listbox") when the room it has is narrow, which depends on
 * the container and not on the window, so both are accepted.
 */
export const tableOf = (page: Page, name: string, _phone = false) =>
  page.getByRole("grid", { name, exact: true }).or(page.getByRole("listbox", { name, exact: true }));

/** Goes to a destination with the keyboard sequence `g` + letter. */
export async function goTo(page: Page, letter: string, path: RegExp): Promise<void> {
  await page.keyboard.press("g");
  await page.keyboard.press(letter);
  await expect(page).toHaveURL(path);
}
