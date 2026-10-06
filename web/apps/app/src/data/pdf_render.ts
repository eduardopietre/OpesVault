/**
 * Draws the pages of a PDF onto canvases with pdf.js (a receipt, a statement). The browser's own viewer
 * cannot be used: the CSP allows no frames and no plugins (docs/18 §3.7). pdf.js loads its "worker" code as a
 * module (see `pdf.ts`), so nothing is fetched at run time.
 */

interface PdfPage {
  getViewport(options: { scale: number }): { width: number; height: number };
  render(options: { canvas: HTMLCanvasElement; viewport: unknown }): { promise: Promise<void> };
}

interface PdfDocument {
  numPages: number;
  getPage(number: number): Promise<PdfPage>;
  destroy(): Promise<void>;
}

interface PdfJs {
  getDocument(options: { data: Uint8Array }): { promise: Promise<PdfDocument> };
}

let loading: Promise<PdfJs> | null = null;

function loadPdfJs(): Promise<PdfJs> {
  loading ??= (async () => {
    const worker: unknown = await import("pdfjs-dist/legacy/build/pdf.worker.mjs");
    (globalThis as { pdfjsWorker?: unknown }).pdfjsWorker = worker;
    return (await import("pdfjs-dist/legacy/build/pdf.mjs")) as unknown as PdfJs;
  })();
  return loading;
}

export interface RenderedPdf {
  pages: number;
  destroy(): void;
}

/**
 * Renders up to `maxPages` pages, one canvas each, into `host` (replacing what it holds). `width` is the
 * CSS width the pages should fill. Throws when the file cannot be read or drawn.
 */
export async function renderPdf(
  data: Uint8Array,
  host: HTMLElement,
  width: number,
  maxPages = 30,
): Promise<RenderedPdf> {
  const pdfjs = await loadPdfJs();
  // pdf.js takes ownership of the buffer it is given: hand it a copy.
  const document = await pdfjs.getDocument({ data: data.slice() }).promise;
  host.replaceChildren();
  const pixelRatio = Math.min(globalThis.devicePixelRatio || 1, 2);
  const count = Math.min(document.numPages, maxPages);
  for (let number = 1; number <= count; number++) {
    const page = await document.getPage(number);
    const base = page.getViewport({ scale: 1 });
    const scale = (Math.max(width, 240) / base.width) * pixelRatio;
    const viewport = page.getViewport({ scale });
    const canvas = host.ownerDocument.createElement("canvas");
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    canvas.className = "mb-3 block h-auto w-full rounded-md border border-separator bg-white shadow-sm";
    canvas.setAttribute("role", "img");
    canvas.setAttribute("aria-label", `Página ${number} de ${document.numPages}`);
    host.append(canvas);
    await page.render({ canvas, viewport }).promise;
  }
  return { pages: document.numPages, destroy: () => void document.destroy() };
}
