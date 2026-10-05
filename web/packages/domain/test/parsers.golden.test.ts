/**
 * Parser parity (golden/parsers.json, scripts/golden/cases_parsers.py): the TS parsers fed with the
 * source exactly as Python read it must give identical results, for every synthetic document,
 * every parser, and the fuzzed variants of tests/test_fuzz.py. Decimals compare as text.
 */
import { describe, expect, it } from "vitest";

import { DocFormat } from "../src/importing/model.ts";
import { PARSERS } from "../src/importing/parsers/index.ts";
import { chooseParser, ParseFailed, runParser } from "../src/importing/pipeline.ts";
import { loadStructured, type Source, SourceError } from "../src/importing/source.ts";
import {
  bytesOf,
  type DocumentCase,
  type Outcome,
  parsersGolden,
  resultJson,
  sourceFrom,
  sourceJson,
} from "./importing_helpers.ts";

const data = parsersGolden();

function runOutcome(parserId: string, src: Source): Outcome {
  const parser = PARSERS.find((p) => p.id === parserId)!;
  try {
    return { ok: resultJson(runParser(parser, src)) };
  } catch (error) {
    if (error instanceof ParseFailed) return { error: "ParseFailed", message: error.message };
    throw error;
  }
}

function checkAnalysis(doc: DocumentCase, src: Source): void {
  for (const p of PARSERS) expect(p.detect(src), `${doc.name} detect ${p.id}`).toBe(doc.detect![p.id]);
  const [parser, candidates] = chooseParser(src);
  expect({ parser: parser?.id ?? null, candidates }).toEqual(doc.choice);
  for (const p of PARSERS) expect(runOutcome(p.id, src), `${doc.name} ${p.id}`).toEqual(doc.results![p.id]);
}

describe("parser catalog", () => {
  it("declares the same layouts, versions and limitations", () => {
    expect(
      PARSERS.map((p) => ({
        id: p.id,
        version: p.version,
        institution: p.institution,
        product: p.product,
        doc_type: p.doc_type,
        doc_format: p.doc_format,
        validated_with_real_documents: p.validated_with_real_documents,
        limitations: p.limitations,
      })),
    ).toEqual(data.parsers);
  });
});

describe("parsers fed with Python's extracted source", () => {
  for (const doc of data.documents.filter((d) => d.source)) {
    it(doc.name, () => checkAnalysis(doc, sourceFrom(doc.source!)));
  }
});

describe("structured sources read from bytes (CSV, OFX)", () => {
  const structured = data.documents.filter((d) => !d.name.endsWith(".pdf"));
  for (const doc of structured) {
    it(doc.name, () => {
      const src = loadStructured(doc.name, bytesOf(doc.bytes));
      expect(sourceJson(src)).toEqual(doc.source);
      checkAnalysis(doc, src);
    });
  }
});

describe("fuzzed PDF text forced into every PDF parser", () => {
  it(`${data.text_fuzz.length} mutated texts give the same results`, () => {
    for (const [n, fuzz] of data.text_fuzz.entries()) {
      const base = data.documents.find((d) => d.name === fuzz.doc)!;
      const src = sourceFrom(base.source!);
      src.lines = fuzz.lines.map((text, i) => ({ page: 1, text, bbox: null, number: i + 1 }));
      for (const p of PARSERS) expect(p.detect(src), `${n} ${fuzz.doc} detect ${p.id}`).toBe(fuzz.detect[p.id]);
      for (const p of PARSERS.filter((q) => q.doc_format === DocFormat.PDF)) {
        const expected = fuzz.results[p.id]!;
        if ("error" in expected) {
          expect(() => p.parse(src), `${n} ${fuzz.doc} ${p.id}`).toThrow();
          continue;
        }
        expect(resultJson(p.parse(src)), `${n} ${fuzz.doc} ${p.id}`).toEqual(expected.ok);
      }
    }
  });
});

describe("fuzzed CSV and OFX bytes", () => {
  it(`${data.bytes_fuzz.length} mutated files load and parse the same`, () => {
    for (const [n, fuzz] of data.bytes_fuzz.entries()) {
      const label = `${n} ${fuzz.name}`;
      let src: Source;
      try {
        src = loadStructured(fuzz.name, bytesOf(fuzz.bytes));
      } catch (error) {
        expect(error, label).toBeInstanceOf(SourceError);
        expect((error as SourceError).problem, label).toBe(fuzz.problem);
        continue;
      }
      expect(fuzz.problem, label).toBeUndefined();
      expect(sourceJson({ ...src, name: fuzz.source!.name }), label).toEqual(fuzz.source);
      checkAnalysis(fuzz, src);
    }
  });
});
