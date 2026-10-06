/** Contas bancárias: the list, the composition, the three dialogs, archiving; every change one undo step. */
import { dom, formatBrl, investments, makeDate, queries, type Id, type Ledger } from "@opesvault/domain";
import { screen, waitFor, within } from "@testing-library/react";
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
  type User,
} from "./contas_harness.tsx";

vi.mock("../../../../packages/ui/src/chart/echarts.ts", async () => await import("./fake_echarts.ts"));

const { banking } = dom;
const MARCH_31 = makeDate(2026, 3, 31);

const bankByName = (ledger: Ledger, name: string) =>
  [...banking.bankAccounts(ledger).values()].find((b) => b.name === name)!;
const memberId = (ledger: Ledger, name: string) => [...ledger.members.values()].find((m) => m.name === name)!.id;

/** Chooses a bank in the searchable list by typing part of its code. */
async function chooseBank(user: User, box: HTMLElement, typed: string, option: RegExp) {
  const field = within(box).getByRole("combobox", { name: "Banco" });
  await user.click(field);
  await user.type(field, typed);
  await user.click(await screen.findByRole("option", { name: option }));
}

async function openBank() {
  const opened = await openContas();
  const grid = await table("Contas bancárias");
  return { ...opened, grid };
}

describe("Contas bancárias", () => {
  it("lists each bank account with bank, branch, number, holders, its parts and the total", async () => {
    const { ledger, grid } = await openBank();
    for (const item of banking.bankAccounts(ledger).values()) {
      const text = flat(rowOf(grid, item.name).textContent);
      const listed = item.bank_code ? `${item.bank_code} — ` : "";
      expect(text).toContain(listed);
      expect(text).toContain(item.branch ?? "—");
    }
    const itau = flat(rowOf(grid, "Itaú da Ana").textContent);
    expect(itau).toContain("Ana e Bruno (conjunta)");
    expect(itau).toContain("341 — ITAÚ UNIBANCO");
    const nubank = flat(rowOf(grid, "Nubank do Bruno").textContent);
    expect(nubank).toContain("R$ 640,00");
    // only a checking part: savings and investments are "—"
    expect((nubank.match(/—/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });

  it("shows the composition of the selected account: parts, IRPF type, yield, maturity, tax and last bank value", async () => {
    const { ledger, user, grid } = await openBank();
    // the first account is selected by itself
    const itau = bankByName(ledger, "Itaú da Ana");
    expect(
      screen.getByText(/ITAÚ UNIBANCO S.A. \(341\), ag. 0123, conta 45678-9 · titular Ana, segundo titular Bruno/),
    ).toBeTruthy();
    let parts = await screen.findByRole("grid", { name: "Composição da conta bancária" });
    expect(flat(rowOf(parts, "Conta corrente").textContent)).toContain("06.01");
    expect(flat(rowOf(parts, "Poupança").textContent)).toContain("04.01");
    const cdb = flat(rowOf(parts, "CDB Banco X 2028").textContent);
    expect(cdb).toContain("110% do CDI");
    expect(cdb).toContain("03/01/2028");
    expect(cdb).toContain("Retido na fonte");
    expect(itau.checking_id).not.toBeNull();
    // another account: its own composition
    await pick(user, grid, "Nubank do Bruno");
    parts = await screen.findByRole("grid", { name: "Composição da conta bancária" });
    expect(within(parts).queryByText("CDB Banco X 2028")).toBeNull();
    expect(flat(parts.textContent)).toContain("Conta corrente");
  });

  it("creates a joint bank account with a new checking and savings and their opening balances; one undo reverts all", async () => {
    const { ledger, workspace, user } = await openBank();
    const before = snapshot(ledger);
    await user.click(screen.getByRole("button", { name: "Nova conta bancária…" }));
    const box = await dialog("Nova conta bancária");
    await chooseBank(user, box, "260", /^260/);
    await fill(user, box, "Agência", "0002");
    await fill(user, box, "Número da conta", "55555-5");
    await choose(user, box, "Titular", "Ana");
    await user.click(within(box).getByRole("checkbox", { name: "Conta conjunta" }));
    await choose(user, box, "Segundo titular", "Bruno");
    await user.click(within(box).getByRole("checkbox", { name: "Incluir conta corrente" }));
    await user.click(within(box).getByRole("checkbox", { name: "Incluir poupança" }));
    await fill(user, box, "Conta corrente: saldo inicial", "1.000,00");
    await fill(user, box, "Poupança: saldo inicial", "250,50");
    await fill(user, box, "Data do saldo inicial", "01/03/2026");
    await submit(user, box, "Salvar");
    await closed("Nova conta bancária");
    const item = [...banking.bankAccounts(ledger).values()].find((b) => b.number === "55555-5")!;
    expect(item).toMatchObject({
      bank_code: "260",
      branch: "0002",
      holder_id: memberId(ledger, "Ana"),
      co_holder_id: memberId(ledger, "Bruno"),
    });
    expect(item.name).toContain("NU PAGAMENTOS");
    expect(banking.joint(item)).toBe(true);
    const [checking, savings] = [ledger.account(item.checking_id!), ledger.account(item.savings_id!)];
    expect(checking.holders).toEqual([memberId(ledger, "Ana"), memberId(ledger, "Bruno")]);
    expect(formatBrl(queries.balance(ledger, checking.id))).toBe("R$ 1.000,00");
    expect(formatBrl(queries.balance(ledger, savings.id))).toBe("R$ 250,50");
    expect(await screen.findByText("Conta bancária cadastrada.")).toBeTruthy();
    expect(flat(rowOf(await table("Contas bancárias"), "55555-5").textContent)).toContain("(conjunta)");
    undoOnce(workspace);
    expect(snapshot(ledger)).toBe(before);
    expect(banking.bankAccounts(ledger).size).toBe(2);
  });

  it("accepts an institution outside the COMPE list, named by hand", async () => {
    const { ledger, user } = await openBank();
    await user.click(screen.getByRole("button", { name: "Nova conta bancária…" }));
    const box = await dialog("Nova conta bancária");
    const other = within(box).getByLabelText("Nome da instituição") as HTMLInputElement;
    expect(other.disabled).toBe(true);
    await chooseBank(user, box, "Outra", /Outra instituição/);
    expect(other.disabled).toBe(false);
    await fill(user, box, "Nome da instituição", "Cooperativa do Bairro");
    await fill(user, box, "Nome da conta", "Cooperativa");
    await user.click(within(box).getByRole("checkbox", { name: "Incluir conta corrente" }));
    await submit(user, box, "Salvar");
    await closed("Nova conta bancária");
    const item = bankByName(ledger, "Cooperativa");
    expect(item).toMatchObject({ bank_code: null, bank_name: "Cooperativa do Bairro" });
    expect(item.checking_id).not.toBeNull();
    expect(item.savings_id).toBeNull();
  });

  it("reuses an existing ledger account of the right type instead of creating one", async () => {
    const { ledger, user } = await openBank();
    const free = [...ledger.accounts.values()].find(
      (a) => a.subtype === "checking" && banking.ofAccount(ledger, a.id) === null,
    )!;
    const accounts = ledger.accounts.size;
    await user.click(screen.getByRole("button", { name: "Nova conta bancária…" }));
    const box = await dialog("Nova conta bancária");
    await chooseBank(user, box, "341", /^341/);
    await user.click(within(box).getByRole("checkbox", { name: "Incluir conta corrente" }));
    await choose(user, box, "Conta corrente: nova ou existente", `Usar ${free.name}`);
    await submit(user, box, "Salvar");
    await closed("Nova conta bancária");
    expect(ledger.accounts.size).toBe(accounts);
    expect(banking.ofAccount(ledger, free.id)).not.toBeNull();
  });

  it("refuses a missing bank, a bad branch and a repeated second holder, inside the dialog", async () => {
    const { ledger, workspace, user } = await openBank();
    const before = snapshot(ledger);
    await user.click(screen.getByRole("button", { name: "Nova conta bancária…" }));
    const box = await dialog("Nova conta bancária");
    await submit(user, box, "Salvar");
    expect(within(box).getByText("Escolha o banco na lista ou Outra instituição.")).toBeTruthy();
    await chooseBank(user, box, "341", /^341/);
    await fill(user, box, "Agência", "01 23");
    await submit(user, box, "Salvar");
    expect(within(box).getByText("Agência: use letras, números e símbolos, sem espaços (até 30).")).toBeTruthy();
    await fill(user, box, "Agência", "0123");
    await user.click(within(box).getByRole("checkbox", { name: "Conta conjunta" }));
    await choose(user, box, "Titular", "Ana");
    // the second holder cannot be the first: that option is not offered
    await user.click(within(box).getByRole("combobox", { name: "Segundo titular" }));
    expect(screen.queryByRole("option", { name: "Ana" })).toBeNull();
    expect(screen.getByRole("option", { name: "Bruno" })).toBeTruthy();
    expect(snapshot(ledger)).toBe(before);
    expect(workspace.undoStack.canUndo()).toBe(false);
  });

  it("edits an account: the name, the holders and a new savings part with an opening balance; one undo reverts", async () => {
    const { ledger, workspace, user, grid } = await openBank();
    const before = snapshot(ledger);
    const nubank = bankByName(ledger, "Nubank do Bruno");
    await pick(user, grid, "Nubank do Bruno");
    await user.click(screen.getByRole("button", { name: "Editar…" }));
    const box = await dialog("Editar conta bancária");
    expect((within(box).getByLabelText("Nome da conta") as HTMLInputElement).value).toBe("Nubank do Bruno");
    // the existing part is fixed
    expect(within(box).getByRole("checkbox", { name: "Incluir conta corrente" }).getAttribute("aria-checked")).toBe(
      "true",
    );
    expect(within(box).getByRole("checkbox", { name: "Incluir conta corrente" }).hasAttribute("disabled")).toBe(true);
    await fill(user, box, "Nome da conta", "Nubank do Bruno e da Ana");
    await user.click(within(box).getByRole("checkbox", { name: "Conta conjunta" }));
    await choose(user, box, "Segundo titular", "Ana");
    await user.click(within(box).getByRole("checkbox", { name: "Incluir poupança" }));
    await fill(user, box, "Poupança: saldo inicial", "75,00");
    await submit(user, box, "Salvar");
    await closed("Editar conta bancária");
    const saved = banking.bankAccounts(ledger).get(nubank.id)!;
    expect(saved.name).toBe("Nubank do Bruno e da Ana");
    expect(saved.co_holder_id).toBe(memberId(ledger, "Ana"));
    expect(saved.savings_id).not.toBeNull();
    expect(formatBrl(queries.balance(ledger, saved.savings_id!))).toBe("R$ 75,00");
    // the holders were passed on to the checking account too
    expect(ledger.account(saved.checking_id!).holders).toEqual([memberId(ledger, "Bruno"), memberId(ledger, "Ana")]);
    expect(await screen.findByText("Conta bancária salva.")).toBeTruthy();
    undoOnce(workspace);
    expect(snapshot(ledger)).toBe(before);
    expect(banking.bankAccounts(ledger).get(nubank.id)).toEqual(nubank);
  });

  it("records the values the bank shows on a date: a check per account, an adjustment, a valuation; one undo reverts", async () => {
    const { ledger, workspace, user, grid } = await openBank();
    const itau = bankByName(ledger, "Itaú da Ana");
    const checks = dom.balanceChecks.checks(ledger).size;
    const operations = ledger.operations.size;
    await pick(user, grid, "Itaú da Ana");
    await user.click(screen.getByRole("button", { name: "Valores em uma data…" }));
    const box = await dialog(/Valores em uma data — Itaú da Ana/);
    const list = within(box).getByRole("list", { name: "Valores por item" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(3);
    // what the app has is shown next to each item
    expect(flat(list.textContent)).toContain(formatBrl(queries.balance(ledger, itau.checking_id!)));
    // an account with operations is not adjusted by default; one tracked only by values is
    expect(
      within(box)
        .getByRole("checkbox", { name: /Conta corrente: Ajustar o saldo/ })
        .getAttribute("aria-checked"),
    ).toBe("false");
    expect(
      within(box)
        .getByRole("checkbox", { name: /Poupança: Ajustar o saldo/ })
        .getAttribute("aria-checked"),
    ).toBe("true");
    await fill(user, box, "Data dos valores", "31/03/2026");
    await fill(user, box, "Valor no banco: Poupança", "500,00");
    await fill(user, box, "Valor no banco: CDB Banco X 2028", "5.300,00");
    await fill(user, box, "Origem dos valores", "extrato de março");
    await submit(user, box, "Registrar valores");
    await closed(/Valores em uma data/);
    expect(await screen.findByText("Valores registrados.")).toBeTruthy();
    // a check for the savings account, adjusted so the app matches the bank; a valuation for the CDB
    expect(dom.balanceChecks.checks(ledger).size).toBe(checks + 1);
    expect(formatBrl(queries.balance(ledger, itau.savings_id!, MARCH_31))).toBe("R$ 500,00");
    expect(ledger.operations.size).toBe(operations + 1);
    const cdb = banking.valuesAt(ledger, itau.id, MARCH_31).find((v) => v.kind === "investment")!;
    expect(formatBrl(cdb.value!)).toBe("R$ 5.300,00");
    undoOnce(workspace);
    expect(dom.balanceChecks.checks(ledger).size).toBe(checks);
    expect(ledger.operations.size).toBe(operations);
    expect(
      formatBrl(banking.valuesAt(ledger, itau.id, MARCH_31).find((v) => v.kind === "investment")!.value!),
    ).not.toBe("R$ 5.300,00");
  });

  it("refuses an empty set of values or an amount that is not money, and says which item", async () => {
    const { workspace, user } = await openBank();
    await user.click(screen.getByRole("button", { name: "Valores em uma data…" }));
    const box = await dialog(/Valores em uma data/);
    await submit(user, box, "Registrar valores");
    expect(within(box).getByText("Informe ao menos um valor.")).toBeTruthy();
    await fill(user, box, "Valor no banco: Poupança", "abc");
    await submit(user, box, "Registrar valores");
    expect(within(box).getByText("Poupança: valor inválido, use o formato 1.234,56.")).toBeTruthy();
    await fill(user, box, "Valor no banco: Poupança", "10,00");
    await fill(user, box, "Data dos valores", "01/01/2099");
    await submit(user, box, "Registrar valores");
    expect(within(box).getByText("A data não pode estar no futuro.")).toBeTruthy();
    expect(workspace.undoStack.canUndo()).toBe(false);
  });

  it("creates an investment held at the selected account, paid from its checking account; one undo reverts", async () => {
    const { ledger, workspace, user, grid } = await openBank();
    const before = snapshot(ledger);
    const positions = investments.service.positions(ledger).size;
    const nubank = bankByName(ledger, "Nubank do Bruno");
    await pick(user, grid, "Nubank do Bruno");
    await user.click(screen.getByRole("button", { name: "Novo investimento…" }));
    const box = await dialog("Novo investimento");
    await submit(user, box, "Salvar");
    expect(within(box).getByText("Informe o nome do investimento.")).toBeTruthy();
    await fill(user, box, "Nome do investimento", "CDB Nubank 2027");
    await submit(user, box, "Salvar");
    expect(within(box).getByText("Informe o valor.")).toBeTruthy();
    await fill(user, box, "Valor aplicado", "1.000,00");
    await submit(user, box, "Salvar");
    expect(within(box).getByText("Escolha o tipo do investimento na tabela do IRPF.")).toBeTruthy();
    const kind = within(box).getByRole("combobox", { name: "Tipo do investimento (IRPF)" });
    await user.click(kind);
    await user.type(kind, "04.02");
    await user.click(await screen.findByRole("option", { name: /^04\.02/ }));
    // choosing the type suggests the tax treatment and the app's class
    expect(within(box).getByRole("combobox", { name: "Tributação" }).textContent).toContain("Retido na fonte");
    await choose(user, box, "Indexador", "CDI");
    await fill(user, box, "Taxa (%)", "105");
    await user.click(within(box).getByRole("checkbox", { name: "Vencimento: informada" }));
    await fill(user, box, "Vencimento", "15/06/2027");
    await submit(user, box, "Salvar");
    await closed("Novo investimento");
    expect(investments.service.positions(ledger).size).toBe(positions + 1);
    const position = [...investments.service.positions(ledger).values()].at(-1)!;
    const profile = investments.profile.profileOf(ledger, position.id)!;
    expect(profile).toMatchObject({ bank_account_id: nubank.id, irpf_group: "04", irpf_code: "02", indexer: "cdi" });
    expect(profile.rate!.toFixed()).toBe("105");
    expect(profile.maturity).toBe("2027-06-15");
    expect(position.holder_id).toBe(nubank.holder_id);
    // the money left the checking account
    expect(formatBrl(queries.balance(ledger, nubank.checking_id!))).toBe("-R$ 360,00");
    expect(await screen.findByText("Investimento cadastrado.")).toBeTruthy();
    expect(flat((await screen.findByRole("grid", { name: "Composição da conta bancária" })).textContent)).toContain(
      "CDB Nubank 2027",
    );
    undoOnce(workspace);
    expect(snapshot(ledger)).toBe(before);
    expect(investments.service.positions(ledger).size).toBe(positions);
  });

  it("edits the characteristics of an investment from the composition and one undo reverts", async () => {
    const { ledger, workspace, user } = await openBank();
    const itau = bankByName(ledger, "Itaú da Ana");
    const position = [...investments.service.positions(ledger).values()].find(
      (p) => investments.profile.profileOf(ledger, p.id)?.bank_account_id === itau.id,
    )!;
    const before = investments.profile.profileOf(ledger, position.id)!;
    const parts = await screen.findByRole("grid", { name: "Composição da conta bancária" });
    // a part that is not an investment explains instead of opening a dialog
    await pick(user, parts, "Conta corrente");
    await user.click(screen.getByRole("button", { name: "Características…" }));
    expect(await screen.findByText("Escolha um investimento na composição.")).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
    await pick(user, parts, "CDB Banco X 2028");
    await user.click(screen.getByRole("button", { name: "Características…" }));
    const box = await dialog("Características do investimento");
    // a new investment's own fields are not here
    expect(within(box).queryByLabelText("Valor aplicado")).toBeNull();
    expect((within(box).getByLabelText("Taxa (%)") as HTMLInputElement).value).toBe("110");
    await fill(user, box, "Taxa (%)", "112,5");
    await fill(user, box, "Emissor", "Banco X");
    await fill(user, box, "CNPJ do emissor", "11.222.333/0001-81");
    await choose(user, box, "Cobertura do FGC", "Sim");
    await submit(user, box, "Salvar");
    await closed("Características do investimento");
    const saved = investments.profile.profileOf(ledger, position.id)!;
    expect(saved.rate!.toFixed()).toBe("112.5");
    expect(saved).toMatchObject({ issuer: "Banco X", issuer_tax_id: "11222333000181", fgc: true });
    expect(await screen.findByText("Características salvas.")).toBeTruthy();
    undoOnce(workspace);
    expect(investments.profile.profileOf(ledger, position.id)).toEqual(before);
  });

  it("refuses an invalid CNPJ and a rate that is not a number in the characteristics", async () => {
    const { workspace, user } = await openBank();
    const parts = await screen.findByRole("grid", { name: "Composição da conta bancária" });
    await pick(user, parts, "CDB Banco X 2028");
    await user.click(screen.getByRole("button", { name: "Características…" }));
    const box = await dialog("Características do investimento");
    await fill(user, box, "CNPJ do emissor", "11.111.111/1111-11");
    await submit(user, box, "Salvar");
    expect(within(box).getByText("CNPJ inválido: confira os dígitos.")).toBeTruthy();
    await fill(user, box, "CNPJ do emissor", "");
    await fill(user, box, "Taxa (%)", "muito");
    await submit(user, box, "Salvar");
    expect(within(box).getByText("Taxa: use um número como 110 ou 6,5.")).toBeTruthy();
    expect(workspace.undoStack.canUndo()).toBe(false);
  });

  it("closes a bank account after a confirmation, offers Desfazer, and keeps the ledger accounts", async () => {
    const { ledger, user, grid } = await openBank();
    const nubank = bankByName(ledger, "Nubank do Bruno");
    const accounts = ledger.accounts.size;
    await pick(user, grid, "Nubank do Bruno");
    await user.click(screen.getByRole("button", { name: "Mais" }));
    await user.click(await screen.findByRole("menuitem", { name: "Encerrar conta bancária…" }));
    // cancel keeps it
    const ask = await screen.findByRole("alertdialog", { name: "Encerrar esta conta bancária?" });
    await user.click(within(ask).getByRole("button", { name: "Cancelar" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(banking.bankAccounts(ledger).get(nubank.id)!.archived).toBe(false);
    await user.click(screen.getByRole("button", { name: "Mais" }));
    await user.click(await screen.findByRole("menuitem", { name: "Encerrar conta bancária…" }));
    await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Encerrar" }));
    await waitFor(() => expect(banking.bankAccounts(ledger).get(nubank.id)!.archived).toBe(true));
    expect(within(await table("Contas bancárias")).queryByText("Nubank do Bruno")).toBeNull();
    expect(ledger.accounts.size).toBe(accounts);
    await user.click(await screen.findByRole("button", { name: "Desfazer" }));
    expect(banking.bankAccounts(ledger).get(nubank.id)!.archived).toBe(false);
    expect(within(await table("Contas bancárias")).getByText("Nubank do Bruno")).toBeTruthy();
  });

  it("asks to cadastre the holder first when the project has no members", async () => {
    const { user } = await openContas("/contas", { empty: true });
    await user.click(screen.getByRole("button", { name: "Nova conta bancária…" }));
    expect(await screen.findByText("Cadastre o titular na aba Integrantes antes.")).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Valores em uma data…" }));
    expect(await screen.findByText("Escolha a conta bancária.")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Editar…" }));
    expect(await screen.findByText("Selecione uma conta bancária.")).toBeTruthy();
  });

  it("goes back to the tab after using another one: the list and the composition are still there", async () => {
    const { user } = await openBank();
    await goTab(user, "Cartões");
    await goTab(user, "Contas bancárias");
    expect(await table("Contas bancárias")).toBeTruthy();
  });
});

export type { Id };
