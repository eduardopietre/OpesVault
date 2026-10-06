/**
 * Importar e revisar, reading side: files chosen or dropped are read one at a time off the main thread (the
 * in-process stand-in of `parser.worker.ts` speaks the real protocol), a refusal is shown where it happened,
 * a protected PDF asks its password once, cancelling ends the reading, and every import is one undo step.
 */
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { importing } from "@opesvault/domain";
import { describe, expect, it, vi } from "vitest";
import { BANK_OFX, ITAU_CARD_PDF, NUBANK_CARD_CSV } from "../../../../packages/domain/src/demo_docs/index.ts";
import { PROTECTED_PDF_PASSWORD, protectedPdf } from "../../e2e/pages/protected_pdf.ts";
import { addDroppedFiles } from "../../src/data/dropped_files.ts";
import { batches, file, importFiles, itemsTable, lastBatch, openImport, picker, tableOf } from "./importar_harness.tsx";
import { fakePdfRender } from "./importar_pdf_mock.ts";

vi.mock("../../src/data/pdf_render.ts", async () =>
  fakePdfRender(await vi.importActual<typeof import("../../src/data/pdf_render.ts")>("../../src/data/pdf_render.ts")),
);

const bytes = (text: string) => new TextEncoder().encode(text);
const documents = (o: { workspace: { session: { documents: readonly unknown[] } } }) =>
  o.workspace.session.documents.length;

describe("Importar e revisar: o projeto", () => {
  it("shows what the page is for when the project has no documents, and nothing crashes", async () => {
    const o = await openImport({ empty: true });
    expect(await screen.findByRole("heading", { level: 2, name: "Nenhum documento importado" })).toBeTruthy();
    expect(screen.getByText(/arrastar os arquivos para esta janela/)).toBeTruthy();
    expect(tableOf("Documentos importados")).toBeNull();
    expect(tableOf("Itens extraídos")).toBeNull();
    // the header still offers the one primary action and the list of layouts
    expect(screen.getAllByRole("button", { name: "Importar arquivos…" }).length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "Layouts suportados" })).toBeTruthy();
    expect(batches(o)).toHaveLength(0);
  });

  it("lists the demonstration's statement with its institution and state and opens the review on it", async () => {
    const o = await openImport();
    const queue = tableOf("Documentos importados") as HTMLElement;
    expect(queue).toBeTruthy();
    expect(within(queue).getByText("fatura-nubank-03.pdf")).toBeTruthy();
    expect(within(queue).getByText("Nubank")).toBeTruthy();
    const batch = batches(o)[0]!;
    // the review of that document: facts, the checks of its totals and its items
    expect(screen.getByRole("heading", { level: 2, name: "fatura-nubank-03.pdf" })).toBeTruthy();
    const table = await itemsTable();
    expect(table.querySelectorAll("[data-row-id]").length).toBe(importing.pipeline.itemsOf(o.ledger, batch.id).length);
    expect(screen.getByRole("list", { name: "Conferência dos totais" })).toBeTruthy();
    // and the original document beside it
    expect(screen.getByRole("region", { name: "Documento original" })).toBeTruthy();
    expect(await screen.findByText(/Página 1 de 1/)).toBeTruthy();
    expect(screen.getByText(/documento\(s\) · \d+ item\(ns\) aguardando revisão/)).toBeTruthy();
  });
});

describe("Importar e revisar: ler arquivos", () => {
  it("reads a CSV in the worker, opens its review and one undo takes the whole import back", async () => {
    const o = await openImport();
    const documentsBefore = documents(o);
    const itemsBefore = importing.pipeline.items(o.ledger).size;
    const evidenceBefore = importing.pipeline.evidence(o.ledger).size;
    const label = o.workspace.undoStack.undoLabel();
    await importFiles(o, [file(NUBANK_CARD_CSV, "fatura.csv")]);

    // the file went to the worker (not parsed here) with no password
    expect(o.worker.received).toHaveLength(1);
    expect(o.worker.received[0]).toMatchObject({ name: "fatura.csv", password: null, parser_id: null });
    expect(o.worker.received[0]!["data"]).toBeInstanceOf(Uint8Array);

    const batch = lastBatch(o);
    expect(batch.parser_id).toBe("nubank-cartao-csv");
    expect(batch.status).toBe(importing.importModel.BatchStatus.IN_REVIEW);
    expect(importing.pipeline.itemsOf(o.ledger, batch.id)).toHaveLength(3);
    // the review follows the import
    expect(await screen.findByRole("heading", { level: 2, name: "fatura.csv" })).toBeTruthy();
    expect(await screen.findByText("fatura.csv: 3 item(ns) para revisar.")).toBeTruthy();
    // the strip of files in reading is gone once it is done
    expect(screen.queryByLabelText("Arquivos em leitura")).toBeNull();
    // a CSV has no page: the line of the file is the evidence
    await o.user.click(within(await itemsTable()).getByText("Uber *Trip"));
    expect(await screen.findByText(/Linha 2 do arquivo/)).toBeTruthy();

    o.workspace.undo();
    expect(batches(o).some((b) => b.id === batch.id)).toBe(false);
    expect(documents(o)).toBe(documentsBefore);
    expect(importing.pipeline.items(o.ledger).size).toBe(itemsBefore);
    expect(importing.pipeline.evidence(o.ledger).size).toBe(evidenceBefore);
    expect(o.workspace.undoStack.undoLabel()).toBe(label);
  });

  it("reads an OFX and a PDF, one at a time and in order, each as its own undo step", async () => {
    const o = await openImport();
    await importFiles(o, [file(BANK_OFX, "extrato.ofx"), file(ITAU_CARD_PDF, "itau.pdf")]);
    expect(o.worker.received.map((m) => m["name"])).toEqual(["extrato.ofx", "itau.pdf"]);
    expect(o.worker.started).toBe(1);
    const names = batches(o).map((b) => b.parser_id);
    expect(names).toContain("ofx-generico");
    expect(names).toContain("itau-cartao-pdf");
    o.workspace.undo();
    expect(batches(o).map((b) => b.parser_id)).not.toContain("itau-cartao-pdf");
    expect(batches(o).map((b) => b.parser_id)).toContain("ofx-generico");
    o.workspace.undo();
    expect(batches(o).map((b) => b.parser_id)).not.toContain("ofx-generico");
  });

  it("refuses a file already imported, says so in the list and lets the person dismiss it", async () => {
    const o = await openImport();
    await importFiles(o, [file(BANK_OFX, "extrato.ofx")]);
    const before = batches(o).length;
    await o.user.upload(picker(), [file(BANK_OFX, "copia.ofx")]);
    const strip = await screen.findByLabelText("Arquivos em leitura");
    expect(await within(strip).findByText(/Este arquivo já foi importado neste cofre/)).toBeTruthy();
    expect(within(strip).getByText(/Não importado/)).toBeTruthy();
    expect(batches(o)).toHaveLength(before);
    await o.user.click(within(strip).getByRole("button", { name: "Dispensar copia.ofx" }));
    await waitFor(() => expect(screen.queryByLabelText("Arquivos em leitura")).toBeNull());
  });

  it("ignores files that are not PDF, CSV or OFX, with a notice", async () => {
    const o = await openImport();
    fireEvent.change(picker(), {
      target: { files: [file(bytes("MZ"), "programa.exe"), file(bytes("x"), "foto.png")] },
    });
    expect(await screen.findByText("2 arquivos ignorados: só PDF, CSV ou OFX.")).toBeTruthy();
    expect(o.worker.received).toHaveLength(0);
    expect(screen.queryByLabelText("Arquivos em leitura")).toBeNull();
  });

  it("keeps a document with no known layout and says what to do", async () => {
    const o = await openImport();
    await importFiles(o, [file(bytes("a;b\n1;2\n"), "estranho.csv")]);
    const batch = lastBatch(o);
    expect(batch.status).toBe(importing.importModel.BatchStatus.UNSUPPORTED);
    expect(await screen.findByText(/estranho\.csv: Layout desconhecido/)).toBeTruthy();
    expect(screen.getByRole("combobox", { name: "Layout" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Usar layout" })).toBeTruthy();
    // nothing to approve in a document without layout
    expect((screen.getByRole("button", { name: "Aprovar prontos" }) as HTMLButtonElement).disabled).toBe(true);
    expect(await screen.findByText("Nenhum item extraído deste documento")).toBeTruthy();
  });

  it("keeps a corrupt PDF as a document that could not be read, with the reason, instead of failing", async () => {
    const o = await openImport();
    await importFiles(o, [file(bytes("%PDF-1.4 isto não é um PDF"), "quebrado.pdf")]);
    const batch = lastBatch(o);
    expect(batch.status).toBe(importing.importModel.BatchStatus.UNSUPPORTED);
    expect(batch.warnings).toEqual([importing.source.PROBLEM_MESSAGES[importing.source.SourceProblem.INVALID]]);
    expect(await screen.findByText(/quebrado\.pdf: Arquivo corrompido ou inválido\./)).toBeTruthy();
    // the original is kept in the project, so another layout can be tried
    expect(o.workspace.session.documents.some((d) => d.meta.original_name === "quebrado.pdf")).toBe(true);
    o.workspace.undo();
    expect(o.workspace.session.documents.some((d) => d.meta.original_name === "quebrado.pdf")).toBe(false);
  });

  it("refuses a file larger than the limit without reading it", async () => {
    const o = await openImport();
    const huge = file(bytes("%PDF-1.4"), "enorme.pdf");
    Object.defineProperty(huge, "size", { value: 60 * 1024 * 1024 });
    await o.user.upload(picker(), [huge]);
    const strip = await screen.findByLabelText("Arquivos em leitura");
    expect(await within(strip).findByText(/Arquivo grande demais para importar/)).toBeTruthy();
    expect(o.worker.received).toHaveLength(0);
  });
});

describe("Importar e revisar: PDF protegido", () => {
  it("asks the password, refuses a wrong one inside the dialog, reads with the right one and keeps no password", async () => {
    const o = await openImport();
    await o.user.upload(picker(), [file(protectedPdf(), "protegido.pdf")]);
    const dialog = await screen.findByRole("dialog", { name: "PDF protegido" });
    expect(within(dialog).getByText("protegido.pdf")).toBeTruthy();
    expect(within(dialog).getByText("PDF protegido por senha.")).toBeTruthy();
    expect(screen.getByText(/Aguardando a senha/)).toBeTruthy();
    // a wrong one: the dialog stays and says so
    await o.user.type(within(dialog).getByLabelText(/Senha do PDF/), "errada");
    await o.user.click(within(dialog).getByRole("button", { name: "Importar" }));
    expect(await within(dialog).findByText("Senha incorreta. Tente de novo.")).toBeTruthy();
    expect(batches(o).length).toBe(1);
    // the right one
    await o.user.type(within(dialog).getByLabelText(/Senha do PDF/), PROTECTED_PDF_PASSWORD);
    await o.user.click(within(dialog).getByRole("button", { name: "Importar" }));
    await waitFor(() => expect(batches(o).length).toBe(2), { timeout: 20_000 });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "PDF protegido" })).toBeNull());
    // the worker was asked three times: without a password, with the wrong one, with the right one
    expect(o.worker.received.map((m) => m["password"])).toEqual([null, "errada", PROTECTED_PDF_PASSWORD]);
    // the file is kept exactly as it came (still protected) and the password is nowhere in the project
    const stored = o.workspace.session.documents.find((d) => d.meta.original_name === "protegido.pdf")!;
    expect(new TextDecoder("latin1").decode(stored.data)).toContain("/Encrypt");
    const everything = JSON.stringify({
      batches: [...importing.pipeline.batches(o.ledger).values()],
      items: [...importing.pipeline.items(o.ledger).values()],
      evidence: [...importing.pipeline.evidence(o.ledger).values()],
    });
    expect(everything).not.toContain(PROTECTED_PDF_PASSWORD);
    expect(everything).not.toContain("errada");
    // one undo takes the import back
    o.workspace.undo();
    expect(batches(o).length).toBe(1);
  });

  it("skips the file when the person gives up on the password", async () => {
    const o = await openImport();
    await o.user.upload(picker(), [file(protectedPdf(), "protegido.pdf"), file(BANK_OFX, "extrato.ofx")]);
    const dialog = await screen.findByRole("dialog", { name: "PDF protegido" });
    await o.user.click(within(dialog).getByRole("button", { name: "Cancelar" }));
    expect(await screen.findByText("protegido.pdf: senha não informada; o arquivo não foi importado.")).toBeTruthy();
    // the next file is read anyway
    await waitFor(() => expect(batches(o).length).toBe(2), { timeout: 20_000 });
    expect(o.workspace.session.documents.some((d) => d.meta.original_name === "protegido.pdf")).toBe(false);
  });
});

describe("Importar e revisar: cancelar e falhar", () => {
  it("cancels the reading, ends the worker, drops what waited and still reads the next file later", async () => {
    const o = await openImport();
    o.worker.hang = true;
    await o.user.upload(picker(), [file(BANK_OFX, "extrato.ofx"), file(NUBANK_CARD_CSV, "fatura.csv")]);
    const strip = await screen.findByLabelText("Arquivos em leitura");
    expect(await within(strip).findByText(/Lendo…/)).toBeTruthy();
    expect(within(strip).getByText(/Na fila/)).toBeTruthy();
    await o.user.click(within(strip).getByRole("button", { name: "Cancelar leitura" }));
    expect(await screen.findByText("Leitura cancelada.")).toBeTruthy();
    await waitFor(() => expect(screen.queryByLabelText("Arquivos em leitura")).toBeNull());
    expect(o.worker.terminated).toBe(1);
    expect(batches(o)).toHaveLength(1);
    // a new worker reads the next file
    o.worker.hang = false;
    await importFiles(o, [file(NUBANK_CARD_CSV, "fatura.csv")]);
    expect(o.worker.started).toBe(2);
  });

  it("takes a waiting file off the queue without touching the one being read", async () => {
    const o = await openImport();
    o.worker.hang = true;
    await o.user.upload(picker(), [file(BANK_OFX, "extrato.ofx"), file(NUBANK_CARD_CSV, "fatura.csv")]);
    const strip = await screen.findByLabelText("Arquivos em leitura");
    await o.user.click(await within(strip).findByRole("button", { name: "Tirar fatura.csv da fila" }));
    await waitFor(() => expect(within(strip).queryByText("fatura.csv")).toBeNull());
    expect(within(strip).getByText("extrato.ofx")).toBeTruthy();
    o.worker.hang = false;
    await o.user.click(within(strip).getByRole("button", { name: "Cancelar leitura" }));
  });

  it("gives up on a worker that does not answer in time and says the file was not imported", async () => {
    const o = await openImport({ timeoutMs: 80 });
    o.worker.hang = true;
    await o.user.upload(picker(), [file(BANK_OFX, "extrato.ofx")]);
    const strip = await screen.findByLabelText("Arquivos em leitura");
    expect(await within(strip).findByText(/a leitura falhou ou demorou demais/)).toBeTruthy();
    expect(batches(o)).toHaveLength(1);
    expect(o.worker.terminated).toBe(1);
    // and the next file is read by a fresh worker
    o.worker.hang = false;
    await importFiles(o, [file(NUBANK_CARD_CSV, "fatura.csv")]);
    expect(o.worker.started).toBe(2);
  });

  it("does not trust a worker that answers something invalid", async () => {
    const o = await openImport();
    o.worker.garbage = true;
    await o.user.upload(picker(), [file(BANK_OFX, "extrato.ofx")]);
    const strip = await screen.findByLabelText("Arquivos em leitura");
    expect(await within(strip).findByText(/a leitura falhou ou demorou demais/)).toBeTruthy();
    expect(batches(o)).toHaveLength(1);
    expect(o.workspace.session.documents.some((d) => d.meta.original_name === "extrato.ofx")).toBe(false);
  });
});

describe("Importar e revisar: arrastar arquivos", () => {
  it("takes files dropped anywhere in the app: goes to the page and imports them", async () => {
    const o = await openImport({ path: "/livro", heading: "Livro financeiro" });
    const shell = document.querySelector("div.h-dvh") as HTMLElement;
    fireEvent.drop(shell, {
      dataTransfer: { types: ["Files"], files: [file(BANK_OFX, "solto.ofx"), file(NUBANK_CARD_CSV, "solto.csv")] },
    });
    expect(await screen.findByRole("heading", { level: 1, name: "Importar e revisar" })).toBeTruthy();
    expect(o.router.state.location.pathname).toBe("/importar");
    expect(await screen.findByText("2 arquivos recebidos em Importar e revisar.")).toBeTruthy();
    await waitFor(() => expect(batches(o).length).toBe(3), { timeout: 20_000 });
    expect(o.worker.received.map((m) => m["name"])).toEqual(["solto.ofx", "solto.csv"]);
  });

  it("takes files dropped on the page itself, which is already open", async () => {
    const o = await openImport();
    const shell = document.querySelector("div.h-dvh") as HTMLElement;
    fireEvent.drop(shell, { dataTransfer: { types: ["Files"], files: [file(BANK_OFX, "solto.ofx")] } });
    await waitFor(() => expect(batches(o).length).toBe(2), { timeout: 20_000 });
    expect(o.router.state.location.pathname).toBe("/importar");
  });

  it("does not react to a drag that carries no files", async () => {
    const o = await openImport();
    const shell = document.querySelector("div.h-dvh") as HTMLElement;
    fireEvent.drop(shell, { dataTransfer: { types: ["text/plain"], files: [] } });
    expect(o.worker.received).toHaveLength(0);
  });
});

describe("Importar e revisar: arquivos que esperavam", () => {
  it("imports the files dropped before the page was open", async () => {
    addDroppedFiles([file(BANK_OFX, "solto.ofx")]);
    const o = await openImport();
    await waitFor(() => expect(batches(o).length).toBe(2), { timeout: 20_000 });
    expect(o.worker.received[0]).toMatchObject({ name: "solto.ofx" });
  });
});

describe("Importar e revisar: só leitura e atalhos", () => {
  it("disables importing and editing when another tab is editing, and says why", async () => {
    const o = await openImport();
    o.workspace.setReadOnly(true);
    await waitFor(() => {
      const button = screen.getAllByRole("button", { name: "Importar arquivos…" })[0] as HTMLButtonElement;
      expect(button.disabled).toBe(true);
      expect(button.title).toMatch(/aqui só leitura/);
    });
    expect((screen.getByRole("button", { name: "Aprovar prontos" }) as HTMLButtonElement).disabled).toBe(true);
    // a file that still arrives is refused with a notice
    fireEvent.change(picker(), { target: { files: [file(BANK_OFX, "extrato.ofx")] } });
    expect(await screen.findByText(/aberto só para leitura/)).toBeTruthy();
    expect(o.worker.received).toHaveLength(0);
  });

  it("Ctrl+I opens the file chooser", async () => {
    await openImport();
    const click = vi.spyOn(HTMLInputElement.prototype, "click").mockImplementation(() => undefined);
    fireEvent.keyDown(window, { key: "i", ctrlKey: true });
    expect(click).toHaveBeenCalled();
  });

  it("lists the layouts that are read, with their version and whether real documents validated them", async () => {
    const o = await openImport();
    await o.user.click(screen.getByRole("button", { name: "Layouts suportados" }));
    const dialog = await screen.findByRole("dialog", { name: "Layouts suportados" });
    const rows = within(dialog).getAllByRole("row");
    expect(rows.length - 1).toBe(importing.parsers.PARSERS.length);
    expect(within(dialog).getAllByText("não (sintético)").length).toBeGreaterThan(0);
    expect(within(dialog).getByText("nubank-cartao-csv")).toBeTruthy();
    await o.user.click(within(dialog).getAllByRole("button", { name: "Fechar" }).at(-1)!);
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Layouts suportados" })).toBeNull());
  });
});
