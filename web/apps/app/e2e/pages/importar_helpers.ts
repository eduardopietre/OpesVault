/** Helpers of the Importar e revisar end-to-end tests and screenshots: real files, the file chooser and a drop. */
import { expect, type Page } from "@playwright/test";
import { BANK_OFX, ITAU_CARD_PDF, NUBANK_CARD_CSV } from "../../../../packages/domain/src/demo_docs/index.ts";
import { protectedPdf } from "../protected_pdf.ts";

export interface TestFile {
  name: string;
  mimeType: string;
  buffer: Buffer;
}

export const OFX: TestFile = { name: "extrato.ofx", mimeType: "application/x-ofx", buffer: Buffer.from(BANK_OFX) };
export const CSV: TestFile = { name: "fatura.csv", mimeType: "text/csv", buffer: Buffer.from(NUBANK_CARD_CSV) };
export const ITAU: TestFile = { name: "itau.pdf", mimeType: "application/pdf", buffer: Buffer.from(ITAU_CARD_PDF) };
export const PROTECTED: TestFile = { name: "protegido.pdf", mimeType: "application/pdf", buffer: protectedPdf() };
/** A statement from a bank without a layout of its own: read by its column names (Windows-1252, ";"). */
export const BANK_CSV: TestFile = {
  name: "extrato-banco.csv",
  mimeType: "text/csv",
  buffer: Buffer.from(
    [
      "Agência: 1234;Conta: 99999-9",
      "data;lançamento;valor (R$);saldo (R$)",
      "31/01/2026;SALDO ANTERIOR;;1.000,00",
      "02/02/2026;PIX RECEBIDO EMPRESA Y;1.500,00;2.500,00",
      "03/02/2026;FARMACIA SAO JOAO;-89,90;2.410,10",
    ].join("\r\n"),
    "latin1",
  ),
};
/** Two layouts recognize it: the person has to choose. */
export const AMBIGUOUS: TestFile = {
  name: "dois-layouts.csv",
  mimeType: "text/csv",
  buffer: Buffer.from(
    "date,title,amount,Data,Valor,Identificador,Descrição\n2026-02-03,Uber Trip,23.45,03/02/2026,-23.45,id-1,Uber Trip\n",
  ),
};

/** Chooses files in the browser's own file chooser, the way a person does. */
export async function chooseFiles(page: Page, files: TestFile[]): Promise<void> {
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Importar arquivos…" }).first().click();
  await (await chooser).setFiles(files);
}

/** Drags files over the window (the overlay shows) and drops them anywhere in the app. */
export async function dropOnApp(page: Page, files: TestFile[]): Promise<void> {
  const payload = files.map((f) => ({ name: f.name, type: f.mimeType, data: f.buffer.toString("base64") }));
  const dispatch = (type: "dragover" | "drop") =>
    page.evaluate(
      ({ list, kind }) => {
        const w = window as unknown as { __drag?: DataTransfer };
        if (!w.__drag) {
          const transfer = new DataTransfer();
          for (const f of list) {
            const bytes = Uint8Array.from(atob(f.data), (c) => c.charCodeAt(0));
            transfer.items.add(new File([bytes], f.name, { type: f.type }));
          }
          w.__drag = transfer;
        }
        const root = document.querySelector("div.h-dvh") as HTMLElement;
        root.dispatchEvent(new DragEvent(kind, { dataTransfer: w.__drag, bubbles: true, cancelable: true }));
        if (kind === "drop") delete w.__drag;
      },
      { list: payload, kind: type },
    );
  await dispatch("dragover");
  await expect(page.getByText("Solte para importar")).toBeVisible();
  await dispatch("drop");
}

/** The toast that says a document was read. */
export const readNotice = (page: Page, name: string) =>
  page.getByText(new RegExp(`^${name.replace(".", "\\.")}: (\\d+ item\\(ns\\) para revisar|.+)`)).first();

/** The workers the page starts, by address (the parser worker must start under the production CSP). */
export function watchWorkers(page: Page): string[] {
  const urls: string[] = [];
  page.on("worker", (worker) => urls.push(worker.url()));
  return urls;
}
