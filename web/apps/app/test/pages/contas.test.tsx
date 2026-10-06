/** Contas e cartões: the page, the plain lists (Integrantes, Cartões, Categorias) and Todas as contas. */
import { AccountSubtype, AccountType, Dec, MemberRole, dom, formatBrl, queries } from "@opesvault/domain";
import { screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  choose,
  closed,
  dialog,
  fill,
  flat,
  goTab,
  openContas,
  pick,
  rowOf,
  snapshot,
  submit,
  table,
  undoOnce,
} from "./contas_harness.tsx";
import { navigations, wentTo } from "../navigations.ts";

vi.mock("../../../../packages/ui/src/chart/echarts.ts", async () => await import("./fake_echarts.ts"));

const byName = (ledger: { accounts: Map<string, { id: string; name: string }> }, name: string) =>
  [...ledger.accounts.values()].find((a) => a.name === name)!;

describe("Contas e cartões page", () => {
  it("shows the eight tabs, the count line and starts on Contas bancárias", async () => {
    const { ledger } = await openContas();
    const tabs = screen.getAllByRole("tab").map((tab) => tab.textContent);
    expect(tabs).toEqual([
      "Contas bancárias",
      "Todas as contas",
      "Cartões",
      "Faturas",
      "Financiamentos",
      "Categorias",
      "Regras",
      "Integrantes",
    ]);
    expect(screen.getByRole("tab", { name: "Contas bancárias" }).getAttribute("aria-selected")).toBe("true");
    const accounts = [...ledger.accounts.values()].filter(
      (a) => a.type === AccountType.ASSET || a.type === AccountType.LIABILITY,
    ).length;
    expect(
      screen.getByText(`${accounts} contas · ${ledger.cards.size} cartão · ${ledger.members.size} integrantes`),
    ).toBeTruthy();
  });

  it("opens an empty project with a state in every tab and nothing crashing (TA-31)", async () => {
    const { user } = await openContas("/contas", { empty: true });
    for (const [tab, text] of [
      ["Contas bancárias", "Nenhuma conta bancária"],
      ["Todas as contas", "Nenhuma conta"],
      ["Cartões", "Nenhum cartão"],
      ["Faturas", "Nenhum cartão"],
      ["Financiamentos", "Nenhum financiamento"],
      ["Regras", "Nenhuma regra sua"],
      ["Integrantes", "Nenhum integrante"],
    ] as const) {
      const panel = await goTab(user, tab);
      expect(within(panel).getByRole("heading", { name: text, level: 2 }), tab).toBeTruthy();
    }
    // a new project already has the standard categories, and no members, accounts or cards
    await goTab(user, "Categorias");
    expect(await table("Categorias")).toBeTruthy();
    expect(screen.getByText(/^\d+ contas? · 0 cartões · 0 integrantes$/)).toBeTruthy();
  });

  it("disables every editing command in a read-only project, with the reason", async () => {
    const { user, ledger } = await openContas("/contas", { readOnly: true });
    const before = snapshot(ledger);
    for (const [tab, commands] of [
      ["Contas bancárias", ["Nova conta bancária…", "Editar…", "Valores em uma data…", "Novo investimento…"]],
      ["Todas as contas", ["Nova conta…", "Editar…", "Conferir saldo…"]],
      ["Cartões", ["Novo cartão…", "Editar…"]],
      ["Financiamentos", ["Novo financiamento…", "Pagar parcela…"]],
      ["Categorias", ["Nova categoria…", "Dedutível no IR…"]],
      ["Regras", ["Nova regra…", "Editar…", "Ativar ou desativar…"]],
      ["Integrantes", ["Novo integrante…", "Editar…"]],
    ] as const) {
      const panel = await goTab(user, tab);
      for (const name of commands) {
        const button = within(panel).getByRole("button", { name }) as HTMLButtonElement;
        expect(button.disabled, `${tab}: ${name}`).toBe(true);
        expect(button.title).toContain("editando este projeto");
      }
    }
    expect(snapshot(ledger)).toBe(before);
  });
});

describe("Integrantes", () => {
  it("lists the members with their role and situation", async () => {
    const { ledger, user } = await openContas();
    await goTab(user, "Integrantes");
    const grid = await table("Integrantes");
    for (const member of ledger.members.values()) {
      const text = flat(rowOf(grid, member.name).textContent);
      expect(text).toContain(member.role === MemberRole.HOLDER ? "Titular" : "Dependente");
      expect(text).toContain(member.active ? "Ativo" : "Inativo");
    }
  });

  it("adds a member with a role (Novo integrante…) and one undo removes it", async () => {
    const { ledger, workspace, user } = await openContas();
    const before = snapshot(ledger);
    await goTab(user, "Integrantes");
    await user.click(screen.getByRole("button", { name: "Novo integrante…" }));
    const box = await dialog("Novo integrante");
    await fill(user, box, /^Nome/, "Carla");
    await choose(user, box, "Papel", "Dependente");
    await submit(user, box, "Adicionar");
    await closed("Novo integrante");
    const carla = [...ledger.members.values()].find((m) => m.name === "Carla")!;
    expect(carla.role).toBe(MemberRole.DEPENDENT);
    expect(carla.active).toBe(true);
    expect(await screen.findByText("Integrante adicionado.")).toBeTruthy();
    expect(flat((await table("Integrantes")).textContent)).toContain("Carla");
    undoOnce(workspace);
    expect(snapshot(ledger)).toBe(before);
  });

  it("refuses an empty or repeated name inside the dialog and changes nothing", async () => {
    const { ledger, workspace, user } = await openContas();
    const before = snapshot(ledger);
    await goTab(user, "Integrantes");
    await user.click(screen.getByRole("button", { name: "Novo integrante…" }));
    const box = await dialog("Novo integrante");
    await submit(user, box, "Adicionar");
    expect(within(box).getByText("Informe o nome.")).toBeTruthy();
    await fill(user, box, /^Nome/, "ana");
    await submit(user, box, "Adicionar");
    expect(within(box).getByText("Já existe um integrante com esse nome.")).toBeTruthy();
    expect(snapshot(ledger)).toBe(before);
    expect(workspace.undoStack.canUndo()).toBe(false);
    await submit(user, box, "Cancelar");
    await closed("Novo integrante");
  });

  it("edits the selected member (name, role, situation); a double click opens it too; one undo reverts", async () => {
    const { ledger, workspace, user } = await openContas();
    await goTab(user, "Integrantes");
    const bruno = [...ledger.members.values()].find((m) => m.name === "Bruno")!;
    const before = snapshot(ledger);
    const grid = await table("Integrantes");
    await pick(user, grid, "Bruno");
    await user.click(screen.getByRole("button", { name: "Editar…" }));
    const box = await dialog("Editar integrante");
    expect((within(box).getByLabelText(/^Nome/) as HTMLInputElement).value).toBe("Bruno");
    await fill(user, box, /^Nome/, "Bruno Silva");
    await choose(user, box, "Papel", "Dependente");
    await user.click(within(box).getByRole("checkbox", { name: /Ativo/ }));
    await submit(user, box, "Salvar");
    await closed("Editar integrante");
    expect(ledger.members.get(bruno.id)).toMatchObject({
      name: "Bruno Silva",
      role: MemberRole.DEPENDENT,
      active: false,
    });
    expect(flat(rowOf(await table("Integrantes"), "Bruno Silva").textContent)).toContain("Inativo");
    undoOnce(workspace);
    expect(snapshot(ledger)).toBe(before);
    // double click
    const again = await table("Integrantes");
    await user.dblClick(rowOf(again, "Bruno"));
    expect(await dialog("Editar integrante")).toBeTruthy();
  });

  it("asks to select a member instead of opening a dialog when none is selected", async () => {
    const { user } = await openContas();
    await goTab(user, "Integrantes");
    await user.click(screen.getByRole("button", { name: "Editar…" }));
    expect(await screen.findByText("Selecione um integrante.")).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("Cartões", () => {
  it("lists the cards with holder, closing and due day and the open bill", async () => {
    const { ledger, user } = await openContas();
    await goTab(user, "Cartões");
    const grid = await table("Cartões");
    const card = [...ledger.cards.values()][0]!;
    const text = flat(rowOf(grid, card.name).textContent);
    expect(text).toContain(card.last4);
    expect(text).toContain(`dia ${card.closing_day}`);
    expect(text).toContain(`dia ${card.due_day}`);
    expect(text).toContain(formatBrl(queries.balances(ledger).get(card.liability_account_id)!));
  });

  it("creates a card with its liability account in one step and one undo removes both", async () => {
    const { ledger, workspace, user } = await openContas();
    const before = snapshot(ledger);
    await goTab(user, "Cartões");
    await user.click(screen.getByRole("button", { name: "Novo cartão…" }));
    const box = await dialog("Novo cartão de crédito");
    await fill(user, box, /^Nome/, "Cartão Y");
    await fill(user, box, "Instituição", "NU PAGAMENTOS S.A. - INSTITUIÇÃO DE PAGAMENTO");
    await choose(user, box, "Portador", "Bruno");
    await fill(user, box, "Final", "4321");
    await fill(user, box, "Dia de fechamento", "20");
    await fill(user, box, "Dia de vencimento", "27");
    await choose(user, box, "Conta de pagamento", "Banco A");
    await submit(user, box, "Salvar cartão");
    await closed("Novo cartão de crédito");
    const card = [...ledger.cards.values()].find((c) => c.name === "Cartão Y")!;
    expect(card).toMatchObject({ last4: "4321", closing_day: 20, due_day: 27 });
    expect(card.settlement_account_id).toBe(byName(ledger, "Banco A").id);
    const liability = ledger.accounts.get(card.liability_account_id)!;
    expect(liability).toMatchObject({ subtype: AccountSubtype.CREDIT_CARD, masked_number: "final 4321" });
    expect(await screen.findByText("Cartão cadastrado.")).toBeTruthy();
    expect(flat(rowOf(await table("Cartões"), "Cartão Y").textContent)).toContain("4321");
    undoOnce(workspace);
    expect(snapshot(ledger)).toBe(before);
  });

  it("checks the name, the four digits and the days before saving", async () => {
    const { ledger, workspace, user } = await openContas();
    const before = snapshot(ledger);
    await goTab(user, "Cartões");
    await user.click(screen.getByRole("button", { name: "Novo cartão…" }));
    const box = await dialog("Novo cartão de crédito");
    await submit(user, box, "Salvar cartão");
    expect(within(box).getByText("Informe o nome do cartão.")).toBeTruthy();
    await fill(user, box, /^Nome/, "Cartão Z");
    await submit(user, box, "Salvar cartão");
    expect(within(box).getByText("Informe os 4 últimos dígitos.")).toBeTruthy();
    await fill(user, box, "Final", "12");
    await submit(user, box, "Salvar cartão");
    expect(within(box).getByText("Informe os 4 últimos dígitos.")).toBeTruthy();
    await fill(user, box, "Final", "1234");
    await fill(user, box, "Dia de fechamento", "40");
    await submit(user, box, "Salvar cartão");
    expect(within(box).getByText("Dia de fechamento: informe um dia de 1 a 31.")).toBeTruthy();
    expect(snapshot(ledger)).toBe(before);
    expect(workspace.undoStack.canUndo()).toBe(false);
  });

  it("edits the selected card (closing day, settlement) without touching its account; one undo reverts", async () => {
    const { ledger, workspace, user } = await openContas();
    await goTab(user, "Cartões");
    const card = [...ledger.cards.values()][0]!;
    const before = snapshot(ledger);
    await pick(user, await table("Cartões"), card.name);
    await user.click(screen.getByRole("button", { name: "Editar…" }));
    const box = await dialog("Editar cartão de crédito");
    expect((within(box).getByLabelText("Final") as HTMLInputElement).value).toBe(card.last4);
    expect(within(box).queryByLabelText("Instituição")).toBeNull();
    await fill(user, box, "Dia de fechamento", "12");
    await choose(user, box, "Conta de pagamento", "(não definida)");
    await submit(user, box, "Salvar cartão");
    await closed("Editar cartão de crédito");
    expect(ledger.cards.get(card.id)).toMatchObject({ closing_day: 12, settlement_account_id: null });
    expect(ledger.accounts.size).toBe(JSON.parse(before)[0].length);
    expect(await screen.findByText("Cartão salvo.")).toBeTruthy();
    undoOnce(workspace);
    expect(snapshot(ledger)).toBe(before);
  });

  it("asks to select a card when none is selected", async () => {
    const { user } = await openContas();
    await goTab(user, "Cartões");
    await user.click(screen.getByRole("button", { name: "Editar…" }));
    expect(await screen.findByText("Selecione um cartão.")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Ver lançamentos" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("Categorias", () => {
  it("lists expense and income categories with their parent and the kind of deduction", async () => {
    const { ledger, user } = await openContas();
    await goTab(user, "Categorias");
    const grid = await table("Categorias");
    const health = ledger.categories(AccountType.EXPENSE).find((c) => c.name === "Saúde")!;
    const text = flat(rowOf(grid, "Saúde").textContent);
    expect(text).toContain("Despesa");
    expect(text).toContain(dom.deductibles.KIND_LABELS[dom.deductibles.kindOf(ledger, health.id)!]);
    expect(flat(rowOf(grid, "Salário").textContent)).toContain("Receita");
  });

  it("creates a category inside another one and one undo removes it", async () => {
    const { ledger, workspace, user } = await openContas();
    const before = snapshot(ledger);
    await goTab(user, "Categorias");
    await user.click(screen.getByRole("button", { name: "Nova categoria…" }));
    const box = await dialog("Nova categoria");
    await submit(user, box, "Criar categoria");
    expect(within(box).getByText("Informe o nome.")).toBeTruthy();
    await fill(user, box, /^Nome/, "Restaurantes");
    await choose(user, box, "Dentro de", "Alimentação");
    await submit(user, box, "Criar categoria");
    await closed("Nova categoria");
    const created = ledger.categories(AccountType.EXPENSE).find((c) => c.name === "Restaurantes")!;
    expect(created.parent_id).toBe(byName(ledger, "Alimentação").id);
    expect(created.subtype).toBe(AccountSubtype.CATEGORY);
    expect(flat(rowOf(await table("Categorias"), "Restaurantes").textContent)).toContain("Alimentação");
    expect(await screen.findByText("Categoria criada.")).toBeTruthy();
    undoOnce(workspace);
    expect(snapshot(ledger)).toBe(before);
  });

  it("creates an income category (the parent list follows the kind)", async () => {
    const { ledger, user } = await openContas();
    await goTab(user, "Categorias");
    await user.click(screen.getByRole("button", { name: "Nova categoria…" }));
    const box = await dialog("Nova categoria");
    await fill(user, box, /^Nome/, "Freelas");
    await choose(user, box, "Tipo", "Receita");
    await user.click(within(box).getByRole("combobox", { name: "Dentro de" }));
    expect(screen.queryByRole("option", { name: "Alimentação" })).toBeNull();
    expect(screen.getByRole("option", { name: "Salário" })).toBeTruthy();
    await user.click(screen.getByRole("option", { name: "(nenhuma)" }));
    await submit(user, box, "Criar categoria");
    await closed("Nova categoria");
    expect(ledger.categories(AccountType.INCOME).some((c) => c.name === "Freelas")).toBe(true);
  });

  it("marks an expense category as deductible (Dedutível no IR…) and one undo reverts", async () => {
    const { ledger, workspace, user } = await openContas();
    const leisure = ledger.categories(AccountType.EXPENSE).find((c) => c.name === "Lazer")!;
    expect(dom.deductibles.kindOf(ledger, leisure.id)).toBeNull();
    await goTab(user, "Categorias");
    await pick(user, await table("Categorias"), "Lazer");
    await user.click(screen.getByRole("button", { name: "Dedutível no IR…" }));
    const box = await dialog(/Despesa dedutível — Lazer/);
    await choose(user, box, "Tipo de dedução", dom.deductibles.KIND_LABELS[dom.deductibles.DeductibleKind.HEALTH]);
    await submit(user, box, "Salvar");
    await closed(/Despesa dedutível/);
    expect(dom.deductibles.kindOf(ledger, leisure.id)).toBe(dom.deductibles.DeductibleKind.HEALTH);
    expect(await screen.findByText("Categoria marcada como dedutível.")).toBeTruthy();
    expect(flat(rowOf(await table("Categorias"), "Lazer").textContent)).toContain(
      dom.deductibles.KIND_LABELS[dom.deductibles.DeductibleKind.HEALTH],
    );
    undoOnce(workspace);
    expect(dom.deductibles.kindOf(ledger, leisure.id)).toBeNull();
  });

  it("explains instead of opening a dialog: no selection, or an income category", async () => {
    const { user } = await openContas();
    await goTab(user, "Categorias");
    await user.click(screen.getByRole("button", { name: "Dedutível no IR…" }));
    expect(await screen.findByText("Selecione uma categoria.")).toBeTruthy();
    await pick(user, await table("Categorias"), "Salário");
    await user.click(screen.getByRole("button", { name: "Dedutível no IR…" }));
    expect(await screen.findByText("Só categorias de despesa podem ser dedutíveis.")).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("Todas as contas", () => {
  it("lists every account and card liability with balance and the last check against the bank", async () => {
    const { ledger, user } = await openContas();
    await goTab(user, "Todas as contas");
    const grid = await table("Contas");
    const balances = queries.balances(ledger);
    const listed = [...ledger.accounts.values()].filter(
      (a) => a.type === AccountType.ASSET || a.type === AccountType.LIABILITY,
    );
    for (const account of listed) {
      expect(flat(rowOf(grid, account.name).textContent), account.name).toContain(
        formatBrl(balances.get(account.id) ?? Dec.from(0)),
      );
    }
    // the demonstration checked Banco A against the bank and found a difference; it is said in words
    expect(flat(rowOf(grid, "Banco A").textContent)).toMatch(/31\/03\/2026: diferença de/);
    expect(flat(rowOf(grid, "Poupança").textContent)).toContain("nunca");
  });

  it("selects the first account and shows its balance over the months with the table of values", async () => {
    const { ledger, user } = await openContas();
    await goTab(user, "Todas as contas");
    const grid = await table("Contas");
    const first = within(grid).getAllByRole("row")[1]!;
    expect(first.getAttribute("aria-selected")).toBe("true");
    const name = ledger.account(first.getAttribute("data-row-id")!).name;
    expect(screen.getByRole("heading", { name: `Saldo: ${name}` })).toBeTruthy();
    expect(screen.getByRole("table", { name: `Valores de Saldo: ${name}` })).toBeTruthy();
    // 12 months of balances
    const values = screen.getByRole("table", { name: `Valores de Saldo: ${name}` });
    expect(within(values).getAllByRole("row").length).toBe(13);
    expect(screen.getByRole("grid", { name: "Conferências com o banco" })).toBeTruthy();
  });

  it("creates an account with holders and an opening balance, and one undo reverts", async () => {
    const { ledger, workspace, user } = await openContas();
    const before = snapshot(ledger);
    await goTab(user, "Todas as contas");
    await user.click(screen.getByRole("button", { name: "Nova conta…" }));
    const box = await dialog("Nova conta");
    await submit(user, box, "Salvar conta");
    expect(within(box).getByText("Informe o nome da conta.")).toBeTruthy();
    await fill(user, box, /^Nome/, "Caixinha");
    await choose(user, box, "Tipo", "Dinheiro");
    await fill(user, box, "Identificação", "carteira");
    await choose(user, box, "Titular", "Ana");
    await fill(user, box, "Saldo de abertura", "150,25");
    await fill(user, box, "Data do saldo", "01/03/2026");
    await submit(user, box, "Salvar conta");
    await closed("Nova conta");
    const account = byName(ledger, "Caixinha") as ReturnType<typeof byName> & {
      subtype: string;
      holders: string[];
      masked_number: string;
    };
    expect(account.subtype).toBe(AccountSubtype.CASH);
    expect(account.holders).toEqual([[...ledger.members.values()].find((m) => m.name === "Ana")!.id]);
    expect(account.masked_number).toBe("carteira");
    expect(queries.balance(ledger, account.id).toFixed()).toBe("150.25");
    expect(await screen.findByText("Conta cadastrada.")).toBeTruthy();
    undoOnce(workspace);
    expect(snapshot(ledger)).toBe(before);
  });

  it("refuses a second holder without the first or the same twice", async () => {
    const { ledger, workspace, user } = await openContas();
    const before = snapshot(ledger);
    await goTab(user, "Todas as contas");
    await user.click(screen.getByRole("button", { name: "Nova conta…" }));
    const box = await dialog("Nova conta");
    await fill(user, box, /^Nome/, "Conjunta nova");
    await choose(user, box, "Segundo titular", "Bruno");
    await submit(user, box, "Salvar conta");
    expect(within(box).getByText("Escolha o titular antes do segundo titular.")).toBeTruthy();
    await choose(user, box, "Titular", "Bruno");
    await submit(user, box, "Salvar conta");
    expect(within(box).getByText("O segundo titular precisa ser outra pessoa.")).toBeTruthy();
    expect(snapshot(ledger)).toBe(before);
    expect(workspace.undoStack.canUndo()).toBe(false);
  });

  it("edits an account (the type is fixed) and one undo reverts", async () => {
    const { ledger, workspace, user } = await openContas();
    const before = snapshot(ledger);
    await goTab(user, "Todas as contas");
    await pick(user, await table("Contas"), "Conjunta");
    await user.click(screen.getByRole("button", { name: "Editar…" }));
    const box = await dialog("Editar conta");
    expect(within(box).getByRole("combobox", { name: "Tipo" }).hasAttribute("disabled")).toBe(true);
    expect(within(box).queryByLabelText("Saldo de abertura")).toBeNull();
    await fill(user, box, /^Nome/, "Conta da casa");
    await fill(user, box, "Instituição", "ITAÚ UNIBANCO S.A.");
    await submit(user, box, "Salvar conta");
    await closed("Editar conta");
    expect(ledger.account(byName(ledger, "Conta da casa").id).institution).toBe("ITAÚ UNIBANCO S.A.");
    undoOnce(workspace);
    expect(snapshot(ledger)).toBe(before);
  });

  it("checks a balance with the bank: says it matches, or the difference; one undo reverts", async () => {
    const { ledger, workspace, user } = await openContas();
    const account = byName(ledger, "Conjunta");
    const before = dom.balanceChecks.checks(ledger).size;
    await goTab(user, "Todas as contas");
    await pick(user, await table("Contas"), "Conjunta");
    await user.click(screen.getByRole("button", { name: "Conferir saldo…" }));
    let box = await dialog(/Conferir saldo — Conjunta/);
    await fill(user, box, "Saldo no banco", "2.300,00");
    await submit(user, box, "Conferir");
    await closed(/Conferir saldo/);
    expect(await screen.findByText("Saldo conferido: confere com o banco.")).toBeTruthy();
    expect(dom.balanceChecks.checks(ledger).size).toBe(before + 1);
    expect(dom.balanceChecks.latest(ledger).get(account.id)!.matches).toBe(true);
    // the check table of the account shows it
    const checks = await screen.findByRole("grid", { name: "Conferências com o banco" });
    expect(flat(checks.textContent)).toContain("confere");
    // a wrong amount
    await user.click(screen.getByRole("button", { name: "Conferir saldo…" }));
    box = await dialog(/Conferir saldo — Conjunta/);
    await fill(user, box, "Saldo no banco", "2.000,00");
    await submit(user, box, "Conferir");
    await closed(/Conferir saldo/);
    expect(await screen.findByText(/Saldo conferido: diferença de -R\$ 300,00\. Procure o lançamento\./)).toBeTruthy();
    undoOnce(workspace);
    undoOnce(workspace);
    expect(dom.balanceChecks.checks(ledger).size).toBe(before);
  });

  it("refuses an empty balance inside the check dialog", async () => {
    const { workspace, user } = await openContas();
    await goTab(user, "Todas as contas");
    await user.click(screen.getByRole("button", { name: "Conferir saldo…" }));
    const box = await dialog(/Conferir saldo/);
    await submit(user, box, "Conferir");
    expect(within(box).getByText("Informe o valor.")).toBeTruthy();
    expect(workspace.undoStack.canUndo()).toBe(false);
  });

  it("opens the account's operations in the Livro (Ver lançamentos)", async () => {
    const { ledger, router, user } = await openContas();
    await goTab(user, "Todas as contas");
    await pick(user, await table("Contas"), "Conjunta");
    const went = navigations(router);
    await user.click(screen.getByRole("button", { name: "Ver lançamentos" }));
    await wentTo(went, "/livro", { ref: `conta:${byName(ledger, "Conjunta").id}` });
  });
});
