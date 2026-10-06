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
}

/** What `getDocument` returns: the loading task owns the worker, so it (not the document) is destroyed. */
interface PdfLoadingTask {
  promise: Promise<PdfDocument>;
  destroy(): Promise<void>;
}

interface PdfJs {
  getDocument(options: { data: Uint8Array; password?: string }): PdfLoadingTask;
}

/** The PDF is protected and no password (or a wrong one) was given. The password itself is never kept. */
export class PdfPasswordRequired extends Error {
  readonly incorrect: boolean;
  constructor(incorrect: boolean) {
    super(incorrect ? "Senha incorreta." : "Este PDF é protegido por senha.");
    this.name = "PdfPasswordRequired";
    this.incorrect = incorrect;
  }
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
 * CSS width the pages should fill. Throws when the file cannot be read or drawn, and `PdfPasswordRequired` when
 * it is protected: `password` is used for this one call and not kept.
 */
export async function renderPdf(
  data: Uint8Array,
  host: HTMLElement,
  width: number,
  maxPages = 30,
  password?: string,
): Promise<RenderedPdf> {
  const pdfjs = await loadPdfJs();
  // pdf.js takes ownership of the buffer it is given: hand it a copy.
  const task = pdfjs.getDocument({ data: data.slice(), ...(password ? { password } : {}) });
  const document = await task.promise.catch((error: unknown) => {
    void task.destroy();
    if (error instanceof Error && error.name === "PasswordException") {
      throw new PdfPasswordRequired((error as { code?: number }).code === 2);
    }
    throw error;
  });
  try {
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
  } catch (error) {
    void task.destroy();
    throw error;
  }
  return { pages: document.numPages, destroy: () => void task.destroy() };
}

// ── one page at a time, with its size in PDF points (the conference draws the evidence over it) ──

export interface PageDrawing {
  canvas: HTMLCanvasElement;
  /** The page's size in PDF points, the unit of an item's evidence box. */
  points: { width: number; height: number };
}

export interface OpenPdf {
  pages: number;
  /** Draws page `number` (1-based) to a new canvas as wide as `width` CSS pixels. */
  draw(number: number, width: number): Promise<PageDrawing>;
  destroy(): void;
}

/**
 * Opens a PDF to show it one page at a time. `password` is used for this one call and not kept; a protected
 * file without it (or with a wrong one) throws `PdfPasswordRequired`.
 */
export async function openPdf(data: Uint8Array, password?: string): Promise<OpenPdf> {
  const pdfjs = await loadPdfJs();
  const task = pdfjs.getDocument({ data: data.slice(), ...(password ? { password } : {}) });
  const document = await task.promise.catch((error: unknown) => {
    void task.destroy();
    if (error instanceof Error && error.name === "PasswordException") {
      throw new PdfPasswordRequired((error as { code?: number }).code === 2);
    }
    throw error;
  });
  return {
    pages: document.numPages,
    async draw(number, width) {
      const page = await document.getPage(Math.min(Math.max(1, number), document.numPages));
      const base = page.getViewport({ scale: 1 });
      const pixelRatio = Math.min(globalThis.devicePixelRatio || 1, 2);
      const viewport = page.getViewport({ scale: (Math.max(width, 200) / base.width) * pixelRatio });
      const canvas = globalThis.document.createElement("canvas");
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      await page.render({ canvas, viewport }).promise;
      return { canvas, points: { width: base.width, height: base.height } };
    },
    destroy: () => void task.destroy(),
  };
}
