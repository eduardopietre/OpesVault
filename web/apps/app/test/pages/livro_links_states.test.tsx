/**
 * The Livro as other pages reach it (`useReveal`: an operation, a category and month, an account, a tag), and
 * its states: an empty project (TA-31), read-only, the keyboard and a phone. Companion of `livro.test.tsx`.
 */
import { LedgerAccountSchema, dom } from "@opesvault/domain";
import { act, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  account,
  category,
  count,
  dialog,
  grid,
  menu,
  openLivro,
  pickRow,
  rowsWith,
  type Opened,
} from "./livro_harness.tsx";

const rowCount = () => grid().querySelectorAll("[data-row-id]").length;

/** What another page does: `useGoTo()("livro", { ref, act })`. */
async function goToLivro(o: Opened, search: { ref?: string; act?: string }) {
  await act(async () => {
    await o.router.navigate({ to: "/livro", search });
  });
}

describe("Livro: vindo de outras páginas (useReveal)", () => {
  it("selects an operation by its id, and `editar` opens the correction", async () => {
    const o = await openLivro();
    const op = [...o.workspace.ledger.operations.values()].find((x) => x.description === "Posto Shell")!;
    await goToLivro(o, { ref: op.id, act: "editar" });
    const d = await dialog("Corrigir lançamento");
    expect(within(d).getByLabelText("Descrição")).toBeTruthy();
    await waitFor(() =>
      expect(grid().querySelector(`[data-row-id="${op.id}"]`)?.getAttribute("aria-selected")).toBe("true"),
    );
    // the link is consumed: a reload or a back does not repeat it
    expect(o.router.state.location.search).toEqual({});
  });

  it("filters by a category and month, including its subcategories, and sets the shared month", async () => {
    const o = await openLivro();
    const ledger = o.workspace.ledger;
    const alimentacao = category(o, "Alimentação");
    const child = o.workspace.act((l) =>
      l.addAccount(
        LedgerAccountSchema.parse({
          name: "Padarias",
          type: alimentacao.type,
          subtype: alimentacao.subtype,
          parent_id: alimentacao.id,
        }),
      ),
    );
    o.workspace.act((l) => l.recordExpense(account(o, "Banco A").id, child.id, "20.00", "2026-03-20" as never, "Pão"));
    const wanted = (id: string) =>
      [...ledger.operations.values()].filter(
        (op) =>
          op.postings.some((p) => p.account_id === id || ledger.accounts.get(p.account_id)?.parent_id === id) &&
          (op.occurred_on ?? "").startsWith("2026-03"),
      ).length;
    expect(wanted(alimentacao.id)).toBeGreaterThan(wanted(child.id));
    await goToLivro(o, { ref: `categoria:${alimentacao.id}:2026-03` });
    await waitFor(() => expect(rowCount()).toBe(wanted(alimentacao.id)));
    expect(rowsWith(/Padarias/).length).toBe(1);
    expect(screen.getByRole("combobox", { name: "Período" }).textContent).toContain("Março de 2026");
    expect(screen.getByRole("combobox", { name: "Conta ou categoria" }).textContent).toContain("Alimentação");
  });

  it("filters by an account and a month, or a range of dates, as the calendar and the overview send", async () => {
    const o = await openLivro();
    const bank = account(o, "Banco A").id;
    const mine = (from: string, to: string) =>
      [...o.workspace.ledger.operations.values()].filter(
        (op) =>
          op.postings.some((p) => p.account_id === bank) &&
          (op.occurred_on ?? "") >= from &&
          (op.occurred_on ?? "") <= to,
      ).length;
    await goToLivro(o, { ref: `filter:${bank}:2026-03` });
    await waitFor(() => expect(rowCount()).toBe(mine("2026-03-01", "2026-03-31")));
    expect(screen.getByRole("combobox", { name: "Período" }).textContent).toContain("Março de 2026");
    await goToLivro(o, { ref: `filter:${bank}:2026-02-01..2026-02-28` });
    await waitFor(() => expect(rowCount()).toBe(mine("2026-02-01", "2026-02-28")));
    expect(screen.getByRole("combobox", { name: "Período" }).textContent).toContain("Personalizado");
    expect((screen.getByLabelText("Data inicial") as HTMLInputElement).value).toBe("01/02/2026");
    // for a member as well
    const ana = [...o.workspace.ledger.members.values()].find((m) => m.name === "Ana")!;
    await goToLivro(o, { ref: `filter:${bank}:2026-03:${ana.id}` });
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Integrante" }).textContent).toContain("Ana"));
  });

  it("filters by an account and by a tag", async () => {
    const o = await openLivro();
    await goToLivro(o, { ref: `conta:${account(o, "Cartão X").id}` });
    await waitFor(() =>
      expect(screen.getByRole("combobox", { name: "Conta ou categoria" }).textContent).toBe("Cartão X"),
    );
    await goToLivro(o, { ref: "marcador:Viagem Serra 2026" });
    await waitFor(() =>
      expect(screen.getByRole("combobox", { name: "Marcador" }).textContent).toContain("Viagem Serra 2026"),
    );
    expect(rowCount()).toBe(dom.tags.operationsWith(o.workspace.ledger, "Viagem Serra 2026").size);
  });

  it("opens Novo lançamento with `novo`", async () => {
    const o = await openLivro();
    await goToLivro(o, { act: "novo" });
    expect(await dialog("Despesa")).toBeTruthy();
  });

  it("opens with the link already in the address", async () => {
    await openLivro("/livro?act=novo");
    expect(await dialog("Despesa")).toBeTruthy();
  });

  it("goes on to another page from the empty state", async () => {
    const o = await openLivro("/livro", { empty: true });
    await o.user.click(await screen.findByRole("button", { name: "Importar e revisar" }));
    await waitFor(() => expect(o.router.state.location.pathname).toBe("/importar"));
  });
});

describe("Livro: estados", () => {
  it("shows an empty project without crashing (TA-31)", async () => {
    const o = await openLivro("/livro", { empty: true });
    expect(await screen.findByText("Nenhum lançamento ainda")).toBeTruthy();
    expect(screen.getByText("0 lançamentos")).toBeTruthy();
    expect(screen.queryByRole("grid")).toBeNull();
    await menu(o.user, "Exportar", "Livro completo (CSV)");
    expect(await screen.findByText("Não há lançamentos para exportar com estes filtros.")).toBeTruthy();
  });

  it("disables the editing commands when the project is open read-only", async () => {
    const o = await openLivro();
    act(() => o.workspace.setReadOnly(true));
    await o.user.click(await screen.findByRole("button", { name: "Novo lançamento" }));
    expect((await screen.findByRole("menuitem", { name: "Despesa" })).getAttribute("aria-disabled")).toBe("true");
  });

  it("marks the current row with Space and shows the count", async () => {
    const o = await openLivro();
    await pickRow(o.user, "Aluguel");
    await o.user.keyboard(" ");
    expect(await screen.findByText("1 marcado")).toBeTruthy();
    await o.user.keyboard(" ");
    await waitFor(() => expect(screen.queryByText("1 marcado")).toBeNull());
  });

  it("marks and unmarks the current row from the Ações menu (the way on a phone)", async () => {
    const o = await openLivro();
    await pickRow(o.user, "Aluguel");
    await menu(o.user, "Ações", "Marcar este lançamento");
    expect(await screen.findByText("1 marcado")).toBeTruthy();
    await menu(o.user, "Ações", "Desmarcar este lançamento");
    await waitFor(() => expect(screen.queryByText("1 marcado")).toBeNull());
  });

  it("ticks everything the filters show from the Ações menu, and clears it", async () => {
    const o = await openLivro();
    await menu(o.user, "Ações", /Marcar os \d+ exibidos/);
    expect(await screen.findByText(`${count(o)} marcados`)).toBeTruthy();
    await o.user.click(screen.getAllByRole("button", { name: "Limpar marcação" })[0]!);
    await waitFor(() => expect(screen.queryByText(`${count(o)} marcados`)).toBeNull());
  });

  it("on a phone a tap on an operation opens the details sheet with the commands", async () => {
    const o = await openLivro("/livro", { width: 390 });
    // (the cards themselves depend on the measured width, which the test environment does not have)
    await o.user.click(within(grid()).getAllByRole("row")[1] as HTMLElement);
    const sheet = await screen.findByRole("dialog", { name: "Detalhes do lançamento" });
    expect(within(sheet).getByRole("button", { name: "Mais ações" })).toBeTruthy();
    expect(within(sheet).getByRole("button", { name: "Corrigir" })).toBeTruthy();
  });
});
