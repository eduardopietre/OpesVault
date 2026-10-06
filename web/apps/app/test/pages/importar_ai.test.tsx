/**
 * Importar e revisar and the local AI: after an import the model suggests categories for the items that still have
 * none, in the background, with progress and a way to cancel. Only descriptions leave the page; the answer fills
 * only items still without a category; nothing is approved; the whole answer is one undo step. The tests talk to
 * a fake Ollama, never a real one.
 */
import { dom, importing } from "@opesvault/domain";
import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { NUBANK_CARD_CSV } from "../../../../packages/domain/src/demo_docs/index.ts";
import { setAiTransport } from "../../src/data/ai.ts";
import { file, importFiles, itemsOf, lastBatch, openImport, pickItem, batches } from "./importar_harness.tsx";
import { fakePdfRender } from "./importar_pdf_mock.ts";

vi.mock("../../src/data/pdf_render.ts", async () =>
  fakePdfRender(await vi.importActual<typeof import("../../src/data/pdf_render.ts")>("../../src/data/pdf_render.ts")),
);

const ItemStatus = importing.importModel.ItemStatus;
const item = (o: Awaited<ReturnType<typeof openImport>>, description: string) =>
  itemsOf(o, lastBatch(o).id).find((i) => i.description === description)!;

describe("Importar e revisar: IA local", () => {
  it("suggests categories after an import, marks where they came from and leaves everything to approve", async () => {
    const o = await openImport({ ai: true });
    o.ollama.smart("Lazer");
    await importFiles(o, [file(NUBANK_CARD_CSV, "fatura.csv")]);
    const lojaZ = () => item(o, "Loja Z");
    await waitFor(() => expect(lojaZ().target_account_id).not.toBeNull(), { timeout: 20_000 });
    expect(o.ledger.accounts.get(lojaZ().target_account_id!)?.name).toBe("Lazer");
    expect(lojaZ().suggestion_source).toMatch(/^ollama:gemma4:12b/);
    // an item that already had a category from a rule is not the model's to change
    expect(o.ledger.accounts.get(item(o, "Uber *Trip").target_account_id!)?.name).toBe("Transporte");
    expect(item(o, "Uber *Trip").suggestion_source).toBe("rule");
    // nothing was approved, and the notice says to review
    expect(itemsOf(o, lastBatch(o).id).every((i) => i.status === ItemStatus.READY)).toBe(true);
    expect(
      await screen.findByText(/IA local: 1 categoria\(s\) sugerida\(s\)\. Revise antes de aprovar\./),
    ).toBeTruthy();
    await pickItem(o, "Loja Z");
    expect(await screen.findAllByText(/sugestão \(IA local, gemma4:12b\)/)).not.toHaveLength(0);
    // only descriptions went to the model, never an amount or a date
    expect(JSON.stringify(o.ollama.received)).not.toMatch(/\d+[.,]\d{2}/);
    // the answer is its own undo step: one undo takes the suggestions, the next the import
    o.workspace.undo();
    expect(lojaZ().target_account_id).toBeNull();
    expect(batches(o).some((b) => b.id === lastBatch(o).id)).toBe(true);
    o.workspace.undo();
    expect(batches(o)).toHaveLength(1);
  });

  it("shows progress and lets the person cancel; a choice made meanwhile always wins", async () => {
    const o = await openImport({ ai: true });
    o.ollama.smart("Lazer");
    // the model answers only when the test says so
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const inner = o.ollama.transport;
    setAiTransport(async (url, init) => {
      if (init.method === "POST" && url.endsWith("/api/chat")) await gate;
      return inner(url, init);
    });
    await importFiles(o, [file(NUBANK_CARD_CSV, "fatura.csv")]);
    const progress = await screen.findByRole("progressbar", { name: "Progresso da IA local" });
    expect(within(progress.parentElement!).getByText(/IA local \(gemma4:12b\): 0 de 1 descrição\(ões\)/)).toBeTruthy();
    // the person picks the category before the model answers
    await o.user.click(screen.getByRole("combobox", { name: "Categoria ou conta de Loja Z" }));
    await o.user.click(await screen.findByRole("option", { name: "Moradia" }));
    await o.user.click(within(progress.parentElement!).getByRole("button", { name: "Cancelar" }));
    expect(await screen.findByText("Cancelando ao fim do lote atual…")).toBeTruthy();
    release();
    // the one batch was already asked, so nothing was left to interrupt; the person's choice stands
    expect(await screen.findByText(/IA local: 0 categoria\(s\) sugerida\(s\)\./)).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole("progressbar", { name: "Progresso da IA local" })).toBeNull());
    expect(o.ledger.accounts.get(item(o, "Loja Z").target_account_id!)?.name).toBe("Moradia");
    expect(item(o, "Loja Z").suggestion_source).toBeNull();
  });

  it("asks again with the button when the automatic run could not, and says plainly when Ollama is off", async () => {
    const o = await openImport({ ai: true });
    let back = false;
    // the client keeps its transport: this one refuses until the test says Ollama is back
    setAiTransport((url, init) => (back ? o.ollama.transport(url, init) : Promise.reject(new Error("ECONNREFUSED"))));
    await importFiles(o, [file(NUBANK_CARD_CSV, "fatura.csv")]);
    // the automatic run only warns: the review goes on by hand
    expect(await screen.findByText(/IA local: /)).toBeTruthy();
    expect(item(o, "Loja Z").target_account_id).toBeNull();
    const ask = screen.getByRole("button", { name: /^Sugerir com IA \(1\)/ }) as HTMLButtonElement;
    expect(ask.disabled).toBe(false);
    expect(ask.title).toMatch(/Ollama local/);
    // asked by hand and still off: a dialog that says so, and the manual review continues
    await o.user.click(ask);
    const dialog = await screen.findByRole("alertdialog", { name: "IA local" });
    expect(within(dialog).getByText(/A revisão manual continua disponível\./)).toBeTruthy();
    await o.user.click(within(dialog).getByRole("button", { name: "Entendi" }));
    // Ollama is back: the button asks and fills the item
    o.ollama.smart("Lazer");
    back = true;
    await o.user.click(screen.getByRole("button", { name: /^Sugerir com IA \(1\)/ }));
    await waitFor(() => expect(item(o, "Loja Z").target_account_id).not.toBeNull(), { timeout: 20_000 });
    expect(
      await screen.findByText(/IA local: 1 categoria\(s\) sugerida\(s\)\. Revise antes de aprovar\./),
    ).toBeTruthy();
    // nothing left to ask about: the button says so
    await waitFor(() => {
      const done = screen.getByRole("button", { name: "Sugerir com IA" }) as HTMLButtonElement;
      expect(done.disabled).toBe(true);
      expect(done.title).toBe("Todos os itens deste documento já têm categoria");
    });
    o.workspace.undo();
    expect(item(o, "Loja Z").target_account_id).toBeNull();
  });

  it("has no AI button and asks nothing when the project has the AI off", async () => {
    const o = await openImport();
    o.ollama.smart("Lazer");
    await importFiles(o, [file(NUBANK_CARD_CSV, "fatura.csv")]);
    expect(screen.queryByRole("button", { name: /Sugerir com IA/ })).toBeNull();
    expect(o.ollama.received).toHaveLength(0);
    // turning it on shows the button for the open document
    o.workspace.act((ledger) => dom.settings.updateSettings(ledger, { ai_enabled: true }));
    expect(await screen.findByRole("button", { name: /^Sugerir com IA \(1\)/ })).toBeTruthy();
  });

  it("does not ask while the project is read-only", async () => {
    const o = await openImport({ ai: true });
    await importFiles(o, [file(NUBANK_CARD_CSV, "fatura.csv")]);
    o.workspace.setReadOnly(true);
    await waitFor(() => {
      const button = screen.queryByRole("button", { name: /^Sugerir com IA/ }) as HTMLButtonElement | null;
      if (button) expect(button.disabled).toBe(true);
    });
  });
});
