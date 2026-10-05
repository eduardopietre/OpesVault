/** Motion policy (docs/18 §5.2): with reduced motion nothing moves, only short fades; otherwise pages slide in. */
import { expect, test, type Page } from "@playwright/test";
import { openDemo } from "./helpers.ts";

/** Samples the transform and opacity of the page content for the frames after a navigation. */
async function sampleEntry(page: Page): Promise<{ transform: string; opacity: string }[]> {
  await page.evaluate(() => {
    const samples: { transform: string; opacity: string }[] = [];
    (window as unknown as { samples: typeof samples }).samples = samples;
    const tick = () => {
      const element = document.querySelector("#conteudo > div");
      if (element) {
        const style = getComputedStyle(element);
        samples.push({ transform: style.transform, opacity: style.opacity });
      }
      if (samples.length < 20) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  await page.keyboard.press("Alt+2");
  await page.waitForTimeout(500);
  return page.evaluate(() => (window as unknown as { samples: { transform: string; opacity: string }[] }).samples);
}

test.describe("reduced motion", () => {
  test.use({ contextOptions: { reducedMotion: "reduce" } });

  test("a page change only fades", async ({ page }) => {
    await openDemo(page, "/visao-geral");
    const samples = await sampleEntry(page);
    expect(samples.length).toBeGreaterThan(5);
    expect(samples.every((sample) => sample.transform === "none")).toBe(true);
  });
});

test.describe("full motion", () => {
  test.use({ contextOptions: { reducedMotion: "no-preference" } });

  test("a page change slides in and fades", async ({ page }) => {
    await openDemo(page, "/visao-geral");
    const samples = await sampleEntry(page);
    expect(samples.some((sample) => sample.transform !== "none")).toBe(true);
    expect(samples.some((sample) => Number(sample.opacity) < 1)).toBe(true);
    expect(samples.at(-1)?.opacity).toBe("1");
  });
});
