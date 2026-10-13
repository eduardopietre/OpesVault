/** Contas e cartões › Categorias: rename, archive and bring back, and merge two categories into one. */
import { AccountSubtype, AccountType, LedgerAccountSchema, dom, type IsoDate } from "@opesvault/domain";
import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { pinToday } from "../clock.ts";
import { openContas } from "./contas_harness.tsx";
import { choose, clickRow, closed, dialog, fill, flat, goTab, rowOf, submit, table, undoOnce } from "../dom.ts";
import { accountNamed, categoryNamed } from "../lookup.ts";
import { categoryRows, mergeTargets } from "../../src/pages/contas/rows.ts";

describe("Categorias rows", () => {
  it("leave the archived categories out unless asked, and offer as merge targets only active ones of the same kind", async () => {
    const { ledger, workspace } = await openContas();
    const leisure = categoryNamed(ledger, "Lazer");
    const cinema = workspace.act((l) =>
      l.addAccount(
        LedgerAccountSchema.parse({
          name: "Cinema",
          type: AccountType.EXPENSE,
          subtype: AccountSubtype.CATEGORY,
          parent_id: leisure.id,
        }),
      ),
    );
    workspace.act((l) => dom.categories.setArchived(l, categoryNamed(l, "Educação").id, true));
    expect(categoryRows(ledger).some((r) => r.name === "Educação")).toBe(false);
    expect(categoryRows(ledger, true).find((r) => r.name === "Educação")!.archived).toBe(true);
    const targets = mergeTargets(ledger, leisure.id).map((t) => t.label);
    expect(targets).toContain("Alimentação");
    expect(targets).not.toContain("Lazer");
    expect(targets).not.toContain("Cinema"); // inside the source
    expect(targets).not.toContain("Educação"); // archived
    expect(targets).not.toContain("Salário"); // income
    expect(mergeTargets(ledger, cinema.id).map((t) => t.label)).toContain("Lazer");
  });
});

describe("Categorias", () => {
  pinToday(2026, 10, 6);

  it("renames the selected category; a taken name is refused in the dialog; one undo reverts", async () => {
    const { ledger, workspace, user } = await openContas();
    await goTab(user, "Categorias");
    await clickRow(user, await table("Categorias"), "Lazer");
    await user.click(screen.getByRole("button", { name: "Renomear…" }));
    const box = await dialog("Renomear categoria");
    await fill(user, box, "Nome", "Alimentação");
    await submit(user, box, "Renomear");
    expect(within(box).getByText(/Já existe a categoria “Alimentação”/)).toBeTruthy();
    await fill(user, box, "Nome", "Passeios");
    await submit(user, box, "Renomear");
    await closed("Renomear categoria");
    const id = accountNamed(ledger, "Passeios").id;
    expect(await screen.findByText("Categoria renomeada para “Passeios”.")).toBeTruthy();
    expect(rowOf(await table("Categorias"), "Passeios")).toBeTruthy();
    expect(workspace.undoStack.undoLabel()).toBe("renomear categoria");
    undoOnce(workspace);
    expect(ledger.account(id).name).toBe("Lazer");
  });

  it("archives a category (it leaves the list), shows it with the switch and brings it back", async () => {
    const { ledger, workspace, user } = await openContas();
    const education = categoryNamed(ledger, "Educação");
    await goTab(user, "Categorias");
    await clickRow(user, await table("Categorias"), "Educação");
    await user.click(screen.getByRole("button", { name: "Arquivar" }));
    expect(await screen.findByText("Categoria “Educação” arquivada.")).toBeTruthy();
    expect(ledger.account(education.id).archived).toBe(true);
    expect(within(await table("Categorias")).queryByText("Educação")).toBeNull();

    await user.click(screen.getByRole("switch", { name: "Mostrar arquivadas" }));
    expect(flat(rowOf(await table("Categorias"), "Educação").textContent)).toContain("Arquivada");
    await clickRow(user, await table("Categorias"), "Educação");
    await user.click(screen.getByRole("button", { name: "Reativar" }));
    expect(await screen.findByText("Categoria “Educação” reativada.")).toBeTruthy();
    expect(ledger.account(education.id).archived).toBe(false);
    undoOnce(workspace);
    expect(ledger.account(education.id).archived).toBe(true);
  });

  it("merges after a confirmation that says how many entries move, as one undo step", async () => {
    const { ledger, workspace, user } = await openContas();
    const bank = [...ledger.accounts.values()].find((a) => a.subtype === AccountSubtype.CHECKING)!;
    const bakery = workspace.act((l) =>
      l.addAccount(
        LedgerAccountSchema.parse({ name: "Padaria", type: AccountType.EXPENSE, subtype: AccountSubtype.CATEGORY }),
      ),
    );
    for (const on of ["2026-10-02", "2026-10-03"] as IsoDate[]) {
      workspace.act((l) => l.recordExpense(bank.id, bakery.id, "12.50", on, "Pão"));
    }
    workspace.act((l) => dom.budget.setBudget(l, bakery.id, { year: 2026, month: 10 }, "100.00"));
    const food = categoryNamed(ledger, "Alimentação");
    const foodBudget = dom.budget.lineFor(ledger, food.id, { year: 2026, month: 10 })?.amount ?? null;

    await goTab(user, "Categorias");
    await clickRow(user, await table("Categorias"), "Padaria");
    await user.click(screen.getByRole("button", { name: "Mesclar…" }));
    const box = await dialog("Mesclar “Padaria”");
    await submit(user, box, "Continuar…");
    expect(within(box).getByText("Escolha a categoria de destino.")).toBeTruthy();
    await choose(user, "Mesclar em", "Alimentação", box);
    await submit(user, box, "Continuar…");
    const ask = await screen.findByRole("alertdialog", { name: "Mesclar “Padaria” em “Alimentação”?" });
    expect(flat(ask.textContent)).toContain("2 lançamentos passam para “Alimentação”");
    await user.click(within(ask).getByRole("button", { name: "Mesclar" }));
    await waitFor(() => expect(ledger.account(bakery.id).archived).toBe(true));
    expect(await screen.findByText("“Padaria” mesclada em “Alimentação”: 2 lançamentos movidos.")).toBeTruthy();
    expect(dom.categories.operationsUsing(ledger, bakery.id)).toHaveLength(0);
    const line = dom.budget.lineFor(ledger, food.id, { year: 2026, month: 10 })!;
    expect(line.amount.toFixed()).toBe(foodBudget ? foodBudget.add("100.00").toFixed() : "100.00");
    expect(workspace.undoStack.undoLabel()).toBe("mesclar categorias");

    undoOnce(workspace);
    expect(ledger.account(bakery.id).archived).toBe(false);
    expect(dom.categories.operationsUsing(ledger, bakery.id)).toHaveLength(2);
    expect(dom.budget.lineFor(ledger, bakery.id, { year: 2026, month: 10 })!.amount.toFixed()).toBe("100.00");
  });

  it("keeps everything when the merge is not confirmed", async () => {
    const { ledger, user } = await openContas();
    const leisure = categoryNamed(ledger, "Lazer");
    const before = dom.categories.operationsUsing(ledger, leisure.id).length;
    await goTab(user, "Categorias");
    await clickRow(user, await table("Categorias"), "Lazer");
    await user.click(screen.getByRole("button", { name: "Mesclar…" }));
    const box = await dialog("Mesclar “Lazer”");
    await choose(user, "Mesclar em", "Outras despesas", box);
    await submit(user, box, "Continuar…");
    const ask = await screen.findByRole("alertdialog", { name: /Mesclar “Lazer” em “Outras despesas”/ });
    await user.click(within(ask).getByRole("button", { name: "Cancelar" }));
    expect(ledger.account(leisure.id).archived).toBe(false);
    expect(dom.categories.operationsUsing(ledger, leisure.id)).toHaveLength(before);
  });
});
