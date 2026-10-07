import { charts, dom, formatBrl, makeDate, ymOf, type Id } from "@opesvault/domain";
import { act as reactAct, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { pinToday } from "../clock.ts";
import {
  NONE,
  dateOrNone,
  moneyOrNone,
  nameOf,
  reachedLabel,
  shareLabel,
  summaryLine,
} from "../../src/pages/metas/rows.ts";
import { openPage } from "./recorrencias_harness.tsx";
import { accountNamed } from "../lookup.ts";
import { flat, rowById, undoOnce } from "../dom.ts";
import { addressSettles } from "../navigations.ts";

const open = (options = {}) => openPage("/metas", "Metas", options);
const goals = (ledger: Parameters<typeof dom.goals.goals>[0]) => dom.goals.goals(ledger);

describe("Metas rows", () => {
  it("writes what is known in words and keeps the unknown as a dash, never as zero", () => {
    expect(moneyOrNone(null)).toBe(NONE);
    expect(dateOrNone(null)).toBe(NONE);
    expect(reachedLabel(null)).toBe(NONE);
    expect(reachedLabel({ year: 2027, month: 3 })).toBe("Março de 2027");
    expect(dateOrNone(makeDate(2027, 12, 31))).toBe("31/12/2027");
    expect(nameOf({ name: "Viagem", archived: true } as never)).toBe("Viagem (arquivada)");
    expect(nameOf({ name: "Viagem", archived: false } as never)).toBe("Viagem");
    expect(summaryLine([])).toBe("");
    expect(summaryLine([{ archived: false }, { archived: true }] as never)).toBe("1 meta(s) ativa(s)");
  });
});

describe("Metas", () => {
  pinToday(2026, 10, 6);
  it("shows each goal's progress, what is missing, the monthly need and the recent pace", async () => {
    const { ledger, workspace } = await open();
    const [goal] = goals(ledger);
    const p = dom.goals.progress(ledger, goal!, workspace.today());
    expect(goal!.name).toBe("Reserva de emergência");
    const table = await screen.findByRole("grid", { name: "Metas" });
    const text = flat(rowById(table, goal!.id).textContent);
    expect(text).toContain("Reserva de emergência");
    expect(text).toContain(flat(formatBrl(p.current)));
    expect(text).toContain(flat(formatBrl(goal!.target)));
    expect(text).toContain("54%");
    expect(text).toContain(flat(formatBrl(p.missing)));
    expect(text).toContain("31/12/2027");
    expect(text).toContain(flat(formatBrl(p.neededPerMonth!)));
    expect(text).toContain(flat(formatBrl(p.pace!)));
    // the demonstration's balance is shrinking: it never reaches the target at this pace
    expect(p.reachedOnPace).toBeNull();
    expect(text).toContain(NONE);
    expect(shareLabel(p)).toBe("54%");
    expect(screen.getByText("1 meta(s) ativa(s)")).toBeTruthy();
    // the selected goal's details and its chart with the same values in a table
    expect(screen.getByText(/Selecionada:/)).toBeTruthy();
    expect(screen.getByText("Falta por mês")).toBeTruthy();
    expect(screen.getAllByText("Ritmo recente").length).toBeGreaterThan(1);
    const chart = charts.data.goalChart(ledger, goal!.id, ymOf(workspace.today()), workspace.today());
    const values = await screen.findByRole("table", { name: `Valores de ${chart.title}` });
    expect(chart.title).toBe("Meta: Reserva de emergência");
    expect(within(values).getAllByRole("row").length).toBeGreaterThan(12);
    expect(flat(values.textContent)).toContain(flat(formatBrl(goal!.target)));
  });

  it("creates a net-worth goal without a deadline in the dialog, refusing what is wrong, and one undo reverts it", async () => {
    const { ledger, workspace, user } = await open();
    const before = goals(ledger).length;
    await user.click(screen.getByRole("button", { name: "Nova meta…" }));
    const dialog = await screen.findByRole("dialog", { name: "Nova meta" });
    const create = () => within(dialog).getByRole("button", { name: "Criar meta" });
    await user.click(create());
    expect(within(dialog).getByText("Dê um nome à meta.")).toBeTruthy();
    await user.type(within(dialog).getByLabelText("Nome"), "Patrimônio de 100 mil");
    await user.click(create());
    expect(within(dialog).getByText("Informe o valor da meta.")).toBeTruthy();
    await user.type(within(dialog).getByLabelText("Valor da meta"), "100.000,00");
    expect(goals(ledger)).toHaveLength(before);
    await user.click(create());
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Nova meta" })).toBeNull());
    const made = goals(ledger).find((g) => g.name === "Patrimônio de 100 mil")!;
    expect(made).toMatchObject({ kind: "net_worth", target_date: null, created_on: "2026-10-06" });
    expect(made.target.toFixed()).toBe("100000.00");
    expect(made.account_ids).toEqual([]);
    expect(await screen.findByText("Meta criada.")).toBeTruthy();
    // no deadline: the monthly need is unknown, not zero
    const table = screen.getByRole("grid", { name: "Metas" });
    expect(flat(rowById(table, made.id).textContent)).toContain(NONE);
    expect(screen.getByText("2 meta(s) ativa(s)")).toBeTruthy();
    // the new goal is the selected one, with its own chart
    expect(await screen.findByRole("table", { name: "Valores de Meta: Patrimônio de 100 mil" })).toBeTruthy();
    expect(screen.getByText("Sem prazo")).toBeTruthy();
    undoOnce(workspace);
    expect(goals(ledger)).toHaveLength(before);
  });

  it("creates a goal over chosen accounts with a deadline; the accounts are required and the date must be in the future", async () => {
    const { ledger, workspace, user } = await open();
    await user.click(screen.getByRole("button", { name: "Nova meta…" }));
    const dialog = await screen.findByRole("dialog", { name: "Nova meta" });
    const create = () => within(dialog).getByRole("button", { name: "Criar meta" });
    // the accounts are disabled until the goal counts chosen accounts
    expect(within(dialog).getByRole("checkbox", { name: "Poupança" }).hasAttribute("disabled")).toBe(true);
    await user.type(within(dialog).getByLabelText("Nome"), "Viagem");
    await user.type(within(dialog).getByLabelText("Valor da meta"), "8.000");
    await user.click(within(dialog).getByRole("combobox", { name: "Conta como" }));
    await user.click(await screen.findByRole("option", { name: "Saldo de contas escolhidas" }));
    await user.click(create());
    expect(within(dialog).getByText("Escolha as contas que formam a meta.")).toBeTruthy();
    await user.click(within(dialog).getByRole("checkbox", { name: "Poupança" }));
    // a deadline that is not in the future
    await user.click(within(dialog).getByRole("checkbox", { name: /Prazo/ }));
    const deadline = within(dialog).getByLabelText("Prazo") as HTMLInputElement;
    await user.clear(deadline);
    await user.type(deadline, "01/01/2026");
    await user.click(create());
    expect(await within(dialog).findByText("A data da meta precisa ser futura.")).toBeTruthy();
    await user.clear(deadline);
    await user.type(deadline, "31/12/2027");
    await user.click(create());
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Nova meta" })).toBeNull());
    const made = goals(ledger).find((g) => g.name === "Viagem")!;
    expect(made).toMatchObject({ kind: "accounts", target_date: "2027-12-31" });
    expect(made.account_ids).toEqual([accountNamed(ledger, "Poupança").id]);
    const table = screen.getByRole("grid", { name: "Metas" });
    expect(flat(rowById(table, made.id).textContent)).toContain("31/12/2027");
    undoOnce(workspace);
    expect(goals(ledger).some((g) => g.name === "Viagem")).toBe(false);
  });

  it("edits the selected goal (Editar meta…, double click or the menu) and one undo restores it", async () => {
    const { ledger, workspace, user } = await open();
    const goal = goals(ledger)[0]!;
    await user.click(screen.getByRole("button", { name: "Editar meta…" }));
    const dialog = await screen.findByRole("dialog", { name: "Editar meta" });
    expect((within(dialog).getByLabelText("Nome") as HTMLInputElement).value).toBe("Reserva de emergência");
    expect((within(dialog).getByLabelText("Valor da meta") as HTMLInputElement).value).toBe("30.000,00");
    expect((within(dialog).getByLabelText("Prazo") as HTMLInputElement).value).toBe("31/12/2027");
    // the chosen accounts are checked, the other ones not
    expect(within(dialog).getByRole("checkbox", { name: "Banco A" }).getAttribute("aria-checked")).toBe("true");
    expect(within(dialog).getByRole("checkbox", { name: "Poupança" }).getAttribute("aria-checked")).toBe("true");
    expect(within(dialog).getByRole("checkbox", { name: "Conjunta" }).getAttribute("aria-checked")).toBe("false");
    const target = within(dialog).getByLabelText("Valor da meta") as HTMLInputElement;
    await user.clear(target);
    await user.type(target, "36.000,00");
    await user.click(within(dialog).getByRole("checkbox", { name: "Conjunta" }));
    await user.click(within(dialog).getByRole("button", { name: "Salvar" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Editar meta" })).toBeNull());
    const edited = goals(ledger)[0]!;
    expect(edited.id).toBe(goal.id);
    expect(edited.target.toFixed()).toBe("36000.00");
    expect(edited.account_ids).toHaveLength(3);
    expect(edited.version).toBe(goal.version + 1);
    expect(await screen.findByText("Meta atualizada.")).toBeTruthy();
    undoOnce(workspace);
    expect(goals(ledger)[0]!.target.toFixed()).toBe("30000.00");
    expect(goals(ledger)[0]!.account_ids).toHaveLength(2);

    // the same command from the menu
    await user.click(screen.getByRole("button", { name: "Mais" }));
    await user.click(await screen.findByRole("menuitem", { name: "Editar meta…" }));
    expect(await screen.findByRole("dialog", { name: "Editar meta" })).toBeTruthy();
  });

  it("archives and reactivates with a reason that stays in the history; one undo reverts each", async () => {
    const { ledger, workspace, user } = await open();
    const goal = goals(ledger)[0]!;
    await user.click(screen.getByRole("button", { name: "Mais" }));
    await user.click(await screen.findByRole("menuitem", { name: "Arquivar ou reativar…" }));
    const dialog = await screen.findByRole("dialog", { name: "Arquivar meta" });
    await user.click(within(dialog).getByRole("button", { name: "Arquivar" }));
    expect(within(dialog).getByText("O motivo é obrigatório.")).toBeTruthy();
    expect(goals(ledger)[0]!.archived).toBe(false);
    await user.type(within(dialog).getByLabelText(/Motivo/), "Meta cumprida de outro jeito");
    await user.click(within(dialog).getByRole("button", { name: "Arquivar" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Arquivar meta" })).toBeNull());
    expect(goals(ledger)[0]!.archived).toBe(true);
    expect(await screen.findByText("Meta arquivada.")).toBeTruthy();
    expect(screen.getByText("0 meta(s) ativa(s)")).toBeTruthy();
    const table = screen.getByRole("grid", { name: "Metas" });
    expect(flat(rowById(table, goal.id).textContent)).toContain("arquivada");

    await user.click(screen.getByRole("button", { name: "Reativar…" }));
    const again = await screen.findByRole("dialog", { name: "Reativar meta" });
    await user.type(within(again).getByLabelText(/Motivo/), "Voltou a valer");
    await user.click(within(again).getByRole("button", { name: "Reativar" }));
    await waitFor(() => expect(goals(ledger)[0]!.archived).toBe(false));
    expect(await screen.findByText("Meta reativada.")).toBeTruthy();
    undoOnce(workspace);
    expect(goals(ledger)[0]!.archived).toBe(true);
    undoOnce(workspace);
    expect(goals(ledger)[0]!.archived).toBe(false);
  });

  it("follows the selection: another goal shows its own details and chart, archived goals last", async () => {
    const { ledger, workspace, user } = await open();
    const second = workspace.act((l) =>
      dom.goals.addGoal(
        l,
        dom.goals.GoalSchema.parse({
          name: "Entrada do apartamento",
          kind: "net_worth",
          target: "50000.00",
          target_date: makeDate(2028, 6, 30),
          created_on: makeDate(2026, 10, 6),
        }),
      ),
    );
    const archived = workspace.act((l) =>
      dom.goals.addGoal(
        l,
        dom.goals.GoalSchema.parse({
          name: "Antiga",
          kind: "net_worth",
          target: "1000.00",
          created_on: makeDate(2026, 1, 1),
          archived: true,
        }),
      ),
    );
    const table = await screen.findByRole("grid", { name: "Metas" });
    const order = [...table.querySelectorAll("[data-row-id]")].map((row) => row.getAttribute("data-row-id"));
    expect(order).toEqual([...goals(ledger).map((g) => g.id)]);
    expect(order.at(-1)).toBe(archived.id);
    // the first one is selected until the person chooses
    expect(screen.getByRole("table", { name: "Valores de Meta: Entrada do apartamento" })).toBeTruthy();
    await user.click(within(table).getByText("Reserva de emergência"));
    expect(await screen.findByRole("table", { name: "Valores de Meta: Reserva de emergência" })).toBeTruthy();
    expect(screen.getByText("Selecionada:").parentElement!.textContent).toContain("Reserva de emergência");
    expect(
      rowById(table, goals(ledger).find((g) => g.name === "Reserva de emergência")!.id).getAttribute("aria-selected"),
    ).toBe("true");
    expect(rowById(table, second.id).getAttribute("aria-selected")).toBe("false");
    // the archived goal still has progress
    await user.click(within(table).getByText("Antiga"));
    expect(await screen.findByRole("button", { name: "Reativar…" })).toBeTruthy();
  });

  it("opens the goal a link names ('<goalId>'), and 'editar' also opens its form", async () => {
    const { ledger, router, workspace } = await open();
    const second = workspace.act((l) =>
      dom.goals.addGoal(
        l,
        dom.goals.GoalSchema.parse({
          name: "Zeladoria",
          kind: "net_worth",
          target: "20000.00",
          created_on: makeDate(2026, 10, 6),
        }),
      ),
    );
    const table = await screen.findByRole("grid", { name: "Metas" });
    expect(rowById(table, second.id).getAttribute("aria-selected")).toBe("false");
    await reactAct(async () => {
      await router.navigate({ to: "/metas", search: { ref: second.id } });
    });
    await waitFor(() => expect(rowById(table, second.id).getAttribute("aria-selected")).toBe("true"));
    expect(await screen.findByRole("table", { name: "Valores de Meta: Zeladoria" })).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
    await addressSettles(router, {});
    const first = goals(ledger)[0]!;
    await reactAct(async () => {
      await router.navigate({ to: "/metas", search: { ref: first.id, act: "editar" } });
    });
    const dialog = await screen.findByRole("dialog", { name: "Editar meta" });
    expect((within(dialog).getByLabelText("Nome") as HTMLInputElement).value).toBe(first.name);
    // an id that is not a goal does nothing
    await reactAct(async () => {
      await router.navigate({ to: "/metas", search: { ref: "x" as Id } });
    });
    expect(rowById(table, first.id).getAttribute("aria-selected")).toBe("true");
  });

  it("explains the empty project, and nothing is saved without a name", async () => {
    const { workspace, user } = await open({ project: "blank" });
    expect(await screen.findByRole("heading", { name: "Nenhuma meta" })).toBeTruthy();
    expect(screen.queryByRole("grid")).toBeNull();
    expect(screen.getAllByRole("button", { name: "Nova meta…" })).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: "Começar do zero…" }));
    const dialog = await screen.findByRole("dialog", { name: "Nova meta" });
    expect(within(dialog).getByText("Nenhuma conta de ativo cadastrada.")).toBeTruthy();
    await user.click(within(dialog).getByRole("button", { name: "Criar meta" }));
    expect(await within(dialog).findByText("Dê um nome à meta.")).toBeTruthy();
    expect(workspace.ledger.entities("goal").size).toBe(0);
    expect(workspace.undoStack.canUndo()).toBe(false);
    // the menu asks to select a goal when there is none
    await user.click(within(dialog).getByRole("button", { name: "Cancelar" }));
    await user.click(screen.getByRole("button", { name: "Mais" }));
    await user.click(await screen.findByRole("menuitem", { name: "Editar meta…" }));
    expect(await screen.findByText("Selecione uma meta.")).toBeTruthy();
  });

  it("is read only while another tab or device edits: nothing can be changed", async () => {
    const { workspace } = await open({ project: "blank", readOnly: true });
    expect(workspace.readOnly).toBe(true);
    const button = screen.getAllByRole("button", { name: "Nova meta…" })[0]!;
    expect(button.hasAttribute("disabled")).toBe(true);
    expect(button.getAttribute("title")).toMatch(/editando este projeto/);
  });
});
