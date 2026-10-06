/** Contrast of the design tokens that a test can compute without a browser (WCAG 2.2 AA, docs/16). */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(resolve(import.meta.dirname, "../src/styles/tokens.css"), "utf8");

/** The innermost rule blocks that declare tokens: light (:root), dark by system and dark by choice. */
function blocks(): Record<string, string>[] {
  const result: Record<string, string>[] = [];
  for (const match of css.matchAll(/\{([^{}]*)\}/g)) {
    const tokens: Record<string, string> = {};
    for (const declaration of match[1]!.matchAll(/--ov-([\w-]+):\s*(#[0-9a-fA-F]{6})\b/g)) {
      tokens[declaration[1]!] = declaration[2]!;
    }
    if (Object.keys(tokens).length > 5) result.push(tokens);
  }
  return result;
}

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const channel = Number.parseInt(hex.slice(i, i + 2), 16) / 255;
    return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (high + 0.05) / (low + 0.05);
}

describe("primary button contrast", () => {
  const themes = blocks().filter((tokens) => tokens["accent-fill"]);

  it("finds the light theme and both dark ones", () => {
    expect(themes).toHaveLength(3);
  });

  it.each(["accent-fill", "accent-fill-hover"])("%s keeps 4.5:1 against the button text in every theme", (name) => {
    for (const tokens of themes) {
      expect(contrast(tokens[name]!, tokens["accent-text"]!), `${name} ${tokens[name]}`).toBeGreaterThanOrEqual(4.5);
    }
  });
});
