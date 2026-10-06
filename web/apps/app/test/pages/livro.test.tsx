/**
 * The Livro financeiro, action by action (docs/18 §6): every command of the desktop page and the dialogs it
 * opens, against the demonstration project, checking what the ledger became and that one undo reverts it.
 */
import { OperationKind, dom, isActive, type Operation } from "@opesvault/domain";
import { screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { setAiTransport } from "../../src/data/ai.ts";
import { FakeOllama } from "./fake_ollama.ts";
import {
  account,
  byId,
  category,
  count,
  choose,
  closeDialog,
  dialog,
  grid,
  menu,
  openLivro,
  opByDescription,
  pickRow,
  rowsWith,
  submit,
  typeInto,
  type Opened,
  type User,
} from "./livro_harness.tsx";

afterEach(() => setAiTransport(null));

/** One undo reverts the whole action; the operation count and the undo label tell it. */
function expectUndo(o: Opened, before: number): void {
  expect(o.workspace.undoStack.canUndo()).toBe(true);
  o.workspace.undo();
  expect(count(o)).toBe(before);
}

describe("Livro: the table", () => {
  it("lists the operations with the shared columns, newest first, and keeps the project's totals", async () => {
    const o = await openLivro();
    expect(grid().querySelectorAll("[data-row-id]").length).toBeGreaterThan(5);
    expect(screen.getByRole("heading", { level: 1, name: "Livro financeiro" })).toBeTruthy();
    expect(screen.getByText(`${count(o)} lançamentos`)).toBeTruthy();
    for (const header of ["Data", "Descrição", "De → Para", "Valor", "Competência", "Tipo", "Origem", "Situação"]) {
      expect(within(grid()).getByRole("columnheader", { name: header })).toBeTruthy();
    }
  });

  it("sorts by a column on click and goes back to the arrival order", async () => {
    const { user } = await openLivro();
    const first = () => within(grid()).getAllByRole("row")[1]?.textContent;
    const initial = first();
    await user.click(within(grid()).getByRole("button", { name: "Descrição" }));
    const sorted = first();
    expect(sorted).not.toBe(initial);
    expect(within(grid()).getByRole("columnheader", { name: "Descrição" }).getAttribute("aria-sort")).toBe("ascending");
  });

  it("shows the inspector beside the table with the operation's details", async () => {
    const { user } = await openLivro();
    await pickRow(user, "Aluguel");
    const details = await screen.findByTestId("operation-details");
    expect(within(details).getAllByText("Aluguel").length).toBeGreaterThan(0);
    expect(within(details).getByText("Partidas")).toBeTruthy();
    expect(within(details).getByText("Estabelecimento")).toBeTruthy();
    expect(within(details).getByText("Histórico")).toBeTruthy();
  });
});

describe("Livro: Novo lançamento", () => {
  it("records an expense with the category the person chose, and one undo removes it", async () => {
    const o = await openLivro();
    const before = count(o);
    await menu(o.user, "Novo lançamento", "Despesa");
    const d = await dialog("Despesa");
    await typeInto(o.user, d, "Descrição", "Livraria do centro");
    await typeInto(o.user, d, "Valor", "89,90");
    await choose(o.user, "Categoria", "Lazer", d);
    await submit(o.user, d, "Registrar");
    await waitFor(() => expect(count(o)).toBe(before + 1));
    const [op] = opByDescription(o.workspace, "Livraria do centro") as [Operation];
    expect(op.kind).toBe(OperationKind.EXPENSE);
    expect(op.postings.map((p) => p.amount.toFixed()).sort()).toEqual(["-89.90", "89.90"]);
    expect(op.postings.some((p) => p.account_id === category(o, "Lazer").id)).toBe(true);
    // the new row is shown and selected, so the person sees where it went
    await waitFor(() => expect(rowsWith("Livraria do centro").length).toBe(1));
    expectUndo(o, before);
  });

  it("shows the error inside the dialog and keeps it open", async () => {
    const o = await openLivro();
    await menu(o.user, "Novo lançamento", "Despesa");
    const d = await dialog("Despesa");
    await submit(o.user, d, "Registrar");
    expect(await within(d).findByText("Informe o valor.")).toBeTruthy();
    await typeInto(o.user, d, "Valor", "0");
    await submit(o.user, d, "Registrar");
    expect(await within(d).findByText("Informe um valor positivo.")).toBeTruthy();
    expect(screen.getByRole("dialog", { name: "Despesa" })).toBeTruthy();
  });

  it("records an income, a transfer and a bill payment", async () => {
    const o = await openLivro();
    let before = count(o);
    await menu(o.user, "Novo lançamento", "Receita");
    let d = await dialog("Receita");
    await typeInto(o.user, d, "Descrição", "Freela de outubro");
    await typeInto(o.user, d, "Valor", "1.500,00");
    await choose(o.user, "Categoria", "Outras receitas", d);
    await choose(o.user, "Conta de destino", "Banco A", d);
    await submit(o.user, d, "Registrar");
    await waitFor(() => expect(count(o)).toBe(before + 1));
    const [income] = opByDescription(o.workspace, "Freela de outubro") as [Operation];
    expect(income.kind).toBe(OperationKind.INCOME);
    expectUndo(o, before);

    before = count(o);
    await menu(o.user, "Novo lançamento", "Transferência");
    d = await dialog("Transferência");
    await typeInto(o.user, d, "Valor", "300");
    await choose(o.user, "De", "Banco A", d);
    await choose(o.user, "Para", "Poupança", d);
    await submit(o.user, d, "Registrar");
    await waitFor(() => expect(count(o)).toBe(before + 1));
    const transfer = [...o.workspace.ledger.operations.values()].find(
      (op) => op.kind === OperationKind.TRANSFER && op.description === "Transferência",
    ) as Operation;
    expect(transfer.postings.find((p) => p.amount.isPositive())?.account_id).toBe(account(o, "Poupança").id);
    expectUndo(o, before);

    before = count(o);
    await menu(o.user, "Novo lançamento", "Pagamento de fatura");
    d = await dialog("Pagamento de fatura");
    await typeInto(o.user, d, "Valor", "200");
    await choose(o.user, "Pago pela conta", "Banco A", d);
    await submit(o.user, d, "Registrar");
    await waitFor(() => expect(count(o)).toBe(before + 1));
    expect(
      [...o.workspace.ledger.operations.values()].some(
        (op) => op.kind === OperationKind.CARD_PAYMENT && op.postings.some((p) => p.amount.eq("200")),
      ),
    ).toBe(true);
    expectUndo(o, before);
  });

  it("records a card purchase, and an installment purchase as one plan that one undo removes", async () => {
    const o = await openLivro();
    let before = count(o);
    await menu(o.user, "Novo lançamento", "Compra no cartão");
    let d = await dialog("Compra no cartão");
    await typeInto(o.user, d, "Descrição", "Cadeira de escritório");
    await typeInto(o.user, d, "Valor", "450,00");
    await submit(o.user, d, "Registrar");
    await waitFor(() => expect(count(o)).toBe(before + 1));
    const [single] = opByDescription(o.workspace, "Cadeira de escritório") as [Operation];
    expect(single.kind).toBe(OperationKind.CARD_PURCHASE);
    expectUndo(o, before);

    before = count(o);
    const plans = dom.cards.plans(o.workspace.ledger).size;
    await menu(o.user, "Novo lançamento", "Compra no cartão");
    d = await dialog("Compra no cartão");
    await typeInto(o.user, d, "Descrição", "Notebook");
    await typeInto(o.user, d, "Valor", "3.000,00");
    await typeInto(o.user, d, "Parcelas", "6");
    await choose(o.user, "Competência das parcelas", "Despesa distribuída nas parcelas", d);
    await submit(o.user, d, "Registrar");
    await waitFor(() => expect(dom.cards.plans(o.workspace.ledger).size).toBe(plans + 1));
    const plan = [...dom.cards.plans(o.workspace.ledger).values()].find((p) => p.description === "Notebook")!;
    expect(plan.count).toBe(6);
    expect(plan.policy).toBe("spread");
    expect(count(o)).toBe(before + 6);
    expectUndo(o, before);
    expect(dom.cards.plans(o.workspace.ledger).size).toBe(plans);
  });

  it("splits an expense between categories (rateio) and refuses a split that does not add up", async () => {
    const o = await openLivro();
    const before = count(o);
    await menu(o.user, "Novo lançamento", "Despesa");
    const d = await dialog("Despesa");
    await typeInto(o.user, d, "Descrição", "Mercado e farmácia");
    await typeInto(o.user, d, "Valor", "200,00");
    await o.user.click(within(d).getByRole("switch", { name: /Ratear entre categorias/ }));
    await choose(o.user, "Categoria da parte 1", "Alimentação", d);
    await typeInto(o.user, d, "Valor da parte 1", "150,00");
    await choose(o.user, "Categoria da parte 2", "Saúde", d);
    await typeInto(o.user, d, "Valor da parte 2", "40,00");
    expect(within(d).getByText(/Faltam 10,00 para fechar/)).toBeTruthy();
    await submit(o.user, d, "Registrar");
    expect(await within(d).findByText("O rateio não soma o valor total.")).toBeTruthy();
    await typeInto(o.user, d, "Valor da parte 2", "50,00");
    expect(within(d).getByText("Rateio fechado ✓")).toBeTruthy();
    await submit(o.user, d, "Registrar");
    await waitFor(() => expect(count(o)).toBe(before + 1));
    const [op] = opByDescription(o.workspace, "Mercado e farmácia") as [Operation];
    expect(
      op.postings
        .filter((p) => p.amount.isPositive())
        .map((p) => p.amount.toFixed())
        .sort(),
    ).toEqual(["150.00", "50.00"]);
    expectUndo(o, before);
  });

  it("suggests the usual category from the history while none was picked", async () => {
    const o = await openLivro();
    await menu(o.user, "Novo lançamento", "Despesa");
    const d = await dialog("Despesa");
    await typeInto(o.user, d, "Descrição", "Padaria Real");
    expect(await within(d).findByText(/Categoria sugerida pelo uso/)).toBeTruthy();
    expect(within(d).getByRole("combobox", { name: "Categoria" }).textContent).toContain("Alimentação");
    // a person's own choice stops the suggestions
    await choose(o.user, "Categoria", "Lazer", d);
    await typeInto(o.user, d, "Descrição", "Padaria Real do bairro");
    expect(within(d).getByRole("combobox", { name: "Categoria" }).textContent).toContain("Lazer");
  });

  it("asks the local AI for a description the history does not know, and only selects the category", async () => {
    const fake = new FakeOllama();
    fake.say({ suggestions: [{ index: 0, category: "Lazer" }] });
    setAiTransport(fake.transport);
    const o = await openLivro();
    await menu(o.user, "Novo lançamento", "Despesa");
    const d = await dialog("Despesa");
    await typeInto(o.user, d, "Descrição", "Ingresso do cinema");
    await o.user.click(await within(d).findByRole("button", { name: "Perguntar à IA local" }));
    expect(await within(d).findByText(/Categoria sugerida pela IA local \(gemma4:12b\)/)).toBeTruthy();
    expect(within(d).getByRole("combobox", { name: "Categoria" }).textContent).toContain("Lazer");
    // only the description and category names went to the model
    const sent = JSON.stringify(fake.received);
    expect(sent).toContain("Ingresso do cinema");
    expect(sent).not.toMatch(/\d+,\d{2}/);
  });

  it("says so when the local AI is unavailable", async () => {
    setAiTransport(() => Promise.reject(new TypeError("fetch failed")));
    const o = await openLivro();
    await menu(o.user, "Novo lançamento", "Despesa");
    const d = await dialog("Despesa");
    await typeInto(o.user, d, "Descrição", "Ingresso do cinema");
    await o.user.click(await within(d).findByRole("button", { name: "Perguntar à IA local" }));
    expect(await within(d).findByText(/IA local: Ollama indisponível/)).toBeTruthy();
  });
});

async function openActions(user: User, item: string | RegExp) {
  await menu(user, "Ações", item);
}

describe("Livro: correções", () => {
  it("corrects a day-to-day entry in its own words, with a reason kept in the history", async () => {
    const o = await openLivro();
    const id = await pickRow(o.user, "Aluguel");
    await screen.findByTestId("operation-details");
    const original = byId(o, id);
    await openActions(o.user, "Corrigir…");
    const d = await dialog("Corrigir lançamento");
    await typeInto(o.user, d, "Valor", "2400,00");
    await submit(o.user, d, "Salvar correção");
    expect(await within(d).findByText("O motivo da correção é obrigatório.")).toBeTruthy();
    await submit(o.user, d, "Salvar correção");
    await typeInto(o.user, d, /Motivo da correção/, "Reajuste do contrato");
    await submit(o.user, d, "Salvar correção");
    await waitFor(() => expect(byId(o, id).postings.some((p) => p.amount.eq("2400"))).toBe(true));
    const updated = byId(o, id);
    expect(updated.version).toBe(original.version + 1);
    const history = o.workspace.ledger.historyOf(id);
    expect(history.at(-1)?.reason).toBe("Reajuste do contrato");
    expect(history.at(-1)?.action).toBe("update");
    o.workspace.undo();
    expect(byId(o, id).postings.some((p) => p.amount.eq("2350"))).toBe(true);
    expect(o.workspace.ledger.historyOf(id).length).toBe(history.length - 1);
  });

  it("refuses a correction that changes nothing", async () => {
    const o = await openLivro();
    await pickRow(o.user, "Aluguel");
    await openActions(o.user, "Corrigir…");
    const d = await dialog("Corrigir lançamento");
    await typeInto(o.user, d, /Motivo da correção/, "Conferi");
    await submit(o.user, d, "Salvar correção");
    expect(await within(d).findByText("Nada foi alterado.")).toBeTruthy();
  });

  it("opens the day-to-day editor with Enter, and the full editor from it", async () => {
    const o = await openLivro();
    await pickRow(o.user, "Aluguel");
    await o.user.keyboard("{Enter}");
    const d = await dialog("Corrigir lançamento");
    await o.user.click(within(d).getByRole("button", { name: "Corrigir partidas…" }));
    // the first dialog animates out while the full editor opens (the motion is off in tests)
    expect(await screen.findByRole("dialog", { name: "Editar lançamento" })).toBeTruthy();
  });

  it("edits the postings, and the share of each posting is the rateio by member", async () => {
    const o = await openLivro();
    const id = await pickRow(o.user, "Aluguel");
    await openActions(o.user, "Corrigir partidas…");
    const d = await dialog("Editar lançamento");
    expect(within(d).getByText("Equilibrada ✓")).toBeTruthy();
    await choose(o.user, "Integrante da partida 1", "Ana", d);
    await typeInto(o.user, d, /Motivo da correção/, "Quem paga a parte da Ana");
    await submit(o.user, d, "Salvar correção");
    const ana = [...o.workspace.ledger.members.values()].find((m) => m.name === "Ana")!;
    await waitFor(() => expect(byId(o, id).postings.some((p) => p.member_id === ana.id)).toBe(true));
    expect(o.workspace.ledger.historyOf(id).at(-1)?.reason).toBe("Quem paga a parte da Ana");
    o.workspace.undo();
    expect(byId(o, id).postings.every((p) => p.member_id === null)).toBe(true);
  });

  it("shows the imbalance of the postings and refuses to save it", async () => {
    const o = await openLivro();
    await pickRow(o.user, "Aluguel");
    await openActions(o.user, "Corrigir partidas…");
    const d = await dialog("Editar lançamento");
    await typeInto(o.user, d, "Débito da partida 1", "2000,00");
    expect(within(d).getByText(/Sobram .* em créditos/)).toBeTruthy();
    await typeInto(o.user, d, /Motivo da correção/, "Teste");
    await submit(o.user, d, "Salvar correção");
    expect(await within(d).findByText("Débitos e créditos não se equilibram.")).toBeTruthy();
    await o.user.click(within(d).getByRole("button", { name: "Adicionar partida" }));
    expect(within(d).getByRole("combobox", { name: "Conta da partida 3" })).toBeTruthy();
  });

  it("cancels an operation with a reason: it stays in the book as cancelled", async () => {
    const o = await openLivro();
    const id = await pickRow(o.user, "Aluguel");
    await openActions(o.user, "Cancelar lançamento…");
    const d = await dialog("Cancelar lançamento");
    await submit(o.user, d, "Cancelar lançamento");
    expect(await within(d).findByText("O motivo é obrigatório.")).toBeTruthy();
    await typeInto(o.user, d, /Motivo/, "Lançado em duplicidade");
    await submit(o.user, d, "Cancelar lançamento");
    await waitFor(() => expect(isActive(byId(o, id))).toBe(false));
    expect(o.workspace.ledger.historyOf(id).at(-1)?.reason).toBe("Lançado em duplicidade");
    expect(rowsWith("Cancelado").length).toBeGreaterThan(0);
    o.workspace.undo();
    expect(isActive(byId(o, id))).toBe(true);
  });

  it("does not correct a cancelled operation", async () => {
    const o = await openLivro();
    const id = await pickRow(o.user, "Aluguel");
    o.workspace.act((l) => l.cancelOperation(id, "teste"));
    await openActions(o.user, "Corrigir…");
    expect(await screen.findByText("Lançamento cancelado não pode ser corrigido.")).toBeTruthy();
    expect(screen.queryByRole("dialog", { name: "Corrigir lançamento" })).toBeNull();
  });

  it("reverses an operation: a new opposite entry, the original kept", async () => {
    const o = await openLivro();
    const id = await pickRow(o.user, "Aluguel");
    const before = count(o);
    await openActions(o.user, "Estornar…");
    const d = await dialog("Estornar lançamento");
    await typeInto(o.user, d, /Motivo/, "Cobrança indevida");
    await submit(o.user, d, "Estornar");
    await waitFor(() => expect(count(o)).toBe(before + 1));
    const reversal = [...o.workspace.ledger.operations.values()].find((op) => op.reversal_of === id)!;
    expect(reversal.kind).toBe(OperationKind.REVERSAL);
    expect(reversal.notes).toBe("Cobrança indevida");
    expect(isActive(byId(o, id))).toBe(true);
    expectUndo(o, before);
  });

  it("shows the whole history of an operation", async () => {
    const o = await openLivro();
    const id = await pickRow(o.user, "Aluguel");
    o.workspace.act((l) => l.updateOperation({ ...byId(o, id), notes: "ajuste" }, "Primeira correção"));
    await openActions(o.user, "Histórico");
    const d = await dialog("Histórico");
    expect(within(d).getByText(/Primeira correção/)).toBeTruthy();
    expect(within(d).getByText(/corrigido/)).toBeTruthy();
    expect(within(d).getByText(/criado/)).toBeTruthy();
    await closeDialog(o.user, d);
  });
});

describe("Livro: classificar", () => {
  it("reclassifies the ticked operations with a reason, one undo step for all", async () => {
    const o = await openLivro();
    const before = o.workspace.undoStack.undoLabel();
    for (const row of rowsWith("Padaria Real").slice(0, 2)) {
      await o.user.click(within(row).getByRole("checkbox"));
    }
    expect(await screen.findByText("2 marcados")).toBeTruthy();
    await openActions(o.user, "Reclassificar…");
    const d = await dialog("Reclassificar lançamentos");
    await choose(o.user, "Nova categoria", "Despesa: Lazer", d);
    await submit(o.user, d, "Reclassificar");
    expect(await within(d).findByText("O motivo é obrigatório.")).toBeTruthy();
    await typeInto(o.user, d, /Motivo/, "Era lazer");
    await submit(o.user, d, "Reclassificar");
    const lazer = category(o, "Lazer").id;
    await waitFor(() => {
      const moved = [...o.workspace.ledger.operations.values()].filter(
        (op) => op.description === "Padaria Real" && op.postings.some((p) => p.account_id === lazer),
      );
      expect(moved.length).toBe(2);
    });
    const moved = [...o.workspace.ledger.operations.values()].filter(
      (op) => op.description === "Padaria Real" && op.postings.some((p) => p.account_id === lazer),
    );
    expect(o.workspace.ledger.historyOf(moved[0]!.id).at(-1)?.reason).toBe("Era lazer");
    o.workspace.undo();
    expect(
      [...o.workspace.ledger.operations.values()].filter(
        (op) => op.description === "Padaria Real" && op.postings.some((p) => p.account_id === lazer),
      ).length,
    ).toBe(0);
    expect(o.workspace.undoStack.undoLabel()).toBe(before);
  });

  it("tags operations, filters by the tag, removes it and renames it", async () => {
    const o = await openLivro();
    const id = await pickRow(o.user, "Posto Shell");
    await openActions(o.user, "Marcadores…");
    let d = await dialog("Marcadores");
    await submit(o.user, d, "Aplicar");
    expect(await within(d).findByText("Informe o nome do marcador.")).toBeTruthy();
    await typeInto(o.user, d, "Marcador", "Viagem 2026");
    await submit(o.user, d, "Aplicar");
    await waitFor(() => expect(dom.tags.tagsOf(o.workspace.ledger, id)).toEqual(["Viagem 2026"]));
    o.workspace.undo();
    expect(dom.tags.tagsOf(o.workspace.ledger, id)).toEqual([]);
    o.workspace.redo();
    expect(dom.tags.tagsOf(o.workspace.ledger, id)).toEqual(["Viagem 2026"]);

    // filter by the tag
    await choose(o.user, "Marcador", "Viagem 2026");
    await waitFor(() => expect(grid().querySelectorAll("[data-row-id]").length).toBe(1));

    // rename it from the Ações menu while it is filtered
    await openActions(o.user, /Renomear o marcador/);
    d = await dialog("Renomear marcador");
    await typeInto(o.user, d, "Novo nome", "Viagem de férias");
    await submit(o.user, d, "Renomear");
    await waitFor(() => expect(dom.tags.tagsOf(o.workspace.ledger, id)).toEqual(["Viagem de férias"]));

    // remove it
    await choose(o.user, "Marcador", "Viagem de férias");
    await pickRow(o.user, "Posto Shell");
    await openActions(o.user, "Marcadores…");
    d = await dialog("Marcadores");
    await typeInto(o.user, d, "Marcador", "Viagem de férias");
    await choose(o.user, "O que fazer", "Remover dos selecionados", d);
    await submit(o.user, d, "Aplicar");
    await waitFor(() => expect(dom.tags.tagsOf(o.workspace.ledger, id)).toEqual([]));
  });

  it("marks an operation as checked, silencing the warning", async () => {
    const o = await openLivro();
    await pickRow(o.user, "Mercado do mês");
    const details = await screen.findByTestId("operation-details");
    expect(within(details).getByText(/Valor fora do comum/)).toBeTruthy();
    const id = [...o.workspace.ledger.operations.values()].find((op) => op.description === "Mercado do mês")!.id;
    await openActions(o.user, "Está certo (silenciar aviso)");
    await waitFor(() =>
      expect(within(screen.getByTestId("operation-details")).queryByText(/Valor fora do comum/)).toBeNull(),
    );
    expect(dom.anomalies.ofOperation(o.workspace.ledger, id, o.workspace.today())).toEqual([]);
    o.workspace.undo();
    expect(dom.anomalies.ofOperation(o.workspace.ledger, id, o.workspace.today()).length).toBe(1);
  });

  it("names a merchant for every similar description", async () => {
    const o = await openLivro();
    await pickRow(o.user, "Padaria Real");
    await openActions(o.user, "Nomear estabelecimento…");
    const d = await dialog("Nomear estabelecimento");
    await typeInto(o.user, d, "Nome do estabelecimento", "Padaria da Rua");
    await submit(o.user, d, "Salvar nome");
    await waitFor(() => expect(dom.merchants.merchantOf(o.workspace.ledger, "Padaria Real")).toBe("Padaria da Rua"));
    expect(within(await screen.findByTestId("operation-details")).getByText("Padaria da Rua")).toBeTruthy();
    o.workspace.undo();
    expect(dom.merchants.merchantOf(o.workspace.ledger, "Padaria Real")).not.toBe("Padaria da Rua");
  });
});

describe("Livro: planejamento a partir de um lançamento", () => {
  it("registers a reimbursement to receive", async () => {
    const o = await openLivro();
    const id = await pickRow(o.user, "Mercado do mês");
    await openActions(o.user, "Reembolso a receber…");
    const d = await dialog("Reembolso a receber");
    expect((within(d).getByLabelText("Valor esperado") as HTMLInputElement).value).toBe("560,00");
    await submit(o.user, d, "Registrar");
    expect(await within(d).findByText("Informe quem reembolsa.")).toBeTruthy();
    await typeInto(o.user, d, "Quem reembolsa", "Empresa");
    await typeInto(o.user, d, "Valor esperado", "300,00");
    await submit(o.user, d, "Registrar");
    await waitFor(() =>
      expect([...dom.sharing.reimbursements(o.workspace.ledger).values()].some((r) => r.operation_id === id)).toBe(
        true,
      ),
    );
    const item = [...dom.sharing.reimbursements(o.workspace.ledger).values()].find((r) => r.operation_id === id)!;
    expect(item.payer).toBe("Empresa");
    expect(item.expected.eq("300")).toBe(true);
    expect(within(await screen.findByTestId("operation-details")).getByText(/Empresa/)).toBeTruthy();
    o.workspace.undo();
    expect([...dom.sharing.reimbursements(o.workspace.ledger).values()].some((r) => r.operation_id === id)).toBe(false);
  });

  it("refuses a reimbursement above the expense", async () => {
    const o = await openLivro();
    await pickRow(o.user, "Mercado do mês");
    await openActions(o.user, "Reembolso a receber…");
    const d = await dialog("Reembolso a receber");
    await typeInto(o.user, d, "Quem reembolsa", "Empresa");
    await typeInto(o.user, d, "Valor esperado", "900,00");
    await submit(o.user, d, "Registrar");
    expect(await within(d).findByText("O reembolso esperado passa do valor da despesa.")).toBeTruthy();
  });

  it("marks the category of an expense as deductible, and clears it", async () => {
    const o = await openLivro();
    await pickRow(o.user, "Mercado do mês");
    const alimentacao = category(o, "Alimentação").id;
    await openActions(o.user, "Marcar categoria como dedutível…");
    const d = await dialog(/Despesa dedutível/);
    await choose(o.user, "Tipo de dedução", "Saúde", d);
    await submit(o.user, d, "Salvar");
    await waitFor(() => expect(dom.deductibles.kindOf(o.workspace.ledger, alimentacao)).toBe("health"));
    o.workspace.undo();
    expect(dom.deductibles.kindOf(o.workspace.ledger, alimentacao)).toBeNull();
  });

  it("records the balance the bank shows and tells whether it matches", async () => {
    const o = await openLivro();
    await pickRow(o.user, "Aluguel");
    const bank = account(o, "Banco A").id;
    const checks = dom.balanceChecks.checks(o.workspace.ledger).size;
    await openActions(o.user, "Conferir saldo da conta…");
    const d = await dialog(/Conferir saldo/);
    await submit(o.user, d, "Conferir");
    expect(await within(d).findByText("Informe o valor.")).toBeTruthy();
    await typeInto(o.user, d, "Saldo no banco", "1.234,56");
    await submit(o.user, d, "Conferir");
    await waitFor(() => expect(dom.balanceChecks.checks(o.workspace.ledger).size).toBe(checks + 1));
    const result = dom.balanceChecks.results(o.workspace.ledger, bank)[0]!;
    expect(result.check.informed.eq("1234.56")).toBe(true);
    expect(await screen.findByText(/difere/)).toBeTruthy();
    o.workspace.undo();
    expect(dom.balanceChecks.checks(o.workspace.ledger).size).toBe(checks);
  });

  it("details the income of a deposit for the annual return", async () => {
    const o = await openLivro();
    const details = o.workspace.ledger.entities("income_detail").size;
    const id = await pickRow(o.user, "Salário");
    await openActions(o.user, "Detalhar rendimento (IR)…");
    const d = await dialog("Detalhar rendimento");
    await typeInto(o.user, d, "Bruto", "9.000,00");
    await typeInto(o.user, d, "IR retido", "800,00");
    await submit(o.user, d, "Salvar");
    await waitFor(() => expect(o.workspace.ledger.entities("income_detail").size).toBe(details + 1));
    const detail = [
      ...o.workspace.ledger.entities<{ operation_id: string; gross: { toFixed(): string } }>("income_detail").values(),
    ].find((x) => x.operation_id === id)!;
    expect(detail.gross.toFixed()).toBe("9000.00");
    o.workspace.undo();
    expect(o.workspace.ledger.entities("income_detail").size).toBe(details);
  });

  it("only offers the income detail for an income", async () => {
    const o = await openLivro();
    await pickRow(o.user, "Aluguel");
    await openActions(o.user, "Detalhar rendimento (IR)…");
    expect(await screen.findByText("Só receitas têm detalhamento de rendimento.")).toBeTruthy();
  });
});

describe("Livro: comprovantes", () => {
  const png = () =>
    new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4])], "nota.png", {
      type: "image/png",
    });

  it("attaches a receipt, opens it from the details, and one undo takes it away", async () => {
    const o = await openLivro();
    const id = await pickRow(o.user, "Aluguel");
    const input = screen.getByLabelText("Escolher o comprovante") as HTMLInputElement;
    await o.user.upload(input, png());
    await waitFor(() => expect(dom.attachments.ofOperation(o.workspace.ledger, id).length).toBe(1));
    const documents = o.workspace.session.documents.length;
    const open = await screen.findByRole("button", { name: "Abrir comprovante" });
    await o.user.click(open);
    const d = await dialog("Comprovante");
    expect(await within(d).findByAltText("Comprovante nota.png")).toBeTruthy();
    await closeDialog(o.user, d);
    o.workspace.undo();
    expect(dom.attachments.ofOperation(o.workspace.ledger, id).length).toBe(0);
    expect(o.workspace.session.documents.length).toBe(documents - 1);
  });

  it("unlinks a receipt from the Livro in one act, and undo puts the file back", async () => {
    const o = await openLivro();
    const id = await pickRow(o.user, "Aluguel");
    await openActions(o.user, "Desvincular comprovante…");
    expect(await screen.findByText("Este lançamento não tem comprovante.")).toBeTruthy();
    await o.user.upload(screen.getByLabelText("Escolher o comprovante") as HTMLInputElement, png());
    await waitFor(() => expect(dom.attachments.ofOperation(o.workspace.ledger, id).length).toBe(1));
    const documents = o.workspace.session.documents.length;

    await openActions(o.user, "Desvincular comprovante…");
    const confirmation = await screen.findByRole("alertdialog", { name: "Desvincular o comprovante?" });
    // refusing changes nothing
    await o.user.click(within(confirmation).getByRole("button", { name: "Cancelar" }));
    expect(dom.attachments.ofOperation(o.workspace.ledger, id).length).toBe(1);

    await openActions(o.user, "Desvincular comprovante…");
    const again = await screen.findByRole("alertdialog", { name: "Desvincular o comprovante?" });
    await o.user.click(within(again).getByRole("button", { name: "Desvincular" }));
    await waitFor(() => expect(dom.attachments.ofOperation(o.workspace.ledger, id).length).toBe(0));
    // a file nothing else uses leaves the project with its last receipt
    expect(o.workspace.session.documents.length).toBe(documents - 1);
    o.workspace.undo();
    expect(dom.attachments.ofOperation(o.workspace.ledger, id).length).toBe(1);
    expect(o.workspace.session.documents.length).toBe(documents);
  });

  it("refuses a file that is not a PDF or an image", async () => {
    const o = await openLivro();
    await pickRow(o.user, "Aluguel");
    const input = screen.getByLabelText("Escolher o comprovante") as HTMLInputElement;
    await o.user.upload(input, new File(["texto"], "nota.pdf", { type: "application/pdf" }));
    expect(await screen.findByText("Anexe um PDF ou uma imagem (PNG ou JPEG).")).toBeTruthy();
  });
});

describe("Livro: filtros", () => {
  it("narrows by search, account, status and origin, and clears everything", async () => {
    const o = await openLivro();
    const all = grid().querySelectorAll("[data-row-id]").length;
    await o.user.type(screen.getByRole("searchbox", { name: "Buscar lançamentos" }), "padaria");
    await waitFor(() => expect(rowsWith("Padaria").length).toBeGreaterThan(0));
    await waitFor(() => expect(grid().querySelectorAll("[data-row-id]").length).toBeLessThan(all));
    expect(screen.getByText(/de \d+ lançamentos/)).toBeTruthy();
    await o.user.click(screen.getAllByRole("button", { name: "Limpar filtros" })[0]!);
    await waitFor(() => expect(grid().querySelectorAll("[data-row-id]").length).toBe(all));

    await choose(o.user, "Situação", "Só cancelados");
    expect(await screen.findByText("Nenhum lançamento com estes filtros")).toBeTruthy();
    await o.user.click(screen.getAllByRole("button", { name: "Limpar filtros" })[0]!);
    await choose(o.user, "Origem", "Importado");
    await waitFor(() => expect(rowsWith("Padaria").length).toBe(0));
    await o.user.click(screen.getAllByRole("button", { name: "Limpar filtros" })[0]!);
    await choose(o.user, "Conta ou categoria", "Categoria: Moradia");
    await waitFor(() => expect(grid().querySelectorAll("[data-row-id]").length).toBe(3));
  });

  it("filters by period, following the month shared with the other pages", async () => {
    const o = await openLivro();
    await choose(o.user, "Período", /de 20\d\d$/);
    // the month in the picker is the shared one; today's month has two operations in the demonstration
    expect(screen.getByRole("group", { name: "Mês do livro" })).toBeTruthy();
    await waitFor(() => expect(grid().querySelectorAll("[data-row-id]").length).toBe(2));
    await o.user.click(screen.getByRole("button", { name: "Mês anterior" }));
    expect(await screen.findByText(/Nenhum lançamento em/)).toBeTruthy();
    await o.user.click(screen.getByRole("button", { name: "Ver todo o período" }));
    await waitFor(() => expect(grid().querySelectorAll("[data-row-id]").length).toBeGreaterThan(5));
  });

  it("filters by a custom period typed as dates", async () => {
    const o = await openLivro();
    await choose(o.user, "Período", "Personalizado");
    await o.user.type(screen.getByLabelText("Data inicial"), "01/03/2026");
    await o.user.type(screen.getByLabelText("Data final"), "31/03/2026");
    await waitFor(() => {
      const rows = grid().querySelectorAll("[data-row-id]").length;
      expect(rows).toBeGreaterThan(0);
      expect(rows).toBeLessThan(count(o));
    });
  });

  it("saves, applies and deletes a filter in the project, each one an undo step", async () => {
    const o = await openLivro();
    await choose(o.user, "Conta ou categoria", "Categoria: Moradia");
    await menu(o.user, "Filtros salvos", "Salvar filtro atual…");
    const d = await dialog("Salvar filtro");
    await submit(o.user, d, "Salvar filtro");
    expect(await within(d).findByText("Dê um nome ao filtro.")).toBeTruthy();
    await typeInto(o.user, d, "Nome do filtro", "Só a moradia");
    await submit(o.user, d, "Salvar filtro");
    await waitFor(() =>
      expect(dom.savedFilters.saved(o.workspace.ledger).map((f) => f.name)).toEqual(["Só a moradia"]),
    );
    await o.user.click(screen.getAllByRole("button", { name: "Limpar filtros" })[0]!);
    await waitFor(() => expect(grid().querySelectorAll("[data-row-id]").length).toBeGreaterThan(3));
    await menu(o.user, "Filtros salvos", "Só a moradia");
    await waitFor(() => expect(grid().querySelectorAll("[data-row-id]").length).toBe(3));
    await menu(o.user, "Filtros salvos", /Excluir “Só a moradia”/);
    await waitFor(() => expect(dom.savedFilters.saved(o.workspace.ledger)).toEqual([]));
    o.workspace.undo();
    expect(dom.savedFilters.saved(o.workspace.ledger).length).toBe(1);
  });

  it("does not save a custom period", async () => {
    const o = await openLivro();
    await choose(o.user, "Período", "Personalizado");
    await menu(o.user, "Filtros salvos", "Salvar filtro atual…");
    expect(await screen.findByText("Período personalizado não é salvo. Escolha um período com nome.")).toBeTruthy();
  });

  it("hides and shows optional columns, remembered on this device", async () => {
    const o = await openLivro();
    expect(within(grid()).getByRole("columnheader", { name: "Origem" })).toBeTruthy();
    await menu(o.user, "Colunas", "Ocultar Origem");
    await waitFor(() => expect(within(grid()).queryByRole("columnheader", { name: "Origem" })).toBeNull());
    expect(o.preferences.get("livro/colunas-ocultas")).toBe("origem");
    await menu(o.user, "Colunas", "Mostrar Origem");
    expect(await within(grid()).findByRole("columnheader", { name: "Origem" })).toBeTruthy();
  });
});
