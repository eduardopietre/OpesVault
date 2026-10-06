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

/**
 * Waits until nothing on the page is still moving or fading, so an accessibility audit never measures the
 * contrast of text halfway through a fade. Two sources: Web Animations (CSS transitions and motion's own) are
 * awaited through `document.getAnimations()`; but motion drives its springs from script, which that list does not
 * show, so the page must also hold still: no element that is partly transparent (a fade in or out, a toast
 * coming or going) may change its opacity, nor a moving panel its position, over a dozen consecutive frames.
 * Elements that are meant to be partly transparent (a disabled button) hold still, so they do not wait.
 */
export async function animationsDone(page: Page): Promise<void> {
  await page.evaluate(async () => {
    for (let round = 0; round < 5; round++) {
      const running = document
        .getAnimations()
        .filter((a) => a.playState === "running" && a.effect?.getTiming().iterations !== Infinity);
      if (!running.length) break;
      await Promise.race([
        Promise.all(running.map((a) => a.finished.catch(() => undefined))),
        new Promise((r) => setTimeout(r, 2000)),
      ]);
    }
    const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    const picture = () => {
      const parts: string[] = [];
      for (const element of document.querySelectorAll<HTMLElement>("body *")) {
        const style = getComputedStyle(element);
        const opacity = Number(style.opacity);
        const moving = style.transform !== "none" && element.closest("[data-state], dialog, [role='status']") !== null;
        // Motion writes its fade as an inline opacity: an element still at 0 and waiting for its (staggered) turn
        // counts too, or the picture is "still" a moment before it starts to fade in.
        const inline = Number(element.style.opacity);
        const waiting = element.style.opacity !== "" && inline < 1 && getComputedStyle(element).visibility !== "hidden";
        if ((opacity > 0 && opacity < 1) || moving || waiting) {
          const rect = element.getBoundingClientRect();
          parts.push(`${opacity.toFixed(3)}|${style.transform}|${Math.round(rect.left)},${Math.round(rect.top)}`);
        }
      }
      return parts.join(";");
    };
    const deadline = performance.now() + 4000;
    let before = picture();
    let still = 0;
    while (still < 12 && performance.now() < deadline) {
      await frame();
      const now = picture();
      still = now === before ? still + 1 : 0;
      before = now;
    }
  });
}
