/**
 * The Livro's local AI (review with the conference list) and the CSV export. Companion of `livro.test.tsx`.
 */
import { dom, exporting, type Id } from "@opesvault/domain";
import { screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { setAiTransport } from "../../src/data/ai.ts";
import { operationsCsv } from "../../src/pages/livro/export.ts";
import { FakeOllama } from "./fake_ollama.ts";
import { grid, openLivro, opByDescription, rowsWith, type Opened } from "./livro_harness.tsx";
import { categoryNamed } from "../lookup.ts";
import { choose, dialog, menu, submit } from "../dom.ts";

afterEach(() => setAiTransport(null));

/** The file as text, with its byte-order mark kept (the spreadsheets of Excel need it). */
const decode = (bytes: Uint8Array) => new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes);

const inCategory = (o: Opened, id: Id) =>
  [...o.workspace.ledger.operations.values()].filter((op) => op.postings.some((p) => p.account_id === id)).length;

describe("Livro: IA local", () => {
  it("offers the AI only when the project has it on", async () => {
    const o = await openLivro();
    expect(screen.getByRole("button", { name: "IA local" })).toBeTruthy();
    o.workspace.act((l) => dom.settings.updateSettings(l, { ai_enabled: false }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "IA local" })).toBeNull());
  });

  it("suggests categories, lists the differences for review and reclassifies only the checked ones", async () => {
    const fake = new FakeOllama();
    fake.smart("Lazer");
    setAiTransport(fake.transport);
    const o = await openLivro();
    const lazer = categoryNamed(o.ledger, "Lazer").id;
    const before = inCategory(o, lazer);
    const steps = o.workspace.undoStack.undoLabel();
    await menu(o.user, "IA local", "Sugerir categorias…");
    const d = await dialog("Sugestões de categoria");
    expect(within(d).getByText(/A IA local \(gemma4:12b\) sugere outra categoria/)).toBeTruthy();
    const table = within(d).getByRole("table");
    expect(within(table).getByText("Aluguel")).toBeTruthy();
    // nothing changed before the person applies
    expect(inCategory(o, lazer)).toBe(before);
    // keep only Aluguel
    await o.user.click(within(d).getByRole("button", { name: "Desmarcar todas" }));
    await submit(o.user, d, "Reclassificar marcadas");
    expect(await within(d).findByText("Marque ao menos uma sugestão, ou feche sem aplicar.")).toBeTruthy();
    await o.user.click(within(d).getByRole("checkbox", { name: "Aluguel" }));
    const lines = within(table).getAllByRole("row").length - 1;
    expect(within(d).getByText(`1 de ${lines} marcada(s)`)).toBeTruthy();
    await submit(o.user, d, "Reclassificar marcadas");
    await waitFor(() => expect(inCategory(o, lazer)).toBe(before + 3));
    const rent = [...o.workspace.ledger.operations.values()].find((op) => op.description === "Aluguel")!;
    expect(o.workspace.ledger.historyOf(rent.id).at(-1)?.reason).toMatch(
      /^Sugestão da IA local conferida na revisão \(ollama:gemma4:12b/,
    );
    // only descriptions and category names went to the model, never an amount
    expect(JSON.stringify(fake.received)).not.toMatch(/\d+[.,]\d{2}/);
    o.workspace.undo();
    expect(inCategory(o, lazer)).toBe(before);
    expect(o.workspace.undoStack.undoLabel()).toBe(steps);
  });

  it("works on the ticked operations when two or more are ticked", async () => {
    const fake = new FakeOllama();
    fake.smart("Lazer");
    setAiTransport(fake.transport);
    const o = await openLivro();
    for (const row of rowsWith("Aluguel").slice(0, 2)) await o.user.click(within(row).getByRole("checkbox"));
    await menu(o.user, "IA local", "Sugerir categorias…");
    const d = await dialog("Sugestões de categoria");
    expect(within(d).getByText(/2 lançamentos selecionados/)).toBeTruthy();
  });

  it("suggests readable merchant names, lets the person adjust one and approves them", async () => {
    const fake = new FakeOllama();
    fake.smart("Lazer");
    setAiTransport(fake.transport);
    const o = await openLivro();
    await menu(o.user, "IA local", "Sugerir nomes de estabelecimentos…");
    const d = await dialog("Nomes de estabelecimentos");
    const field = within(d).getByLabelText("Nome sugerido para Posto Shell");
    expect((field as HTMLInputElement).value).toBe("Posto Online");
    await o.user.clear(field);
    await o.user.type(field, "Posto Shell Centro");
    await submit(o.user, d, "Aprovar marcados");
    await waitFor(() => expect(dom.merchants.merchantOf(o.workspace.ledger, "Posto Shell")).toBe("Posto Shell Centro"));
    expect(dom.merchants.merchantOf(o.workspace.ledger, "Padaria Real")).toBe("Padaria Online");
    // the bank's description is kept
    expect(opByDescription(o.workspace, "Posto Shell").length).toBeGreaterThan(0);
    const alias = [...dom.merchants.aliases(o.workspace.ledger).values()].find((a) => a.name === "Posto Shell Centro")!;
    expect(o.workspace.ledger.historyOf(alias.id).at(-1)?.reason ?? "").toMatch(/sugestão ollama:gemma4:12b/);
    o.workspace.undo();
    expect(dom.merchants.merchantOf(o.workspace.ledger, "Posto Shell")).not.toBe("Posto Shell Centro");
  });

  it("refuses a name left empty in the review", async () => {
    const fake = new FakeOllama();
    fake.smart("Lazer");
    setAiTransport(fake.transport);
    const o = await openLivro();
    await menu(o.user, "IA local", "Sugerir nomes de estabelecimentos…");
    const d = await dialog("Nomes de estabelecimentos");
    await o.user.clear(within(d).getByLabelText("Nome sugerido para Posto Shell"));
    await submit(o.user, d, "Aprovar marcados");
    expect(await within(d).findByText("Um nome marcado ficou vazio.")).toBeTruthy();
  });

  it("says what to do when Ollama is off, and changes nothing", async () => {
    setAiTransport(() => Promise.reject(new TypeError("fetch failed")));
    const o = await openLivro();
    const label = o.workspace.undoStack.undoLabel();
    await menu(o.user, "IA local", "Sugerir categorias…");
    const alert = await screen.findByRole("alertdialog", { name: "IA local" });
    expect(within(alert).getByText("Ollama indisponível.")).toBeTruthy();
    expect(o.workspace.undoStack.undoLabel()).toBe(label);
  });

  it("shows progress and lets the person cancel the run", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const fake = new FakeOllama();
    fake.smart("Lazer");
    setAiTransport(async (url, init) => {
      if (url.endsWith("/api/version")) await gate; // the model is "loading"
      return fake.transport(url, init);
    });
    const o = await openLivro();
    await menu(o.user, "IA local", "Sugerir categorias…");
    expect(await screen.findByRole("progressbar", { name: "Progresso da IA local" })).toBeTruthy();
    await o.user.click(screen.getByRole("button", { name: "Cancelar" }));
    expect(await screen.findByText("Cancelando ao fim do lote atual…")).toBeTruthy();
    release();
    expect(await screen.findByText(/consulta cancelada antes do fim/)).toBeTruthy();
    expect(screen.queryByRole("progressbar")).toBeNull();
  });
});

// ── export ───────────────────────────────────────

describe("Livro: exportar CSV", () => {
  async function captureDownload(act: () => Promise<void>): Promise<string | null> {
    const blobs: Blob[] = [];
    const original = URL.createObjectURL;
    const revoke = URL.revokeObjectURL;
    const click = HTMLAnchorElement.prototype.click;
    URL.createObjectURL = (blob: Blob | MediaSource) => {
      blobs.push(blob as Blob);
      return "blob:livro";
    };
    URL.revokeObjectURL = () => undefined;
    HTMLAnchorElement.prototype.click = () => undefined;
    try {
      await act();
      return blobs.length ? decode(new Uint8Array(await blobs[0]!.arrayBuffer())) : null;
    } finally {
      URL.createObjectURL = original;
      URL.revokeObjectURL = revoke;
      HTMLAnchorElement.prototype.click = click;
    }
  }

  it("asks before leaving the project's protection, then offers the whole book as the domain exports it", async () => {
    const o = await openLivro();
    const text = await captureDownload(async () => {
      await menu(o.user, "Exportar", "Livro completo (CSV)");
      const ask = await screen.findByRole("alertdialog", { name: "Exportar sem criptografia?" });
      expect(within(ask).getAllByText(/sem criptografia/).length).toBeGreaterThan(0);
      await o.user.click(within(ask).getByRole("button", { name: "Exportar CSV" }));
      await screen.findByText(/Arquivo CSV gerado/);
    });
    expect(text).toBe(decode(exporting.ledgerCsv(o.workspace.ledger)));
    expect(text!.split("\n")[0]).toContain("operacao_id;versao;situacao");
  });

  it("exports only the operations the filters show", async () => {
    const o = await openLivro();
    await choose(o.user, "Conta ou categoria", "Categoria: Moradia");
    await waitFor(() => expect(grid().querySelectorAll("[data-row-id]").length).toBe(3));
    const text = await captureDownload(async () => {
      await menu(o.user, "Exportar", "Lançamentos exibidos (CSV)");
      await o.user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Exportar CSV" }));
      await screen.findByText(/Arquivo CSV gerado/);
    });
    const lines = text!.trim().split("\n").slice(1);
    expect(lines.length).toBe(6); // three operations, two postings each
    expect(lines.every((l) => l.includes(";Aluguel;"))).toBe(true);
  });

  it("does nothing when the person cancels", async () => {
    const o = await openLivro();
    const text = await captureDownload(async () => {
      await menu(o.user, "Exportar", "Livro completo (CSV)");
      await o.user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Cancelar" }));
    });
    expect(text).toBeNull();
  });

  it("the filtered export has the domain's format for the same operations", async () => {
    const o = await openLivro();
    const all = [...o.workspace.ledger.operations.values()];
    expect(decode(operationsCsv(o.workspace.ledger, all))).toBe(decode(exporting.ledgerCsv(o.workspace.ledger)));
  });
});
