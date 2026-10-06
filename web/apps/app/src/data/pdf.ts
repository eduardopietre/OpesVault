/**
 * pdf.js in the browser, on the calling thread or inside our parser worker: its "worker" code is
 * loaded as a module and handed over through `globalThis.pdfjsWorker`, so pdf.js never starts a worker
 * of its own from a URL (nothing to allow in the Trusted Types policy, nothing fetched at run time).
 */
import { importing } from "@opesvault/domain";

let loading: Promise<unknown> | null = null;

async function loadPdfJs(): Promise<never> {
  loading ??= (async () => {
    const worker: unknown = await import("pdfjs-dist/legacy/build/pdf.worker.mjs");
    (globalThis as { pdfjsWorker?: unknown }).pdfjsWorker = worker;
    return import("pdfjs-dist/legacy/build/pdf.mjs");
  })();
  return (await loading) as never;
}

/** The PDF text extractor for this browser. */
export function browserExtractor(): importing.source.PdfJsExtractor {
  return new importing.source.PdfJsExtractor(loadPdfJs);
}
