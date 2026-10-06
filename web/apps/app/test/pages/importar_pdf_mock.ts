/**
 * happy-dom has no canvas: the page viewer's pdf.js is replaced by a drawing that reports the pages of the file
 * (counted from its `/Type /Page` objects), is 595 x 842 points like A4, and asks for the password of a file that is
 * encrypted (the one of `e2e/pages/protected_pdf.ts`). Use inside `vi.mock("../../src/data/pdf_render.ts", …)`.
 */
import { vi } from "vitest";
import type * as Render from "../../src/data/pdf_render.ts";

export const PAGE_POINTS = { width: 595, height: 842 } as const;

export function fakePdfRender(actual: typeof Render) {
  const drawn = vi.fn();
  return {
    ...actual,
    drawn,
    openPdf: vi.fn(async (data: Uint8Array, password?: string) => {
      const text = new TextDecoder("latin1").decode(data);
      if (text.includes("/Encrypt")) {
        if (!password) throw new actual.PdfPasswordRequired(false);
        if (password !== "segredo") throw new actual.PdfPasswordRequired(true);
      }
      const pages = Math.max(1, (text.match(/\/Type\s*\/Page\b(?!s)/g) ?? []).length);
      return {
        pages,
        draw: async (number: number, width: number) => {
          drawn(number, width);
          const canvas = document.createElement("canvas");
          return { canvas, points: { ...PAGE_POINTS } };
        },
        destroy: vi.fn(),
      };
    }),
  };
}
