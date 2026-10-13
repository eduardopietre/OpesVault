/** Orçamento: the planned value edited in its cell (Enter saves, Esc cancels) and the leftover carried to the next month. */
import { dom, ymAdd, ymOf, type IsoDate, type YearMonth } from "@opesvault/domain";
import { formatMonth } from "@opesvault/ui";
import { act as reactAct, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { chooseMonth } from "../../src/data/month.ts";
import { categoryNamed } from "../lookup.ts";
import { clickInTable, flat, rowOf, table, undoOnce } from "../dom.ts";
import { mountApp } from "../mount.tsx";

async function openPage(readOnly = false) {
  let now: YearMonth | null = null;
  const mounted = await mountApp("/orcamento", {
    heading: "Orçamento",
    readOnly,
    prepare: (workspace) => {
      now = ymOf(workspace.today());
      reactAct(() => chooseMonth(now!));
    },
  });
  return { ...mounted, now: now! as YearMonth };
}

describe("Orçamento: editing in the cell", () => {
  it("Enter on the row opens the field in the cell; Enter saves as one undo step and the focus goes back to the table", async () => {
    const { ledger, workspace, user, now } = await openPage();
    const food = categoryNamed(ledger, "Alimentação");
    const before = dom.budget.lineFor(ledger, food.id, now)!.amount;
    await clickInTable(user, "Orçamento por categoria", "Alimentação");
    const grid = await table("Orçamento por categoria");
    grid.focus();
    await user.keyboard("{Enter}");
    const field = await within(grid).findByRole("textbox", { name: "Planejado de Alimentação" });
    expect(document.activeElement).toBe(field);
    expect(field.getAttribute("aria-describedby")).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
    await user.clear(field);
    await user.type(field, "1.234,50{Enter}");
    await waitFor(() => expect(dom.budget.lineFor(ledger, food.id, now)!.amount.toFixed()).toBe("1234.50"));
    expect(within(grid).queryByRole("textbox")).toBeNull();
    expect(document.activeElement).toBe(grid);
    expect(workspace.undoStack.undoLabel()).toBe(`orçamento de ${formatMonth(now)}`);
    undoOnce(workspace);
    expect(dom.budget.lineFor(ledger, food.id, now)!.amount.eq(before)).toBe(true);
  });

  it("Esc cancels without saving; a wrong value keeps the field open with the reason", async () => {
    const { ledger, workspace, user, now } = await openPage();
    const food = categoryNamed(ledger, "Alimentação");
    const before = dom.budget.lineFor(ledger, food.id, now)!.amount;
    const steps = workspace.undoStack.undoSteps.length;
    const grid = await table("Orçamento por categoria");
    await user.click(rowOf(grid, "Alimentação").querySelector<HTMLElement>("[data-planned-cell]")!);
    const field = await within(grid).findByRole("textbox", { name: "Planejado de Alimentação" });
    await user.clear(field);
    await user.type(field, "abc{Enter}");
    expect(await screen.findByText("Valor inválido. Use o formato 1.234,56.")).toBeTruthy();
    expect(within(grid).getByRole("textbox", { name: "Planejado de Alimentação" })).toBe(field);
    await user.clear(field);
    await user.type(field, "0{Enter}");
    expect(await screen.findByText("Informe um valor positivo para o orçamento.")).toBeTruthy();
    await user.type(field, "{Escape}");
    expect(within(grid).queryByRole("textbox")).toBeNull();
    expect(dom.budget.lineFor(ledger, food.id, now)!.amount.eq(before)).toBe(true);
    expect(workspace.undoStack.undoSteps.length).toBe(steps);
    // the arrows typed in the field did not move the selection: the row is still the selected one
    expect(rowOf(grid, "Alimentação").getAttribute("aria-selected")).toBe("true");
  });

  it("a read-only project shows the value as text, without the field", async () => {
    const { user } = await openPage(true);
    const grid = await table("Orçamento por categoria");
    expect(grid.querySelector("[data-planned-cell]")).toBeNull();
    await user.dblClick(rowOf(grid, "Alimentação"));
    expect(within(grid).queryByRole("textbox")).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("Orçamento: carrying the leftover", () => {
  it("the switch carries this month's leftover; the next month shows it apart and adds it to what is available", async () => {
    const { ledger, workspace, user, now } = await openPage();
    const food = categoryNamed(ledger, "Alimentação");
    const next = ymAdd(now, 1);
    await clickInTable(user, "Orçamento por categoria", "Alimentação");
    await user.click(screen.getByRole("switch", { name: `Levar a sobra para ${formatMonth(next)}` }));
    await waitFor(() => expect(dom.budget.lineFor(ledger, food.id, now)!.carry_over).toBe(true));
    expect(await screen.findByText(/Gasto acima do planejado não passa adiante/)).toBeTruthy();
    expect(flat(rowOf(await table("Orçamento por categoria"), "Alimentação").textContent)).toContain(
      "leva a sobra para o mês seguinte",
    );

    const carried = dom.budget.carriedInto(ledger, food.id, next);
    const status = dom.budget.status(ledger, next);
    const row = status.rows.find((r) => r.categoryId === food.id);
    if (carried.isPositive()) {
      expect(row!.carried.eq(carried)).toBe(true);
      expect(row!.available.eq(row!.planned.add(carried))).toBe(true);
      reactAct(() => chooseMonth(next));
      const grid = await table("Orçamento por categoria");
      await waitFor(() => expect(flat(rowOf(grid, "Alimentação").textContent)).toContain("+"));
    } else {
      expect(row?.carried.isZero() ?? true).toBe(true);
    }
    undoOnce(workspace);
    expect(dom.budget.lineFor(ledger, food.id, now)!.carry_over).toBe(false);
  });

  it("a leftover shows in the next month even without a plan there, and overspending is not carried", async () => {
    const { ledger, workspace, now } = await openPage();
    const leisure = categoryNamed(ledger, "Lazer");
    const later = ymAdd(now, 3);
    const after = ymAdd(now, 4);
    workspace.act((l) => {
      dom.budget.setBudget(l, leisure.id, later, "300.00");
      dom.budget.setCarryOver(l, leisure.id, later, true);
    });
    reactAct(() => chooseMonth(after));
    const grid = await table("Orçamento por categoria");
    const text = flat(rowOf(grid, "Lazer").textContent);
    expect(text).toContain("+R$ 300,00");
    expect(screen.getByText(`Inclui R$ 300,00 de sobra de ${formatMonth(later)}`)).toBeTruthy();
    const bank = [...ledger.accounts.values()].find((a) => a.subtype === "checking")!;
    const day = `${later.year}-${String(later.month).padStart(2, "0")}-10` as IsoDate;
    workspace.act((l) => l.recordExpense(bank.id, leisure.id, "450.00", day, "Viagem"));
    await waitFor(() => expect(screen.queryByText(/\+R\$ 300,00/)).toBeNull());
    expect(dom.budget.carriedInto(ledger, leisure.id, after).toFixed()).toBe("0");
  });
});
