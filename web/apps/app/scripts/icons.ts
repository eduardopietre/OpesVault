/**
 * Renders the PWA icons (PNG) from public/icon.svg with the installed Chromium. Run after changing the icon:
 *   pnpm --filter @opesvault/app icons
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const publicDir = fileURLToPath(new URL("../public/", import.meta.url));
const svg = readFileSync(`${publicDir}icon.svg`, "utf8");
// Maskable: the mark inside the 80% safe zone on a full-bleed background.
const maskable = svg
  .replace('rx="112"', 'rx="0"')
  .replace("<circle", '<g transform="translate(51.2 51.2) scale(0.8)"><circle')
  .replace("</svg>", "</g></svg>");

const browser = await chromium.launch();
const page = await browser.newPage();
for (const [name, source, size] of [
  ["icon-192.png", svg, 192],
  ["icon-512.png", svg, 512],
  ["icon-maskable-512.png", maskable, 512],
] as const) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(
    `<html><body style="margin:0;background:transparent">${source.replace("<svg ", `<svg width="${size}" height="${size}" `)}</body></html>`,
  );
  await page.locator("svg").screenshot({ path: `${publicDir}${name}`, omitBackground: true });
}
await browser.close();
// eslint-disable-next-line no-console -- a command-line script
console.log("Icons written to public/");
