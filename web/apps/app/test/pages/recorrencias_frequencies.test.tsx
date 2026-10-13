/** Recorrências: the frequencies of schema 3 in the dialog and the table, and deleting a rule. */
import { dom } from "@opesvault/domain";
import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { pinToday } from "../clock.ts";
import { dayLabel, frequencyLabel } from "../../src/pages/recorrencias/rows.ts";
import { linkCount, openPage, rules, seedExpense, seedRule } from "./recorrencias_harness.tsx";
import { choose, clickInTable, flat, rowById, undoOnce } from "../dom.ts";

const open = () => openPage("/recorrencias", "Recorrências");

describe("Recorrências rows (schema 3)", () => {
  it("names each frequency and the days a rule falls on", () => {
    const rule = { day: 5, frequency: "semimonthly", interval_months: null } as dom.recurrence.RecurrenceRule;
    expect(dayLabel(rule)).toBe("5 e 20");
    expect(dayLabel({ ...rule, day: 28 })).toBe("13 e 28");
    expect(dayLabel({ ...rule, frequency: "last_business_day" })).toBe("—");
    expect(frequencyLabel(rule)).toBe("Quinzenal");
    expect(frequencyLabel({ ...rule, frequency: "quarterly" })).toBe("Trimestral");
    expect(frequencyLabel({ ...rule, frequency: "every_n_months", interval_months: 4 })).toBe("A cada 4 meses");
    expect(frequencyLabel({ ...rule, frequency: "last_business_day" })).toBe("Último dia útil do mês");
  });
});

describe("Recorrências (schema 3)", () => {
  pinToday(2026, 10, 6);

  it("creates a rule every N months, asking how many, and one on the last business day without a day", async () => {
    const { ledger, user } = await open();
    await user.click(screen.getByRole("button", { name: "Nova recorrência…" }));
    const dialog = await screen.findByRole("dialog", { name: "Nova recorrência" });
    const field = (label: string) => within(dialog).getByLabelText(label) as HTMLInputElement;
    await user.type(field("Descrição"), "IPVA");
    await choose(user, "Conta", "Banco A", dialog);
    await choose(user, "Categoria", "Despesa: Transporte", dialog);
    await user.type(field("Valor esperado"), "300,00");
    await choose(user, "Frequência", "A cada N meses", dialog);
    await user.clear(field("A cada quantos meses"));
    await user.type(field("A cada quantos meses"), "1");
    await user.click(within(dialog).getByRole("button", { name: "Criar recorrência" }));
    expect(within(dialog).getByText("O intervalo vai de 2 a 60 meses.")).toBeTruthy();
    await user.clear(field("A cada quantos meses"));
    await user.type(field("A cada quantos meses"), "4");
    await user.click(within(dialog).getByRole("button", { name: "Criar recorrência" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Nova recorrência" })).toBeNull());
    const made = rules(ledger).find((r) => r.description === "IPVA")!;
    expect([made.frequency, made.interval_months]).toEqual(["every_n_months", 4]);
    const table = screen.getByRole("grid", { name: "Regras de recorrência" });
    expect(flat(rowById(table, made.id).textContent)).toContain("A cada 4 meses");

    await user.click(screen.getByRole("button", { name: "Nova recorrência…" }));
    const second = await screen.findByRole("dialog", { name: "Nova recorrência" });
    const field2 = (label: string) => within(second).getByLabelText(label) as HTMLInputElement;
    await user.type(field2("Descrição"), "Salário");
    await choose(user, "Conta", "Banco A", second);
    await choose(user, "Categoria", "Receita: Salário", second);
    await user.type(field2("Valor esperado"), "5.000,00");
    await choose(user, "Frequência", "Último dia útil do mês", second);
    expect(field2("Dia do vencimento").disabled).toBe(true);
    expect(within(second).getByText(/Feriados não são considerados/)).toBeTruthy();
    expect(within(second).queryByLabelText("A cada quantos meses")).toBeNull();
    await user.click(within(second).getByRole("button", { name: "Criar recorrência" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Nova recorrência" })).toBeNull());
    const salary = rules(ledger).find((r) => r.description === "Salário")!;
    expect([salary.frequency, salary.interval_months]).toEqual(["last_business_day", null]);
    // October 2026 ends on a Saturday: the forecast is on Friday the 30th
    const forecasts = screen.getByRole("grid", { name: "Previsões" });
    expect(rowById(forecasts, `${salary.id}:2026-10-30`)).toBeTruthy();
  });

  it("deletes the selected rule after a confirmation; the linked entry stays and one undo brings all back", async () => {
    const { ledger, workspace, user } = await open();
    const rule = seedRule(workspace, {
      description: "Escola",
      amount: "800.00",
      category: "Educação",
      day: 3,
      start: "2026-09-01" as never,
    });
    const op = seedExpense(workspace, "Escola", "800.00", "Educação", "2026-09-03" as never);
    workspace.act((l) => dom.recurrence.realize(l, rule.id, "2026-09-03" as never, op.id));
    const links = linkCount(ledger);

    await clickInTable(user, "Regras de recorrência", "Escola");
    await user.click(screen.getByRole("button", { name: "Excluir…" }));
    const ask = await screen.findByRole("alertdialog", { name: "Excluir “Escola”?" });
    expect(flat(ask.textContent)).toContain("1 lançamento vinculado continua no Livro");
    await user.click(within(ask).getByRole("button", { name: "Excluir" }));
    await waitFor(() => expect(rules(ledger).some((r) => r.id === rule.id)).toBe(false));
    expect(await screen.findByText("Recorrência “Escola” excluída.")).toBeTruthy();
    expect(linkCount(ledger)).toBe(links - 1);
    expect(ledger.operations.get(op.id)!.status).toBe("active");
    expect(workspace.undoStack.undoLabel()).toBe("excluir recorrência");
    undoOnce(workspace);
    expect(rules(ledger).some((r) => r.id === rule.id)).toBe(true);
    expect(linkCount(ledger)).toBe(links);
  });

  it("asks before deleting and keeps the rule when the answer is no", async () => {
    const { ledger, user } = await open();
    const before = rules(ledger).length;
    await clickInTable(user, "Regras de recorrência", "Aluguel");
    await user.click(screen.getByRole("button", { name: "Excluir…" }));
    const ask = await screen.findByRole("alertdialog", { name: "Excluir “Aluguel”?" });
    await user.click(within(ask).getByRole("button", { name: "Cancelar" }));
    expect(rules(ledger)).toHaveLength(before);
  });
});
