import { dom, formatBrl, type Ledger } from "@opesvault/domain";
import { act as reactAct, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { findReimbursement, sharingView, summaryLine } from "../../src/pages/reembolsos/rows.ts";
import { flat, openAt, shareExpenses, type OpenOptions, type User } from "./sharing_docs_harness.tsx";
import { addressSettles, navigations, wentTo } from "../navigations.ts";

const open = (path = "/reembolsos", options: OpenOptions = { prepare: shareExpenses }) =>
  openAt(path, "Reembolsos e acertos", options);

const sharing = dom.sharing;
const only = <T,>(items: Iterable<T>): T => [...items][0]!;
const names = (ledger: Ledger) => new Map([...ledger.members.values()].map((m) => [m.id, m.name]));

const table = (name: string) => screen.findByRole("grid", { name });
const pickRow = async (user: User, gridName: string, text: string | RegExp) => {
  const grid = await table(gridName);
  await user.click(within(grid).getByText(text));
};

const snapshot = (ledger: Ledger) => ({
  operations: ledger.operations.size,
  reimbursements: JSON.stringify(
    [...sharing.reimbursements(ledger).values()].map((r) => [r.id, r.denied, r.receipt_ids]),
  ),
  settlements: sharing.settlements(ledger).size,
});

describe("Reembolsos e acertos", () => {
  it("shows the reimbursement, the balance between members and the two figures of the demonstration", async () => {
    const { ledger } = await open();
    const item = only(sharing.reimbursements(ledger).values());
    expect(sharing.state(ledger, item)).toBe("partial");
    const grid = await table("Reembolsos");
    const row = within(grid).getByText("Consulta pediatra").closest("[role=row]") as HTMLElement;
    const text = flat(row.textContent);
    expect(text).toContain("Plano de saúde");
    expect(text).toContain(flat(formatBrl(item.expected)));
    expect(text).toContain(flat(formatBrl(sharing.received(ledger, item))));
    expect(text).toContain("Recebido em parte");
    // who owes whom: the expense is Bruno's, paid from Ana's account
    const balance = only(sharing.balances(ledger));
    const members = names(ledger);
    const balances = await table("Saldos entre integrantes");
    const line = flat(within(balances).getByText(members.get(balance.debtorId)!).closest("[role=row]")!.textContent);
    expect(line).toContain(members.get(balance.creditorId)!);
    expect(line).toContain(flat(formatBrl(balance.amount)));
    // the first balance is selected and the expenses that form it are listed
    const shares = await table("Despesas que formam o saldo");
    expect(within(shares).getByText("Material escolar")).toBeTruthy();
    expect(within(shares).getByText("Presente de aniversário")).toBeTruthy();
    expect(balance.amount.eq("200")).toBe(true);
    // figures and the line under the title
    expect(screen.getByText("A receber de reembolsos")).toBeTruthy();
    expect(screen.getByText("Acertos pendentes no projeto")).toBeTruthy();
    expect(screen.getByText(/1 reembolso\(s\) a receber · 1 acerto\(s\) pendente\(s\)/)).toBeTruthy();
    expect(screen.queryByRole("grid", { name: "Acertos registrados" })).toBeNull();
  });

  it("registers a receipt (Registrar recebimento…): the missing amount is the default, and one undo reverts it", async () => {
    const { ledger, workspace, user } = await open();
    const item = only(sharing.reimbursements(ledger).values());
    const before = snapshot(ledger);
    await pickRow(user, "Reembolsos", "Consulta pediatra");
    await user.click(screen.getByRole("button", { name: "Registrar recebimento…" }));
    const dialog = await screen.findByRole("dialog", { name: "Reembolso recebido" });
    const amount = within(dialog).getByLabelText(/Valor recebido/) as HTMLInputElement;
    expect(amount.value).toBe("150,00");
    expect(within(dialog).getByRole("combobox", { name: "Recebido na conta" }).textContent).toContain("Banco A");
    await user.clear(amount);
    await user.type(amount, "100");
    await user.click(within(dialog).getByRole("button", { name: "Registrar recebimento" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Reembolso recebido" })).toBeNull());
    const after = sharing.reimbursements(ledger).get(item.id)!;
    expect(sharing.received(ledger, after).eq("250")).toBe(true);
    expect(sharing.state(ledger, after)).toBe("partial");
    expect(await screen.findByText("Reembolso recebido: a despesa líquida foi reduzida.")).toBeTruthy();
    expect(flat((await table("Reembolsos")).textContent)).toContain("R$ 250,00");
    reactAct(() => void workspace.undo());
    expect(snapshot(ledger)).toEqual(before);
    // receiving all that is left finishes it
    await user.click(screen.getByRole("button", { name: "Registrar recebimento…" }));
    const again = await screen.findByRole("dialog", { name: "Reembolso recebido" });
    await user.click(within(again).getByRole("button", { name: "Registrar recebimento" }));
    await waitFor(() => expect(sharing.state(ledger, sharing.reimbursements(ledger).get(item.id)!)).toBe("received"));
    expect(flat((await table("Reembolsos")).textContent)).toContain("Recebido");
  });

  it("refuses an empty, zero or malformed receipt inside the dialog and writes nothing", async () => {
    const { ledger, user } = await open();
    const before = snapshot(ledger);
    await pickRow(user, "Reembolsos", "Consulta pediatra");
    await user.click(screen.getByRole("button", { name: "Registrar recebimento…" }));
    const dialog = await screen.findByRole("dialog", { name: "Reembolso recebido" });
    const amount = within(dialog).getByLabelText(/Valor recebido/);
    const submit = () => user.click(within(dialog).getByRole("button", { name: "Registrar recebimento" }));
    await user.clear(amount);
    await submit();
    expect(within(dialog).getByText("Informe o valor.")).toBeTruthy();
    await user.type(amount, "0,00");
    await submit();
    expect(within(dialog).getByText("Informe um valor positivo.")).toBeTruthy();
    await user.clear(amount);
    await user.type(amount, "abc");
    await submit();
    expect(within(dialog).getAllByText(/Valor inválido/).length).toBeGreaterThan(0);
    expect(snapshot(ledger)).toEqual(before);
    await user.click(within(dialog).getByRole("button", { name: "Cancelar" }));
    expect(snapshot(ledger)).toEqual(before);
  });

  it("opens the receipt by double click or Enter on the row", async () => {
    const { user } = await open();
    const grid = await table("Reembolsos");
    await user.dblClick(within(grid).getByText("Consulta pediatra"));
    expect(await screen.findByRole("dialog", { name: "Reembolso recebido" })).toBeTruthy();
  });

  it("asks to select a reimbursement instead of opening a dialog when none is selected", async () => {
    const { user } = await open();
    for (const name of ["Registrar recebimento…", "Negado…", "Ver lançamento"]) {
      await user.click(screen.getByRole("button", { name }));
      expect((await screen.findAllByText("Selecione um reembolso na tabela.")).length).toBeGreaterThan(0);
      expect(screen.queryByRole("dialog")).toBeNull();
    }
  });

  it("marks a reimbursement as denied with a reason (Negado…), and one undo reverts it", async () => {
    const { ledger, workspace, user } = await open();
    const item = only(sharing.reimbursements(ledger).values());
    const before = snapshot(ledger);
    await pickRow(user, "Reembolsos", "Consulta pediatra");
    await user.click(screen.getByRole("button", { name: "Negado…" }));
    const dialog = await screen.findByRole("dialog", { name: "Reembolso negado" });
    await user.click(within(dialog).getByRole("button", { name: "Marcar como negado" }));
    expect(within(dialog).getByText("O motivo é obrigatório.")).toBeTruthy();
    expect(sharing.reimbursements(ledger).get(item.id)!.denied).toBe(false);
    await user.type(within(dialog).getByLabelText("Motivo"), "Fora da cobertura");
    await user.click(within(dialog).getByRole("button", { name: "Marcar como negado" }));
    await waitFor(() => expect(sharing.reimbursements(ledger).get(item.id)!.denied).toBe(true));
    expect(flat((await table("Reembolsos")).textContent)).toContain("Negado");
    // nothing is waiting any more
    expect(sharingView(ledger).waiting.isZero()).toBe(true);
    expect(screen.queryByText(/1 reembolso\(s\) a receber/)).toBeNull();
    // a denied reimbursement takes no receipt
    await user.click(screen.getByRole("button", { name: "Registrar recebimento…" }));
    const receive = await screen.findByRole("dialog", { name: "Reembolso recebido" });
    await user.click(within(receive).getByRole("button", { name: "Registrar recebimento" }));
    expect(await within(receive).findByText("Reembolso negado não recebe valores.")).toBeTruthy();
    await user.click(within(receive).getByRole("button", { name: "Cancelar" }));
    reactAct(() => void workspace.undo());
    expect(snapshot(ledger)).toEqual(before);
  });

  it("registers a settlement from the selected balance and one undo reverts it", async () => {
    const { ledger, workspace, user } = await open();
    const balance = only(sharing.balances(ledger));
    const members = names(ledger);
    const before = snapshot(ledger);
    await user.click(screen.getByRole("button", { name: "Registrar acerto…" }));
    const dialog = await screen.findByRole("dialog", { name: "Registrar acerto" });
    // the pair and amount of the selected balance
    expect(within(dialog).getByRole("combobox", { name: "Quem pagou" }).textContent).toContain(
      members.get(balance.debtorId)!,
    );
    expect(within(dialog).getByRole("combobox", { name: "Para quem" }).textContent).toContain(
      members.get(balance.creditorId)!,
    );
    const value = within(dialog).getByLabelText(/^Valor/) as HTMLInputElement;
    expect(value.value).toBe(flat(formatBrl(balance.amount)).replace("R$", "").trim());
    await user.clear(value);
    await user.type(value, "100,00");
    await user.type(within(dialog).getByLabelText("Observação"), "Pix de sábado");
    await user.click(within(dialog).getByRole("button", { name: "Registrar" }));
    await waitFor(() => expect(sharing.settlements(ledger).size).toBe(1));
    const settlement = only(sharing.settlements(ledger).values());
    expect(settlement.amount.eq("100")).toBe(true);
    expect(settlement.note).toBe("Pix de sábado");
    expect(await screen.findByText("Acerto registrado.")).toBeTruthy();
    // the history section appears and the balance went down by what was paid
    const history = await table("Acertos registrados");
    expect(flat(history.textContent)).toContain("Pix de sábado");
    const next = only(sharing.balances(ledger));
    expect(next.amount.eq(balance.amount.sub("100"))).toBe(true);
    expect(next.settled.eq("100")).toBe(true);
    reactAct(() => void workspace.undo());
    expect(snapshot(ledger)).toEqual(before);
    await waitFor(() => expect(screen.queryByRole("grid", { name: "Acertos registrados" })).toBeNull());
  });

  it("refuses the same member twice and a bad amount in the settlement, writing nothing", async () => {
    const { ledger, user } = await open();
    const before = snapshot(ledger);
    await user.click(screen.getByRole("button", { name: "Registrar acerto…" }));
    const dialog = await screen.findByRole("dialog", { name: "Registrar acerto" });
    const submit = () => user.click(within(dialog).getByRole("button", { name: "Registrar" }));
    const payer = names(ledger).get(only(sharing.balances(ledger)).creditorId)!;
    await user.click(within(dialog).getByRole("combobox", { name: "Quem pagou" }));
    await user.click(await screen.findByRole("option", { name: payer }));
    await submit();
    expect(within(dialog).getByText("Escolha dois integrantes diferentes.")).toBeTruthy();
    await user.click(within(dialog).getByRole("combobox", { name: "Para quem" }));
    await user.click(await screen.findByRole("option", { name: "Bruno" }));
    const value = within(dialog).getByLabelText(/^Valor/);
    await user.clear(value);
    await submit();
    expect(within(dialog).getByText("Informe o valor.")).toBeTruthy();
    await user.type(value, "0");
    await submit();
    expect(within(dialog).getByText("Informe um valor positivo.")).toBeTruthy();
    expect(snapshot(ledger)).toEqual(before);
  });

  it("opens the operation behind a reimbursement and behind a share in the Livro (ref = operation id)", async () => {
    const { ledger, router, user } = await open();
    const item = only(sharing.reimbursements(ledger).values());
    await pickRow(user, "Reembolsos", "Consulta pediatra");
    const went = navigations(router);
    await user.click(screen.getByRole("button", { name: "Ver lançamento" }));
    await wentTo(went, "/livro", { ref: item.operation_id });
  });

  it("opens the operation of a share from the expenses that form the balance", async () => {
    const { ledger, router, user } = await open();
    const shares = await table("Despesas que formam o saldo");
    await user.click(within(shares).getByText("Material escolar"));
    const bar = (await screen.findByText("Selecionado:")).closest("div")!.parentElement!;
    const went = navigations(router);
    await user.click(within(bar).getByRole("button", { name: "Ver lançamento" }));
    const operation = [...ledger.operations.values()].find((o) => o.description === "Material escolar")!;
    await wentTo(went, "/livro", { ref: operation.id });
  });

  it("follows a link from another screen: selects the reimbursement and starts the receipt", async () => {
    const { ledger, router } = await open();
    const item = only(sharing.reimbursements(ledger).values());
    expect(findReimbursement(sharingView(ledger).reimbursements, item.operation_id)?.id).toBe(item.id);
    expect(findReimbursement(sharingView(ledger).reimbursements, `reembolso:${item.id}`)?.id).toBe(item.id);
    expect(findReimbursement(sharingView(ledger).reimbursements, "nao-existe")).toBeNull();
    await reactAct(() => router.navigate({ to: "/reembolsos", search: { ref: item.operation_id, act: "receber" } }));
    expect(await screen.findByRole("dialog", { name: "Reembolso recebido" })).toBeTruthy();
    await addressSettles(router, {});
  });

  it("shows a message for a link to a reimbursement that no longer exists", async () => {
    const { router } = await open();
    await reactAct(() => router.navigate({ to: "/reembolsos", search: { ref: "sumiu" } }));
    expect(await screen.findByText("Esse reembolso não existe mais.")).toBeTruthy();
  });

  it("in an empty project says there is nothing to receive or settle and offers the way forward", async () => {
    const { router, user } = await open("/reembolsos", { empty: true });
    expect(await screen.findByRole("heading", { name: "Nada a receber nem a acertar" })).toBeTruthy();
    expect(screen.queryByRole("grid")).toBeNull();
    expect(screen.queryByRole("listbox")).toBeNull();
    // a settlement can be registered even with nothing pending
    await user.click(screen.getByRole("button", { name: "Registrar acerto…" }));
    const dialog = await screen.findByRole("dialog", { name: "Registrar acerto" });
    await user.click(within(dialog).getByRole("button", { name: "Cancelar" }));
    await user.click(screen.getByRole("button", { name: "Abrir o Livro financeiro" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/livro"));
  });

  it("is read only while another tab edits: no change can be started, but the operation can be opened", async () => {
    const { workspace, user } = await open();
    reactAct(() => workspace.setReadOnly(true));
    await pickRow(user, "Reembolsos", "Consulta pediatra");
    for (const name of ["Registrar recebimento…", "Negado…", "Registrar acerto…"]) {
      expect((screen.getByRole("button", { name }) as HTMLButtonElement).disabled, name).toBe(true);
    }
    expect((screen.getByRole("button", { name: "Ver lançamento" }) as HTMLButtonElement).disabled).toBe(false);
    // double click does not open the receipt either
    const grid = await table("Reembolsos");
    await user.dblClick(within(grid).getByText("Consulta pediatra"));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("builds the line under the title from what is open", async () => {
    const { ledger } = await open();
    const view = sharingView(ledger);
    expect(summaryLine(view)).toBe("1 reembolso(s) a receber · 1 acerto(s) pendente(s)");
    expect(summaryLine({ ...view, openCount: 0, balances: [] })).toBe("");
  });
});
