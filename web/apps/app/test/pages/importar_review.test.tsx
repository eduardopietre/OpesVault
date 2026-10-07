/**
 * Importar e revisar, conference side: the account of the document, the category of each item and the rule
 * offered after a hand-picked category, approving (one item with a reason, the ready ones, a total that does not
 * match), correcting, rejecting, duplicates linked as evidence, reading again with another layout and the
 * keyboard. Every action that changes the project is one undo step and one undo reverts it.
 */
import { importing, type Id } from "@opesvault/domain";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { BANK_OFX } from "../../../../packages/domain/src/demo_docs/index.ts";
import { PROTECTED_PDF_PASSWORD, protectedPdf } from "../../e2e/protected_pdf.ts";
import {
  batches,
  file,
  importFiles,
  itemsOf,
  itemsTable,
  lastBatch,
  openImport,
  pickItem,
  rowWith,
  type Opened,
} from "./importar_harness.tsx";
import { type User, choose, dialog, menu } from "../dom.ts";
import { fakePdfRender } from "./importar_pdf_mock.ts";
import { categoryNamed, accountNamed } from "../lookup.ts";

vi.mock("../../src/data/pdf_render.ts", async () =>
  fakePdfRender(await vi.importActual<typeof import("../../src/data/pdf_render.ts")>("../../src/data/pdf_render.ts")),
);

const { ItemStatus, BatchStatus } = importing.importModel;
const bytes = (text: string) => new TextEncoder().encode(text);

const demoBatch = (o: Opened) => batches(o)[0]!;
const item = (o: Opened, description: string, batchId: Id = demoBatch(o).id) =>
  itemsOf(o, batchId).find((i) => i.description === description)!;
const operations = (o: Opened) => o.ledger.operations.size;

const button = (name: string) => screen.getByRole("button", { name }) as HTMLButtonElement;
const field = (scope: HTMLElement, label: string | RegExp) => within(scope).getByLabelText(label) as HTMLInputElement;

async function type(user: User, input: HTMLElement, text: string) {
  await user.clear(input);
  if (text) await user.type(input, text);
}

describe("Importar e revisar: conta ou cartão do documento", () => {
  it("chooses the account of a document that came without one, and one undo takes the choice back", async () => {
    const o = await openImport();
    await importFiles(o, [file(BANK_OFX, "extrato.ofx")]);
    const batch = lastBatch(o);
    expect(batch.account_id).toBeNull();
    // approving without an account is refused with the domain's message
    const before = operations(o);
    await o.user.click(button("Aprovar prontos"));
    expect(await screen.findByText("Escolha a conta ou o cartão deste documento antes de aprovar.")).toBeTruthy();
    expect(operations(o)).toBe(before);
    const steps = o.workspace.undoStack.undoLabel();
    await choose(o.user, /^Conta ou cartão/, "Banco A");
    const chosen = importing.pipeline.batches(o.ledger).get(batch.id)!.account_id;
    expect(o.ledger.accounts.get(chosen as Id)?.name).toBe("Banco A");
    o.workspace.undo();
    expect(importing.pipeline.batches(o.ledger).get(batch.id)!.account_id).toBeNull();
    expect(o.workspace.undoStack.undoLabel()).toBe(steps);
  });

  it("does not let a document with approved items change account", async () => {
    const o = await openImport();
    await importFiles(o, [file(BANK_OFX, "extrato.ofx")]);
    await choose(o.user, /^Conta ou cartão/, "Banco A");
    await pickItem(o, "PIX ALUGUEL");
    await o.user.click(button("Aprovar selecionado"));
    const reason = await dialog("Aprovação parcial");
    await type(o.user, field(reason, /Motivo/), "Só o aluguel");
    await o.user.click(within(reason).getByRole("button", { name: "Aprovar" }));
    await waitFor(() => expect(item(o, "PIX ALUGUEL", lastBatch(o).id).status).toBe(ItemStatus.APPROVED));
    await choose(o.user, /^Conta ou cartão/, "Poupança");
    expect(await screen.findByText("Lote com itens aprovados não pode mudar de conta.")).toBeTruthy();
  });
});

describe("Importar e revisar: categoria de cada item e regras", () => {
  it("sets a category by hand, offers a rule right then and creates it from the item", async () => {
    const o = await openImport();
    const loja = item(o, "Loja Eletro");
    expect(loja.target_account_id).toBeNull();
    const lazer = categoryNamed(o.ledger, "Lazer");
    await choose(o.user, "Categoria ou conta de Loja Eletro", "Lazer");
    expect(importing.pipeline.items(o.ledger).get(loja.id)!.target_account_id).toBe(lazer.id);
    expect(importing.pipeline.items(o.ledger).get(loja.id)!.suggestion_source).toBeNull();
    // the moment a rule saves time
    expect(await screen.findByText(/Usar sempre “Lazer” para descrições com “/)).toBeTruthy();
    const rules = importing.rules.rules(o.ledger).size;
    await o.user.click(screen.getByRole("button", { name: "Criar regra…" }));
    const rule = await dialog("Regra de categoria");
    expect((field(rule, /A descrição contém/) as HTMLInputElement).value.toLowerCase()).toContain("loja");
    await o.user.click(within(rule).getByRole("button", { name: "Criar regra" }));
    await waitFor(() => expect(importing.rules.rules(o.ledger).size).toBe(rules + 1));
    expect(await screen.findByText(/Regra criada\. \d+ item\(ns\) pendente\(s\) recategorizado\(s\)\./)).toBeTruthy();
    const created = [...importing.rules.rules(o.ledger).values()].at(-1)!;
    expect(created.target_account_id).toBe(lazer.id);
    // the rule came from this item
    o.workspace.undo();
    expect(importing.rules.rules(o.ledger).size).toBe(rules);
    // and one more undo takes the category back
    o.workspace.undo();
    expect(importing.pipeline.items(o.ledger).get(loja.id)!.target_account_id).toBeNull();
  });

  it("lets the person say 'not now' to the rule offer and go back to the default category", async () => {
    const o = await openImport();
    const rules = importing.rules.rules(o.ledger).size;
    await choose(o.user, "Categoria ou conta de Loja Eletro", "Lazer");
    await o.user.click(await screen.findByRole("button", { name: "Agora não" }));
    await waitFor(() => expect(screen.queryByText(/Usar sempre “Lazer”/)).toBeNull());
    expect(importing.rules.rules(o.ledger).size).toBe(rules);
    await choose(o.user, "Categoria ou conta de Loja Eletro", "(padrão)");
    expect(item(o, "Loja Eletro").target_account_id).toBeNull();
  });

  it("offers a counterpart account for a bank outflow, and no rule for it: only categories become rules", async () => {
    const o = await openImport();
    await importFiles(o, [file(BANK_OFX, "extrato.ofx")]);
    // a card purchase can only go to a category; a bank outflow also to another of the person's accounts
    await choose(o.user, "Categoria ou conta de PIX ALUGUEL", /↔ Poupança/);
    const aluguel = itemsOf(o, lastBatch(o).id).find((i) => i.description === "PIX ALUGUEL")!;
    expect(aluguel.target_account_id).toBe(accountNamed(o.ledger, "Poupança").id);
    expect(screen.queryByText(/Usar sempre/)).toBeNull();
    o.workspace.undo();
    expect(itemsOf(o, lastBatch(o).id).find((i) => i.description === "PIX ALUGUEL")!.target_account_id).not.toBe(
      aluguel.target_account_id,
    );
  });

  it("creates a rule from the selected item with the menu, and asks for an item when none is selected", async () => {
    const o = await openImport();
    await menu(o.user, "Mais", /^Criar regra a partir do item…/);
    expect(await screen.findByText("Selecione um item para criar a regra a partir dele.")).toBeTruthy();
    await pickItem(o, "Loja Eletro");
    const rules = importing.rules.rules(o.ledger).size;
    await menu(o.user, "Mais", /^Criar regra a partir do item…/);
    const rule = await dialog("Regra de categoria");
    expect(field(rule, /A descrição contém/).value.toLowerCase()).toContain("loja");
    await choose(o.user, "Categoria", "Despesa: Lazer");
    await o.user.click(within(rule).getByRole("button", { name: "Criar regra" }));
    await waitFor(() => expect(importing.rules.rules(o.ledger).size).toBe(rules + 1));
    o.workspace.undo();
    expect(importing.rules.rules(o.ledger).size).toBe(rules);
  });
});

describe("Importar e revisar: aprovar", () => {
  it("approves one item with a reason (a partial approval) and one undo reverts everything it did", async () => {
    const o = await openImport();
    const before = operations(o);
    await pickItem(o, "Loja Eletro");
    // giving up on the reason changes nothing
    await o.user.click(button("Aprovar selecionado"));
    const ask = await dialog("Aprovação parcial");
    await o.user.click(within(ask).getByRole("button", { name: "Cancelar" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Aprovação parcial" })).toBeNull());
    expect(operations(o)).toBe(before);
    // an empty reason is refused inside the dialog
    await o.user.click(button("Aprovar selecionado"));
    const again = await dialog("Aprovação parcial");
    await o.user.click(within(again).getByRole("button", { name: "Aprovar" }));
    expect(await within(again).findByText("O motivo é obrigatório.")).toBeTruthy();
    await type(o.user, field(again, /Motivo/), "Conferi só a loja");
    await o.user.click(within(again).getByRole("button", { name: "Aprovar" }));
    await waitFor(() => expect(operations(o)).toBe(before + 1));
    const approved = item(o, "Loja Eletro");
    expect(approved.status).toBe(ItemStatus.APPROVED);
    expect(approved.operation_id).not.toBeNull();
    const batch = importing.pipeline.batches(o.ledger).get(demoBatch(o).id)!;
    expect(batch.status).toBe(BatchStatus.PARTIAL);
    expect(batch.partial_reason).toBe("Conferi só a loja");
    expect(await screen.findByText("1 operação(ões) criada(s), 0 evidência(s) vinculada(s).")).toBeTruthy();
    // the review moved on to the next item
    expect(rowWith(await itemsTable(), "Amazon.com").getAttribute("aria-selected")).toBe("true");
    o.workspace.undo();
    expect(operations(o)).toBe(before);
    expect(item(o, "Loja Eletro").status).toBe(ItemStatus.READY);
    expect(importing.pipeline.batches(o.ledger).get(batch.id)!.partial_reason).toBeNull();
  });

  it("approves every ready item at once; the document becomes approved and one undo reopens it", async () => {
    const o = await openImport();
    const before = operations(o);
    const open = itemsOf(o, demoBatch(o).id).length;
    await o.user.click(button("Aprovar prontos"));
    await waitFor(() => expect(operations(o)).toBe(before + open));
    expect(importing.pipeline.batches(o.ledger).get(demoBatch(o).id)!.status).toBe(BatchStatus.APPROVED);
    expect(await screen.findByText(`${open} operação(ões) criada(s), 0 evidência(s) vinculada(s).`)).toBeTruthy();
    expect(button("Aprovar prontos").disabled).toBe(true);
    expect(itemsOf(o, demoBatch(o).id).every((i) => i.status === ItemStatus.APPROVED)).toBe(true);
    // the notice offers the undo
    await o.user.click(await screen.findByRole("button", { name: "Desfazer" }));
    await waitFor(() => expect(operations(o)).toBe(before));
    expect(importing.pipeline.batches(o.ledger).get(demoBatch(o).id)!.status).toBe(BatchStatus.IN_REVIEW);
  });

  it("takes the person from an approved item to its operation in the Livro", async () => {
    const o = await openImport();
    await o.user.click(button("Aprovar prontos"));
    await waitFor(() => expect(button("Aprovar prontos").disabled).toBe(true));
    const id = await pickItem(o, "Padaria");
    const operation = importing.pipeline.items(o.ledger).get(id)!.operation_id!;
    await o.user.click(screen.getByRole("button", { name: "Ver no Livro" }));
    expect(await screen.findByRole("heading", { level: 1, name: "Livro financeiro" })).toBeTruthy();
    expect(o.router.state.location.pathname).toBe("/livro");
    expect(o.ledger.operations.has(operation)).toBe(true);
  });

  it("asks for a reason when the total of the document does not match, and records it", async () => {
    const o = await openImport();
    // a correction that makes the items disagree with the total printed in the document
    await pickItem(o, "Padaria");
    await o.user.click(button("Corrigir…"));
    const fix = await dialog("Corrigir item");
    await type(o.user, field(fix, "Valor"), "650,00");
    await type(o.user, field(fix, /Motivo/), "Vi errado");
    await o.user.click(within(fix).getByRole("button", { name: "Corrigir" }));
    await waitFor(() =>
      expect(
        importing.pipeline
          .batches(o.ledger)
          .get(demoBatch(o).id)!
          .reconciliations.some((r) => r.ok === false),
      ).toBe(true),
    );
    expect(await screen.findByText(/total divergente/)).toBeTruthy();
    const before = operations(o);
    await o.user.click(button("Aprovar prontos"));
    const ask = await dialog("Total divergente — aceitar como pendência documentada");
    await type(o.user, field(ask, /Motivo/), "Fatura com centavos de ajuste");
    await o.user.click(within(ask).getByRole("button", { name: "Aceitar e aprovar" }));
    await waitFor(() => expect(operations(o)).toBeGreaterThan(before));
    expect(importing.pipeline.batches(o.ledger).get(demoBatch(o).id)!.warnings.join(" ")).toContain(
      "Divergência aceita: Fatura com centavos de ajuste",
    );
  });
});

describe("Importar e revisar: corrigir e rejeitar", () => {
  it("corrects the description, the amount and the date with a reason; one undo restores them", async () => {
    const o = await openImport();
    const padaria = item(o, "Padaria");
    await pickItem(o, "Padaria");
    await o.user.click(button("Corrigir…"));
    const fix = await dialog("Corrigir item");
    // nothing to correct, a negative amount, no reason: each refused with its own message
    await type(o.user, field(fix, /Motivo/), "x");
    await o.user.click(within(fix).getByRole("button", { name: "Corrigir" }));
    expect(await within(fix).findByText("Nenhum campo foi alterado.")).toBeTruthy();
    await type(o.user, field(fix, "Valor"), "-5,00");
    await o.user.click(within(fix).getByRole("button", { name: "Corrigir" }));
    expect(await within(fix).findByText("Informe o valor sem sinal; o tipo indica a direção.")).toBeTruthy();
    await type(o.user, field(fix, "Valor"), "512,34");
    await type(o.user, field(fix, /Motivo/), "");
    await o.user.click(within(fix).getByRole("button", { name: "Corrigir" }));
    expect(await within(fix).findByText("Informe o motivo da correção.")).toBeTruthy();
    await type(o.user, field(fix, /Descrição/), "Padaria Pão Quente");
    await type(o.user, field(fix, /Motivo/), "Nome na nota");
    await o.user.click(within(fix).getByRole("button", { name: "Corrigir" }));
    await waitFor(() => expect(item(o, "Padaria Pão Quente")).toBeTruthy());
    const done = importing.pipeline.items(o.ledger).get(padaria.id)!;
    expect(done.amount?.toString()).toBe("512.34");
    expect(done.corrections.map((c) => c.field).sort()).toEqual(["amount", "description"]);
    expect(done.corrections.every((c) => c.reason === "Nome na nota")).toBe(true);
    o.workspace.undo();
    const back = importing.pipeline.items(o.ledger).get(padaria.id)!;
    expect(back.description).toBe("Padaria");
    expect(back.amount?.toString()).toBe("500.00");
    expect(back.corrections).toHaveLength(0);
  });

  it("leaves an unknown date unknown and keeps a date the person informs", async () => {
    const o = await openImport();
    await pickItem(o, "Padaria");
    await o.user.click(button("Corrigir…"));
    const fix = await dialog("Corrigir item");
    await o.user.click(within(fix).getByRole("checkbox", { name: /Data: informada/ }));
    await type(o.user, field(fix, /Motivo/), "Sem data no original");
    await o.user.click(within(fix).getByRole("button", { name: "Corrigir" }));
    await waitFor(() => expect(item(o, "Padaria").occurred_on).toBeNull());
    expect(item(o, "Padaria").status).toBe(ItemStatus.NEEDS_REVIEW);
    // an item with an unknown date cannot be approved: the domain says so
    await o.user.click(button("Aprovar prontos"));
    expect(await screen.findByText(/precisam de revisão/)).toBeTruthy();
  });

  it("rejects an item with a reason, moves on to the next one and one undo brings it back", async () => {
    const o = await openImport();
    await pickItem(o, "Amazon.com");
    await menu(o.user, "Mais", /^Rejeitar item…/);
    const ask = await dialog("Rejeitar item");
    await o.user.click(within(ask).getByRole("button", { name: "Rejeitar" }));
    expect(await within(ask).findByText("O motivo é obrigatório.")).toBeTruthy();
    await type(o.user, field(ask, /Motivo/), "Compra que não é nossa");
    await o.user.click(within(ask).getByRole("button", { name: "Rejeitar" }));
    await waitFor(() => expect(item(o, "Amazon.com").status).toBe(ItemStatus.REJECTED));
    expect(rowWith(await itemsTable(), "Amazon.com").textContent).toContain("Rejeitado");
    o.workspace.undo();
    expect(item(o, "Amazon.com").status).toBe(ItemStatus.READY);
  });
});

describe("Importar e revisar: já registrados", () => {
  /** An OFX approved, then the same transactions in another file: the second is full of duplicates. */
  async function withDuplicates() {
    const o = await openImport();
    await importFiles(o, [file(BANK_OFX, "extrato.ofx")]);
    await choose(o.user, /^Conta ou cartão/, "Banco A");
    await o.user.click(button("Aprovar prontos"));
    await waitFor(() => expect(button("Aprovar prontos").disabled).toBe(true));
    const copy = new Uint8Array([...BANK_OFX, ...bytes("\n")]);
    await importFiles(o, [file(copy, "extrato-de-novo.ofx")]);
    const batch = lastBatch(o);
    await choose(o.user, /^Conta ou cartão/, "Banco A");
    return { o, batch };
  }

  it("marks what is already in the book, and approving only links the evidence", async () => {
    const { o, batch } = await withDuplicates();
    const items = itemsOf(o, batch.id);
    expect(items.every((i) => i.status === ItemStatus.DUPLICATE)).toBe(true);
    expect(rowWith(await itemsTable(), "PIX ALUGUEL").textContent).toContain("Já registrado");
    expect(rowWith(await itemsTable(), "PIX ALUGUEL").textContent).toContain(
      "já existe no livro: aprovar só vincula a evidência",
    );
    const before = operations(o);
    await o.user.click(button("Aprovar prontos"));
    expect(await screen.findByText("0 operação(ões) criada(s), 2 evidência(s) vinculada(s).")).toBeTruthy();
    expect(operations(o)).toBe(before);
    o.workspace.undo();
    expect(itemsOf(o, batch.id).every((i) => i.status === ItemStatus.DUPLICATE)).toBe(true);
  });

  it("keeps a repeated item as a separate entry, with a reason", async () => {
    const { o, batch } = await withDuplicates();
    await pickItem(o, "PIX ALUGUEL");
    await menu(o.user, "Mais", /^Manter separado…/);
    const ask = await dialog("Manter como lançamento separado");
    await type(o.user, field(ask, /Motivo/), "Dois aluguéis mesmo");
    await o.user.click(within(ask).getByRole("button", { name: "Manter separado" }));
    await waitFor(() =>
      expect(itemsOf(o, batch.id).find((i) => i.description === "PIX ALUGUEL")!.status).toBe(ItemStatus.READY),
    );
    o.workspace.undo();
    expect(itemsOf(o, batch.id).find((i) => i.description === "PIX ALUGUEL")!.status).toBe(ItemStatus.DUPLICATE);
  });

  it("offers 'Manter separado' only for an item that is already in the book", async () => {
    const o = await openImport();
    await pickItem(o, "Padaria");
    await o.user.click(button("Mais"));
    const entry = await screen.findByRole("menuitem", { name: /^Manter separado…/ });
    expect(entry.getAttribute("aria-disabled") ?? entry.getAttribute("data-disabled")).not.toBeNull();
  });
});

describe("Importar e revisar: ler de novo com outro layout", () => {
  const AMBIGUOUS = bytes(
    "date,title,amount,Data,Valor,Identificador,Descrição\n2026-02-03,Uber Trip,23.45,03/02/2026,-23.45,id-1,Uber Trip\n",
  );

  it("asks which layout when two recognize the document, reads it again and one undo restores the question", async () => {
    const o = await openImport();
    await importFiles(o, [file(AMBIGUOUS, "dois-layouts.csv")]);
    const batch = lastBatch(o);
    expect(batch.status).toBe(BatchStatus.AMBIGUOUS);
    expect(batch.candidates.length).toBeGreaterThan(1);
    expect((await screen.findAllByText(/Mais de um layout reconhece este documento/)).length).toBeGreaterThan(0);
    // only layouts that read a CSV are offered
    await o.user.click(screen.getByRole("combobox", { name: "Layout" }));
    const options = await screen.findAllByRole("option");
    expect(options.every((option) => /csv/i.test(option.textContent ?? ""))).toBe(true);
    await o.user.click(await screen.findByRole("option", { name: /nubank-cartao-csv/ }));
    await o.user.click(screen.getByRole("button", { name: "Usar layout" }));
    await waitFor(() => expect(lastBatch(o).status).toBe(BatchStatus.IN_REVIEW), { timeout: 20_000 });
    expect(lastBatch(o).parser_id).toBe("nubank-cartao-csv");
    expect(batches(o).some((b) => b.id === batch.id)).toBe(false);
    expect(itemsOf(o, lastBatch(o).id)).toHaveLength(1);
    expect(o.worker.received.at(-1)).toMatchObject({ parser_id: "nubank-cartao-csv", name: "dois-layouts.csv" });
    expect(screen.queryByRole("combobox", { name: "Layout" })).toBeNull();
    o.workspace.undo();
    expect(batches(o).some((b) => b.id === batch.id && b.status === BatchStatus.AMBIGUOUS)).toBe(true);
  });

  it("explains a layout that cannot read the document and keeps it for another try", async () => {
    const o = await openImport();
    await importFiles(o, [file(bytes("a;b\n1;2\n"), "estranho.csv")]);
    const batch = lastBatch(o);
    await o.user.click(screen.getByRole("combobox", { name: "Layout" }));
    await o.user.click(await screen.findByRole("option", { name: /nubank-cartao-csv/ }));
    await o.user.click(screen.getByRole("button", { name: "Usar layout" }));
    await waitFor(() => expect(o.worker.received.length).toBe(2), { timeout: 20_000 });
    // whatever the layout made of it, the old batch is replaced only by a batch of the same document
    await waitFor(() => expect(batches(o).filter((b) => b.document_id === batch.document_id)).toHaveLength(1));
  });

  it("asks the password again to read a protected PDF with another layout, and does not keep it", async () => {
    const o = await openImport();
    await o.user.upload(screen.getByLabelText("Escolher os arquivos para importar"), [
      file(protectedPdf(), "protegido.pdf"),
    ]);
    const first = await screen.findByRole("dialog", { name: "PDF protegido" });
    await type(o.user, within(first).getByLabelText(/Senha do PDF/), PROTECTED_PDF_PASSWORD);
    await o.user.click(within(first).getByRole("button", { name: "Importar" }));
    await waitFor(() => expect(lastBatch(o).status).toBe(BatchStatus.UNSUPPORTED), { timeout: 20_000 });
    const sent = o.worker.received.length;
    await o.user.click(screen.getByRole("combobox", { name: "Layout" }));
    await o.user.click(await screen.findByRole("option", { name: /nubank-cartao-pdf/ }));
    await o.user.click(screen.getByRole("button", { name: "Usar layout" }));
    const second = await screen.findByRole("dialog", { name: "PDF protegido" });
    await type(o.user, within(second).getByLabelText(/Senha do PDF/), PROTECTED_PDF_PASSWORD);
    await o.user.click(within(second).getByRole("button", { name: "Importar" }));
    await waitFor(() => expect(o.worker.received.length).toBe(sent + 2), { timeout: 20_000 });
    // the first try of the second reading had no password: it is asked, never remembered
    expect(o.worker.received.at(-2)).toMatchObject({ password: null, parser_id: "nubank-cartao-pdf" });
    expect(o.worker.received.at(-1)).toMatchObject({ password: PROTECTED_PDF_PASSWORD });
  });
});

describe("Importar e revisar: teclado", () => {
  it("F2 corrects, Delete rejects and Ctrl+Enter approves the selected item", async () => {
    const o = await openImport();
    await pickItem(o, "Padaria");
    const grid = (await itemsTable()) as HTMLElement;
    grid.focus();
    fireEvent.keyDown(grid, { key: "F2" });
    const fix = await dialog("Corrigir item");
    await o.user.click(within(fix).getByRole("button", { name: "Cancelar" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Corrigir item" })).toBeNull());
    fireEvent.keyDown(grid, { key: "Delete" });
    const reject = await dialog("Rejeitar item");
    await o.user.click(within(reject).getByRole("button", { name: "Cancelar" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Rejeitar item" })).toBeNull());
    fireEvent.keyDown(grid, { key: "Enter", ctrlKey: true });
    await dialog("Aprovação parcial");
    // Found by the keyboard-only e2e: the grid read Ctrl+Enter as a plain Enter too, and opened the correction
    // of the row under the approval's dialog. Only the approval opens.
    expect(screen.queryByRole("dialog", { name: "Corrigir item" })).toBeNull();
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
  });

  it("C opens the category of the selected item", async () => {
    const o = await openImport();
    await pickItem(o, "Loja Eletro");
    const grid = (await itemsTable()) as HTMLElement;
    grid.focus();
    fireEvent.keyDown(grid, { key: "c" });
    expect(await screen.findByRole("option", { name: "Lazer" })).toBeTruthy();
  });

  it("asks to select an item when a command needs one", async () => {
    await openImport();
    expect(button("Aprovar selecionado").disabled).toBe(true);
    expect(button("Corrigir…").disabled).toBe(true);
  });
});
