/**
 * Importar e revisar, the original beside the review: the page of the selected item with a box around the text it
 * was read from, the page controls, a protected original that asks for the password only to be shown, and an
 * original that cannot be fetched.
 */
import { importing } from "@opesvault/domain";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ITAU_CARD_PDF } from "../../../../packages/domain/src/demo_docs/index.ts";
import { PROTECTED_PDF_PASSWORD, protectedPdf } from "../../e2e/protected_pdf.ts";
import { DocumentUnavailable } from "../../src/data/workspace.ts";
import { boxStyle } from "../../src/pages/importar/rows.ts";
import { file, importFiles, itemsOf, lastBatch, openImport, pickItem, picker } from "./importar_harness.tsx";
import { PAGE_POINTS, fakePdfRender } from "./importar_pdf_mock.ts";

vi.mock("../../src/data/pdf_render.ts", async () =>
  fakePdfRender(await vi.importActual<typeof import("../../src/data/pdf_render.ts")>("../../src/data/pdf_render.ts")),
);

const render = async () =>
  (await import("../../src/data/pdf_render.ts")) as unknown as { drawn: ReturnType<typeof vi.fn> };

const evidenceOf = (o: Awaited<ReturnType<typeof openImport>>, description: string) => {
  const item = itemsOf(o, o.ledger.operations.size ? lastBatch(o).id : lastBatch(o).id).find(
    (i) => i.description === description,
  )!;
  return importing.pipeline.evidence(o.ledger).get(item.evidence_ids[0]!)!;
};

describe("Importar e revisar: o original ao lado", () => {
  it("draws the page of the document and a box around the text the selected item was read from", async () => {
    const o = await openImport();
    expect(await screen.findByText("Página 1 de 1")).toBeTruthy();
    // no item selected, no box
    expect(document.querySelector("[data-evidence-box]")).toBeNull();
    await pickItem(o, "Padaria");
    const found = evidenceOf(o, "Padaria");
    expect(found.page).toBe(1);
    expect(found.bbox).not.toBeNull();
    const box = await waitFor(() => {
      const element = document.querySelector<HTMLElement>("[data-evidence-box]");
      expect(element).toBeTruthy();
      return element!;
    });
    // as a share of the page, so it fits at any width
    const expected = boxStyle(found.bbox!, PAGE_POINTS);
    expect(box.style.left).toBe(expected.left);
    expect(box.style.top).toBe(expected.top);
    expect(box.style.width).toBe(expected.width);
    expect(box.style.height).toBe(expected.height);
    expect(box.getAttribute("aria-hidden")).toBe("true");
    // the same evidence in text, for whoever cannot see the page
    const figure = screen.getByRole("figure", { name: "Evidência do item selecionado" });
    expect(within(figure).getByText("Evidência: página 1")).toBeTruthy();
    expect(within(figure).getByText(found.text)).toBeTruthy();
    // another item moves the box
    await pickItem(o, "Amazon.com");
    await waitFor(() => {
      const moved = document.querySelector<HTMLElement>("[data-evidence-box]")!;
      expect(moved.style.top).not.toBe(expected.top);
    });
  });

  it("goes to the page of the selected item and has controls for the others", async () => {
    const o = await openImport();
    await importFiles(o, [file(ITAU_CARD_PDF, "itau.pdf")]);
    expect(await screen.findByText("Página 1 de 2")).toBeTruthy();
    // the statement of the sample has nothing to read on its second page: one item is moved there for the test
    const second = itemsOf(o, lastBatch(o).id).find((item) => item.description === "POSTO SHELL")!;
    o.workspace.act((ledger) => {
      const evidence = importing.pipeline.evidence(ledger);
      const found = evidence.get(second.evidence_ids[0]!)!;
      evidence.set(found.id, { ...found, page: 2 });
    });
    await pickItem(o, second.description);
    expect(await screen.findByText("Página 2 de 2")).toBeTruthy();
    expect((await render()).drawn).toHaveBeenCalledWith(2, expect.any(Number));
    expect((screen.getByRole("button", { name: "Próxima página" }) as HTMLButtonElement).disabled).toBe(true);
    await o.user.click(screen.getByRole("button", { name: "Página anterior" }));
    expect(await screen.findByText("Página 1 de 2")).toBeTruthy();
    // on a page that is not the item's, there is no box
    await waitFor(() => expect(document.querySelector("[data-evidence-box]")).toBeNull());
  });

  it("shows the line of the file for an item read from a spreadsheet or OFX", async () => {
    const o = await openImport();
    const csv = new TextEncoder().encode("date,title,amount\n2026-02-03,Uber Trip,23.45\n");
    await importFiles(o, [file(csv, "fatura.csv")]);
    expect(await screen.findByText(/a linha de origem de cada item aparece aqui/)).toBeTruthy();
    await pickItem(o, "Uber Trip");
    expect(await screen.findByText("Linha 2 do arquivo")).toBeTruthy();
    expect(screen.getByText("2026-02-03,Uber Trip,23.45")).toBeTruthy();
    expect(document.querySelector("[data-evidence-box]")).toBeNull();
  });

  it("asks the password of a protected original only to show it, and tries again after a wrong one", async () => {
    const o = await openImport();
    await o.user.upload(picker(), [file(protectedPdf(), "protegido.pdf")]);
    const import_ = await screen.findByRole("dialog", { name: "PDF protegido" });
    await o.user.type(within(import_).getByLabelText(/Senha do PDF/), PROTECTED_PDF_PASSWORD);
    await o.user.click(within(import_).getByRole("button", { name: "Importar" }));
    // the reading is done; the original is still protected and says so
    expect(await screen.findByText(/Este PDF é protegido por senha\./, {}, { timeout: 20_000 })).toBeTruthy();
    await o.user.click(screen.getByRole("button", { name: "Informar senha…" }));
    const dialog = await screen.findByRole("dialog", { name: "PDF protegido" });
    await o.user.type(within(dialog).getByLabelText(/Senha do PDF/), "errada");
    await o.user.click(within(dialog).getByRole("button", { name: "Abrir" }));
    expect(await within(dialog).findByText("Senha incorreta. Tente de novo.")).toBeTruthy();
    await o.user.type(within(dialog).getByLabelText(/Senha do PDF/), PROTECTED_PDF_PASSWORD);
    await o.user.click(within(dialog).getByRole("button", { name: "Abrir" }));
    expect(await screen.findByText(/Página 1 de 1/)).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "PDF protegido" })).toBeNull());
  });

  it("says when the original cannot be opened and tries again on request", async () => {
    const o = await openImport();
    const loading = vi.spyOn(o.workspace, "loadDocument").mockRejectedValue(new DocumentUnavailable());
    await importFiles(o, [
      file(new TextEncoder().encode("date,title,amount\n2026-02-03,Uber Trip,23.45\n"), "fatura.csv"),
    ]);
    const alert = await screen.findByRole("alert");
    expect(within(alert).getByRole("button", { name: "Tentar de novo" })).toBeTruthy();
    loading.mockRestore();
    await o.user.click(within(alert).getByRole("button", { name: "Tentar de novo" }));
    expect(await screen.findByText(/a linha de origem de cada item aparece aqui/)).toBeTruthy();
    fireEvent.keyDown(window, { key: "Escape" });
  });
});
