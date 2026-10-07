/** Shared pieces of the end-to-end tests. */
import AxeBuilder from "@axe-core/playwright";
import { expect, type Page } from "@playwright/test";

export const SCHEMES = ["light", "dark"] as const;

/** The sizes of docs/16 §4 and docs/18 §5.1; screenshots always use all of them. */
export const SIZES = [
  { width: 1920, height: 1080 },
  { width: 1280, height: 800 },
  { width: 900, height: 640 },
  { width: 768, height: 1024 },
  { width: 390, height: 844 },
] as const;

/**
 * The full suite (`pnpm e2e:full`, `E2E_FULL=1`) repeats the tests that loop over sizes and schemes at every size,
 * light and dark; the fast one (`pnpm e2e`) runs them at 1280x800 in light only. Tests of phone-only behaviour set
 * their own size, and `a11y.spec.ts` audits both schemes at 1280 and 390: those run in both suites.
 */
export const FULL = process.env["E2E_FULL"] === "1";

/** The sizes that the tests looping over sizes run at: all of them in the full suite, 1280x800 otherwise. */
export const TEST_SIZES: readonly { readonly width: number; readonly height: number }[] = FULL ? SIZES : [SIZES[1]];

/** The schemes that the tests looping over schemes run in: both in the full suite, light otherwise. */
export const TEST_SCHEMES: readonly ("light" | "dark")[] = FULL ? SCHEMES : ["light"];

export const DEMO = {
  email: "demo@opesvault.app",
  password: "senha-de-demonstracao",
  projectPassword: "senha-do-projeto",
} as const;

/** A one-pixel PNG, for a receipt or note picked as a file. */
export const ONE_PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

/** Replaces `window.print` (from the next page load on) with a counter that `prints` reads. */
export async function stubPrint(page: Page): Promise<void> {
  await page.addInitScript(() => {
    (window as unknown as { __prints: number }).__prints = 0;
    window.print = () => {
      (window as unknown as { __prints: number }).__prints++;
    };
  });
}

/** How many times the page asked to print since it loaded (see `stubPrint`). */
export const prints = (page: Page): Promise<number> =>
  page.evaluate(() => (window as unknown as { __prints: number }).__prints);

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

/**
 * Opens a path with the demonstration project already open. The tests were written around this month's data
 * (the budget's states, the bill due on the 10th, today's recurrence), so they start on the current month;
 * `{ month: "demo" }` keeps the demonstration's own month (its last complete one), as a visitor sees it.
 */
export async function openDemo(page: Page, path: string, { month = "current" }: { month?: "current" | "demo" } = {}) {
  await page.goto(`${path}?demo${month === "current" ? "&mes=atual" : ""}`);
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

export interface AuditOptions {
  /** Moves the pointer to the corner first: a hovered button is another color (default true). */
  restPointer?: boolean;
  /** How long to let entry animations and lazy charts settle before waiting for the animations (default 250 ms). */
  settleMs?: number;
  /**
   * Leaves the notices (`[data-tone]`) out of the audit: one fading in or out has the contrast of its
   * half-transparent text for a moment (default true).
   */
  skipNotices?: boolean;
  /** Waits until the notices have dismissed themselves, so they are measured gone (default false). */
  awaitNotices?: boolean;
}

/** An accessibility audit of the resting state of the page (WCAG 2.x A and AA, plus 2.2 AA). */
export async function audit(page: Page, label: string, options: AuditOptions = {}) {
  const { restPointer = true, settleMs = 250, skipNotices = true, awaitNotices = false } = options;
  if (restPointer) await page.mouse.move(1, 1);
  if (awaitNotices) {
    await expect(page.locator('section[aria-label="Avisos"] [data-tone]')).toHaveCount(0, { timeout: 15_000 });
  }
  await settle(page, settleMs);
  await animationsDone(page);
  let axe = new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]);
  if (skipNotices) axe = axe.exclude("[data-tone]");
  const result = await axe.analyze();
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

/** `audit` with these options, for a spec that audits all its states the same way. */
export const auditWith =
  (options: AuditOptions) =>
  (page: Page, label: string): Promise<void> =>
    audit(page, label, options);

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

/** "outubro de 2026": this month's name in the app, or another month counted from it (`-1` is the last one). */
export function monthName(offset = 0): string {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth() + offset, 1).toLocaleDateString("pt-BR", {
    month: "long",
    year: "numeric",
  });
}
