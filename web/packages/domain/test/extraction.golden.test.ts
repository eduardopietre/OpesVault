/**
 * Extraction parity (golden/parsers.json): pdf.js on the same PDF bytes must give the text
 * pdfplumber gave, line by line and exactly, with boxes within `BOX_TOLERANCE` points, and the
 * parsers on that text the same results as on Python's.
 *
 * Measured on the synthetic documents, including `positioned.pdf` (two columns on a line, runs that
 * touch, a run ending in a space, fake bold, baselines 0.8 pt apart, runs with edge spaces): every
 * line has pdfplumber's text and every box matches within 1e-12 pt (the floating-point
 * noise of the two computations); the tolerance documents what a real document may need, since
 * pdf.js reports runs of text while pdfplumber measures each character.
 *
 * One known difference: pdf.js drops glyphs that start beyond the page's edge (its text layer
 * skips what cannot be seen), pdfplumber keeps them. The synthetic SINACOR note prints a table
 * header past the right edge (x1 = 604 pt on a 595 pt page): pdfplumber reads "… D/C", pdf.js
 * "… D/". Such a line must be pdfplumber's text cut where the page ends; no supported layout reads
 * text outside the page, and the parsers give the same items either way (checked below).
 */
import { describe, expect, it } from "vitest";

import { runParser } from "../src/importing/pipeline.ts";
import { linesFromItems, loadSource, SourceError, SourceProblem } from "../src/importing/source.ts";
import { bytesOf, extractor, GOLDEN_PARSERS as PARSERS, parsersGolden, resultJson } from "./importing_helpers.ts";

/** Points: a box edge further than this from pdfplumber's fails the test. */
export const BOX_TOLERANCE = 0.01;
/** The synthetic PDFs' MediaBox width (devtools/synthetic_pdf.py). */
const PAGE_WIDTH = 595;
const data = parsersGolden();
const pdfs = data.documents.filter((d) => d.name.endsWith(".pdf"));

describe("pdf.js extraction equals pdfplumber's", () => {
  for (const doc of pdfs) {
    it(doc.name, async () => {
      let src;
      try {
        src = await loadSource(doc.name, bytesOf(doc.bytes), null, extractor);
      } catch (error) {
        expect(error).toBeInstanceOf(SourceError);
        expect((error as SourceError).problem).toBe(doc.problem);
        return;
      }
      const expected = doc.source!;
      expect(src.pages).toBe(expected.pages);
      expect(src.producer).toBe(expected.producer);
      expect(src.lines.length).toBe(expected.lines.length);
      let worst = 0;
      src.lines.forEach((l, i) => {
        const theirs = expected.lines[i]!;
        const box = theirs.bbox!;
        expect(l.page).toBe(theirs.page);
        if (box[2] > PAGE_WIDTH) {
          // Past the page edge: pdf.js keeps the visible part only.
          expect(theirs.text.startsWith(l.text) && theirs.text.length > l.text.length, theirs.text).toBe(true);
          expect(l.bbox![2]).toBeLessThanOrEqual(PAGE_WIDTH + 10);
          [0, 1, 3].forEach((k) => (worst = Math.max(worst, Math.abs(l.bbox![k]! - box[k]!))));
          return;
        }
        expect(l.text).toBe(theirs.text);
        l.bbox!.forEach((v, k) => (worst = Math.max(worst, Math.abs(v - box[k]!))));
      });
      expect(worst).toBeLessThanOrEqual(BOX_TOLERANCE);
      // The whole pipeline from bytes: same layout, same items (boxes are compared above).
      for (const p of PARSERS) expect(p.detect(src)).toBe(doc.detect![p.id]);
      const chosen = doc.choice!.parser;
      if (chosen !== null) {
        const ours = resultJson(
          runParser(
            PARSERS.find((p) => p.id === chosen)!,
            src,
          ),
        ) as Record<string, unknown>;
        const theirs = (doc.results![chosen] as { ok: Record<string, unknown> }).ok;
        expect(stripBoxes(ours)).toEqual(stripBoxes(theirs));
      }
    });
  }
});

function stripBoxes(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripBoxes);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, k === "bbox" ? "box" : stripBoxes(v)]),
    );
  }
  return value;
}

describe("PDF passwords (tests/test_pdf_password.py)", () => {
  for (const enc of data.encrypted) {
    it(`${enc.algorithm} with user password '${enc.user}'`, async () => {
      for (const [label, password] of [
        ["none", null],
        ["wrong", "errada"],
        ["right", "12345678900"],
      ] as const) {
        const expected = enc.cases[label]!;
        try {
          const src = await loadSource("fatura.pdf", bytesOf(enc.bytes), password, extractor);
          expect(
            src.lines.map((l) => l.text),
            label,
          ).toEqual(expected.lines);
        } catch (error) {
          if (!(error instanceof SourceError)) throw error;
          expect(error.problem, label).toBe(expected.problem);
        }
      }
    });
  }
});

describe("grouping pdf.js runs into lines", () => {
  const box = (text: string, x0: number, x1: number, top: number, font = "f") => ({
    text,
    font,
    x0,
    x1,
    top,
    bottom: top + 10,
  });

  it("joins runs of one line by x, with a space only across a gap", () => {
    const lines = linesFromItems(1, [
      box("R$ 10,00", 120, 160, 50.5),
      box("05 DEZ", 40, 70, 50),
      box("Mercado", 72, 110, 51),
    ]);
    expect(lines.map((l) => l.text)).toEqual(["05 DEZMercado R$ 10,00"]);
    expect(lines[0]!.bbox).toEqual([40, 50, 160, 61]);
  });

  it("splits lines further apart than 3 points and drops runs printed twice (fake bold)", () => {
    const lines = linesFromItems(2, [box("A", 40, 50, 10), box("A", 40.5, 50.5, 10.4), box("B", 40, 50, 14)]);
    expect(lines.map((l) => [l.page, l.text])).toEqual([
      [2, "A"],
      [2, "B"],
    ]);
  });

  it("refuses what is not a PDF it can read", async () => {
    await expect(loadSource("x.pdf", new TextEncoder().encode("%PDF-1.7\n%%EOF"), null, extractor)).rejects.toThrow(
      SourceError,
    );
    const problem = await loadSource("x.pdf", new TextEncoder().encode("%PDF"), null, extractor).catch(
      (e: SourceError) => e.problem,
    );
    expect(problem).toBe(SourceProblem.INVALID);
  });
});
