import { dom, formatBrl, makeDate, type IsoDate } from "@opesvault/domain";
import { act as reactAct, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  FORECAST_LABELS,
  candidateKey,
  dayLabel,
  forecastId,
  forecastWindow,
  parseRecurrenceRef,
  ruleRef,
  summaryLine,
} from "../../src/pages/recorrencias/rows.ts";
import { tableHeight } from "../../src/data/table_height.ts";
import {
  accountId,
  flat,
  linkCount,
  openPage,
  pickRow,
  rowOf,
  rules,
  seedExpense,
  seedRepeatingCharge,
  seedRule,
  undoOnce,
} from "./recorrencias_harness.tsx";

vi.mock("../../../../packages/ui/src/chart/echarts.ts", () => import("./fake_echarts.ts"));

const open = () => openPage("/recorrencias", "Recorrências");
const day = (d: number): IsoDate => makeDate(2026, 10, d);

describe("Recorrências rows", () => {
  it("reads the references other pages send and builds the ids of the rows", () => {
    expect(parseRecurrenceRef("r-1:2026-10-10")).toEqual({ kind: "forecast", ruleId: "r-1", dueOn: "2026-10-10" });
    expect(parseRecurrenceRef("rule:r-1")).toEqual({ kind: "rule", ruleId: "r-1" });
    expect(parseRecurrenceRef(ruleRef("abc"))).toEqual({ kind: "rule", ruleId: "abc" });
    for (const bad of [undefined, "", "r-1", "r-1:ontem", "r-1:2026-13-01", "a:b:c"]) {
      expect(parseRecurrenceRef(bad), String(bad)).toBeNull();
    }
    expect(forecastId("r-1", day(10))).toBe("r-1:2026-10-10");
  });

  it("shows three months back and six ahead, a weekly rule without a day of the month, the summary in words", () => {
    expect(forecastWindow(day(6))).toEqual(["2026-07-06", "2027-04-10"]);
    expect(FORECAST_LABELS).toEqual({
      pending: "Prevista",
      late: "Atrasada",
      realized: "Realizada",
      skipped: "Pulada",
    });
    const rule = { day: 12, frequency: "monthly" } as dom.recurrence.RecurrenceRule;
    expect(dayLabel(rule)).toBe("12");
    expect(dayLabel({ ...rule, frequency: "weekly" })).toBe("—");
    const rows = [{ paused: false }, { paused: true }, { paused: false }] as dom.recurrence.RecurrenceRule[];
    expect(summaryLine(rows, 3)).toBe("2 regra(s) ativa(s) · 3 previsão(ões) atrasada(s)");
    expect(summaryLine([], 0)).toBe("");
    expect(tableHeight(0, 8)).toBe("74px");
    expect(tableHeight(20, 8)).toBe("326px");
    expect(tableHeight(20, 8, true)).toBe("none");
    expect(candidateKey({ accountId: "a", categoryId: "c", description: "Netflix" } as never)).toBe("a|c|Netflix");
  });
});

describe("Recorrências", () => {
  it("lists the rules, the forecasts with their state in words and the yearly cost of the commitments", async () => {
    const { ledger, workspace } = await open();
    const rule = rules(ledger)[0]!;
    const forecasts = dom.recurrence.forecasts(ledger, ...forecastWindow(workspace.today()), workspace.today());
    expect(rule.description).toBe("Aluguel");
    const ruleTable = await screen.findByRole("grid", { name: "Regras de recorrência" });
    const ruleRow = flat(rowOf(ruleTable, rule.id)!.textContent);
    expect(ruleRow).toContain("Aluguel");
    expect(ruleRow).toContain(flat(formatBrl(rule.amount)));
    expect(ruleRow).toContain("Mensal");
    expect(ruleRow).toContain("Ativa");

    const table = screen.getByRole("grid", { name: "Previsões" });
    expect(forecasts.map((f) => f.status)).toEqual(["late", "late", "late", ...Array<"pending">(7).fill("pending")]);
    for (const forecast of forecasts) {
      const row = rowOf(table, forecastId(forecast.ruleId, forecast.dueOn));
      expect(row, forecast.dueOn).toBeTruthy();
      const text = flat(row!.textContent);
      expect(text).toContain(forecast.dueOn.split("-").reverse().join("/"));
      expect(text).toContain(flat(formatBrl(forecast.amount)));
      expect(text).toContain(FORECAST_LABELS[forecast.status]);
    }
    expect(screen.getByText("1 regra(s) ativa(s) · 3 previsão(ões) atrasada(s)")).toBeTruthy();

    // the rent is an expense: it is a commitment, with its yearly cost and no linked charge yet
    const commitments = screen.getByRole("grid", { name: "Assinaturas e contas fixas" });
    expect(flat(commitments.textContent)).toContain(flat(formatBrl(rule.amount.mul(12))));
    expect(flat(commitments.textContent)).toContain("Sem cobrança vinculada");
    expect(screen.getByText(/1 compromisso\(s\) · .*28\.200,00 por ano/)).toBeTruthy();
    // nothing looks recurring in the demonstration
    expect(screen.queryByRole("grid", { name: "Cobranças que parecem recorrentes" })).toBeNull();
  });

  it("creates a rule in the dialog (Nova recorrência…), refuses what is wrong inside it, and one undo reverts it", async () => {
    const { ledger, workspace, user } = await open();
    const before = rules(ledger).length;
    await user.click(screen.getByRole("button", { name: "Nova recorrência…" }));
    const dialog = await screen.findByRole("dialog", { name: "Nova recorrência" });
    const field = (label: string) => within(dialog).getByLabelText(label) as HTMLInputElement;
    const create = () => within(dialog).getByRole("button", { name: "Criar recorrência" });

    await user.click(create());
    expect(within(dialog).getByText("Informe a descrição.")).toBeTruthy();
    await user.type(field("Descrição"), "Academia");
    await user.click(create());
    expect(within(dialog).getByText("Escolha a conta.")).toBeTruthy();
    await user.click(within(dialog).getByRole("combobox", { name: "Conta" }));
    await user.click(await screen.findByRole("option", { name: "Banco A" }));
    await user.click(create());
    expect(within(dialog).getByText("Escolha a categoria.")).toBeTruthy();
    await user.click(within(dialog).getByRole("combobox", { name: "Categoria" }));
    await user.click(await screen.findByRole("option", { name: "Despesa: Lazer" }));
    await user.click(create());
    expect(within(dialog).getByText("Informe o valor.")).toBeTruthy();
    await user.type(field("Valor esperado"), "99,90");
    await user.clear(field("Dia do vencimento"));
    await user.type(field("Dia do vencimento"), "40");
    await user.click(create());
    expect(within(dialog).getByText("O dia do vencimento vai de 1 a 31.")).toBeTruthy();
    expect(rules(ledger)).toHaveLength(before);

    await user.clear(field("Dia do vencimento"));
    await user.type(field("Dia do vencimento"), "15");
    await user.type(field("Variação aceita"), "5");
    await user.click(create());
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Nova recorrência" })).toBeNull());
    const made = rules(ledger).find((r) => r.description === "Academia")!;
    expect(made.amount.toFixed()).toBe("99.90");
    expect(made.tolerance.eq("5")).toBe(true);
    expect(made.day).toBe(15);
    expect(made.start).toBe("2026-10-01");
    expect(made.account_id).toBe(accountId(ledger, "Banco A"));
    expect(await screen.findByText("Recorrência criada.")).toBeTruthy();
    const forecasts = screen.getByRole("grid", { name: "Previsões" });
    expect(rowOf(forecasts, forecastId(made.id, day(15)))).toBeTruthy();
    expect(screen.getByText("2 regra(s) ativa(s) · 3 previsão(ões) atrasada(s)")).toBeTruthy();
    undoOnce(workspace);
    expect(rules(ledger)).toHaveLength(before);
  });

  it("refuses an end date before the start inside the dialog", async () => {
    const { ledger, user } = await open();
    await user.click(screen.getByRole("button", { name: "Nova recorrência…" }));
    const dialog = await screen.findByRole("dialog", { name: "Nova recorrência" });
    await user.type(within(dialog).getByLabelText("Descrição"), "Curso");
    await user.click(within(dialog).getByRole("combobox", { name: "Conta" }));
    await user.click(await screen.findByRole("option", { name: "Banco A" }));
    await user.click(within(dialog).getByRole("combobox", { name: "Categoria" }));
    await user.click(await screen.findByRole("option", { name: "Despesa: Lazer" }));
    await user.type(within(dialog).getByLabelText("Valor esperado"), "10");
    await user.click(within(dialog).getByRole("checkbox", { name: /Fim/ }));
    const end = within(dialog).getByLabelText("Fim") as HTMLInputElement;
    await user.clear(end);
    await user.type(end, "01/01/2026");
    await user.click(within(dialog).getByRole("button", { name: "Criar recorrência" }));
    expect(await within(dialog).findByText("Fim antes do início.")).toBeTruthy();
    expect(rules(ledger).some((r) => r.description === "Curso")).toBe(false);
  });

  it("edits the selected rule (double click or Editar…) and one undo restores it", async () => {
    const { ledger, workspace, user } = await open();
    const rule = rules(ledger)[0]!;
    await user.click(screen.getByRole("button", { name: "Editar…" }));
    expect(await screen.findByText("Selecione uma regra.")).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();

    await pickRow(user, "Regras de recorrência", "Aluguel");
    await user.click(screen.getByRole("button", { name: "Editar…" }));
    const dialog = await screen.findByRole("dialog", { name: "Editar recorrência" });
    const amount = within(dialog).getByLabelText("Valor esperado") as HTMLInputElement;
    expect(amount.value).toBe("2.350,00");
    expect((within(dialog).getByLabelText("Descrição") as HTMLInputElement).value).toBe("Aluguel");
    await user.clear(amount);
    await user.type(amount, "2.400,00");
    await user.click(within(dialog).getByRole("button", { name: "Salvar" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Editar recorrência" })).toBeNull());
    expect(rules(ledger)[0]!.amount.toFixed()).toBe("2400.00");
    expect(rules(ledger)[0]!.id).toBe(rule.id);
    expect(await screen.findByText("Recorrência atualizada.")).toBeTruthy();
    undoOnce(workspace);
    expect(rules(ledger)[0]!.amount.toFixed()).toBe("2350.00");
  });

  it("pauses and resumes the selected rule: paused rules leave the forecasts; one undo reverts each", async () => {
    const { ledger, workspace, user } = await open();
    const rule = rules(ledger)[0]!;
    await user.click(screen.getByRole("button", { name: "Pausar ou retomar" }));
    expect(await screen.findByText("Selecione uma regra.")).toBeTruthy();

    await pickRow(user, "Regras de recorrência", "Aluguel");
    await user.click(screen.getByRole("button", { name: "Pausar" }));
    expect(rules(ledger)[0]!.paused).toBe(true);
    expect(await screen.findByText("Recorrência “Aluguel” pausada.")).toBeTruthy();
    const table = screen.getByRole("grid", { name: "Regras de recorrência" });
    expect(flat(rowOf(table, rule.id)!.textContent)).toContain("Pausada");
    expect(screen.getByText(/Nenhuma previsão no período/)).toBeTruthy();
    expect(screen.queryByRole("grid", { name: "Assinaturas e contas fixas" })).toBeNull();
    expect(screen.getByText("0 regra(s) ativa(s)")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Retomar" }));
    expect(rules(ledger)[0]!.paused).toBe(false);
    expect(await screen.findByText("Recorrência “Aluguel” retomada.")).toBeTruthy();
    expect(screen.getByRole("grid", { name: "Previsões" })).toBeTruthy();
    undoOnce(workspace); // the resume
    expect(rules(ledger)[0]!.paused).toBe(true);
    undoOnce(workspace); // the pause
    expect(rules(ledger)[0]!.paused).toBe(false);
  });

  it("links a forecast to the operation that realized it, and one undo unlinks it", async () => {
    const { ledger, workspace, user } = await open();
    const rule = seedRule(workspace, {
      description: "Posto Shell",
      amount: "145.00",
      category: "Transporte",
      day: 6,
      start: makeDate(2026, 10, 1),
    });
    const forecasts = screen.getByRole("grid", { name: "Previsões" });
    const id = forecastId(rule.id, day(6));
    await waitFor(() => expect(rowOf(forecasts, id)).toBeTruthy());

    await user.click(screen.getByRole("button", { name: "Vincular realizado…" }));
    expect(await screen.findByText("Selecione uma previsão.")).toBeTruthy();

    await user.click(within(rowOf(forecasts, id)!).getByText("Posto Shell"));
    await user.click(screen.getByRole("button", { name: "Vincular realizado…" }));
    const dialog = await screen.findByRole("dialog", { name: "Vincular realizado" });
    const options = within(dialog).getAllByRole("radio");
    expect(options).toHaveLength(1);
    expect(within(dialog).getByText("06/10/2026 Posto Shell")).toBeTruthy();
    expect(within(dialog).getByText("R$ 145,00")).toBeTruthy();
    await user.click(within(dialog).getByRole("button", { name: "Vincular" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Vincular realizado" })).toBeNull());

    const link = [...dom.recurrence.links(ledger).values()][0]!;
    expect(link).toMatchObject({ rule_id: rule.id, due_on: day(6), decision: "realized" });
    expect(ledger.operations.get(link.operation_id!)!.description).toBe("Posto Shell");
    expect(ledger.operations.get(link.operation_id!)!.forecast_id).toBe(rule.id);
    expect(await screen.findByText("Previsão vinculada ao lançamento.")).toBeTruthy();
    expect(flat(rowOf(forecasts, id)!.textContent)).toContain("Realizada");
    // a resolved forecast cannot be linked again
    await user.click(screen.getByRole("button", { name: "Vincular realizado…" }));
    expect(await screen.findByText("Esta previsão já foi resolvida.")).toBeTruthy();
    // the commitment now has a charge: the last one as paid
    expect(flat(screen.getByRole("grid", { name: "Assinaturas e contas fixas" }).textContent)).toContain(
      "Como previsto",
    );

    undoOnce(workspace);
    expect(linkCount(ledger)).toBe(0);
    expect(ledger.operations.get(link.operation_id!)!.forecast_id).toBeNull();
    await waitFor(() => expect(flat(rowOf(forecasts, id)!.textContent)).not.toContain("Realizada"));
  });

  it("says there is no compatible operation when the forecast has no candidate", async () => {
    const { ledger, user } = await open();
    const table = await pickRow(user, "Previsões", "Aluguel");
    expect(table).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Vincular realizado…" }));
    expect(await screen.findByText("Nenhum lançamento compatível (conta, valor e data).")).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(linkCount(ledger)).toBe(0);
  });

  it("skips a forecast, offers Desfazer, and does not skip one already resolved", async () => {
    const { ledger, workspace, user } = await open();
    const rule = rules(ledger)[0]!;
    await user.click(screen.getByRole("button", { name: "Mais" }));
    await user.click(await screen.findByRole("menuitem", { name: "Pular previsão" }));
    expect(await screen.findByText("Selecione uma previsão.")).toBeTruthy();

    const forecasts = await screen.findByRole("grid", { name: "Previsões" });
    await user.click(rowOf(forecasts, forecastId(rule.id, day(10)))!);
    await user.click(screen.getByRole("button", { name: "Mais" }));
    await user.click(await screen.findByRole("menuitem", { name: "Pular previsão" }));
    expect([...dom.recurrence.links(ledger).values()][0]).toMatchObject({
      rule_id: rule.id,
      due_on: day(10),
      decision: "skipped",
      operation_id: null,
    });
    expect(await screen.findByText("Previsão de 10/10/2026 pulada.")).toBeTruthy();
    expect(flat(rowOf(forecasts, forecastId(rule.id, day(10)))!.textContent)).toContain("Pulada");

    await user.click(screen.getByRole("button", { name: "Mais" }));
    await user.click(await screen.findByRole("menuitem", { name: "Pular previsão" }));
    expect(await screen.findByText("Esta previsão já foi resolvida.")).toBeTruthy();
    expect(linkCount(ledger)).toBe(1);

    await user.click(await screen.findByRole("button", { name: "Desfazer" }));
    expect(linkCount(ledger)).toBe(0);
    expect(workspace.undoStack.canUndo()).toBe(false);
  });

  it("links every forecast with a single candidate after a confirmation, as one undo step", async () => {
    const { ledger, workspace, user } = await open();
    seedRule(workspace, {
      description: "Posto Shell",
      amount: "145.00",
      category: "Transporte",
      day: 6,
      start: makeDate(2026, 10, 1),
    });
    seedRule(workspace, {
      description: "Mercado",
      amount: "560.00",
      category: "Alimentação",
      day: 6,
      start: makeDate(2026, 10, 1),
    });
    expect(dom.recurrence.autoSuggestions(ledger, ...forecastWindow(day(6)), day(6))).toHaveLength(2);

    await user.click(screen.getByRole("button", { name: "Mais" }));
    await user.click(await screen.findByRole("menuitem", { name: "Vincular sugestões únicas" }));
    const ask = await screen.findByRole("alertdialog", { name: "Vincular 2 previsão(ões) aos lançamentos?" });
    expect(flat(ask.textContent)).toContain("06/10/2026 Posto Shell ← Posto Shell");
    expect(flat(ask.textContent)).toContain("06/10/2026 Mercado ← Mercado do mês");
    await user.click(within(ask).getByRole("button", { name: "Cancelar" }));
    expect(linkCount(ledger)).toBe(0);

    await user.click(screen.getByRole("button", { name: "Mais" }));
    await user.click(await screen.findByRole("menuitem", { name: "Vincular sugestões únicas" }));
    await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Vincular" }));
    await waitFor(() => expect(linkCount(ledger)).toBe(2));
    expect(await screen.findByText("2 previsão(ões) vinculada(s).")).toBeTruthy();
    undoOnce(workspace);
    expect(linkCount(ledger)).toBe(0);
    for (const op of ledger.operations.values()) expect(op.forecast_id).toBeNull();
  });

  it("says when there is no forecast with a single candidate", async () => {
    const { ledger, user } = await open();
    await user.click(screen.getByRole("button", { name: "Mais" }));
    await user.click(await screen.findByRole("menuitem", { name: "Vincular sugestões únicas" }));
    expect(await screen.findByText("Nenhuma previsão com um único lançamento compatível.")).toBeTruthy();
    expect(linkCount(ledger)).toBe(0);
  });

  it("goes to the projection report from the menu", async () => {
    const { router, user } = await open();
    await user.click(screen.getByRole("button", { name: "Mais" }));
    await user.click(await screen.findByRole("menuitem", { name: "Projeção de compromissos (Relatórios)" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/relatorios"));
  });

  it("shows a changed price in words and the total per year", async () => {
    const { ledger, workspace, user } = await open();
    const rule = seedRule(workspace, {
      description: "Streaming",
      amount: "30.00",
      category: "Lazer",
      day: 6,
      start: makeDate(2026, 10, 1),
    });
    const op = seedExpense(workspace, "Streaming", "39.90", "Lazer", day(6));
    workspace.act((l) => dom.recurrence.realize(l, rule.id, day(6), op.id));
    const commitments = await screen.findByRole("grid", { name: "Assinaturas e contas fixas" });
    const row = flat(rowOf(commitments, rule.id)!.textContent);
    expect(row).toContain("Valor mudou");
    expect(row).toContain(flat(formatBrl(rule.amount.mul(12))));
    expect(row).toContain(
      `${formatBrl(dom.subscriptions.commitments(ledger).find((c) => c.rule.id === rule.id)!.lastPaid!)} em 06/10/2026`,
    );
    expect(screen.getByText(/2 compromisso\(s\) · .*28\.560,00 por ano/)).toBeTruthy();
    // selecting a commitment selects the same rule in the rules table
    await user.click(within(commitments).getByText("Streaming"));
    const rulesTable = screen.getByRole("grid", { name: "Regras de recorrência" });
    expect(rowOf(rulesTable, rule.id)!.getAttribute("aria-selected")).toBe("true");
  });

  it("offers the charges that repeat and creates the rule from one, prefilled; one undo removes it", async () => {
    const { ledger, workspace, user } = await open();
    seedRepeatingCharge(workspace);
    const candidates = await screen.findByRole("grid", { name: "Cobranças que parecem recorrentes" });
    const found = dom.subscriptions.candidates(ledger, day(6));
    expect(found).toHaveLength(1);
    const text = flat(candidates.textContent);
    expect(text).toContain("Netflix");
    expect(text).toContain("R$ 39,90");
    expect(text).toContain("3");
    expect(rowOf(candidates, candidateKey(found[0]!))).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Criar recorrência…" }));
    expect(await screen.findByText("Selecione uma cobrança.")).toBeTruthy();

    await user.click(within(candidates).getByText("Netflix"));
    await user.click(screen.getByRole("button", { name: "Criar recorrência…" }));
    const dialog = await screen.findByRole("dialog", { name: "Nova recorrência" });
    expect((within(dialog).getByLabelText("Descrição") as HTMLInputElement).value).toBe("Netflix");
    expect((within(dialog).getByLabelText("Valor esperado") as HTMLInputElement).value).toBe("39,90");
    expect((within(dialog).getByLabelText("Dia do vencimento") as HTMLInputElement).value).toBe("12");
    expect(within(dialog).getByRole("combobox", { name: "Conta" }).textContent).toContain("Banco A");
    expect(within(dialog).getByRole("combobox", { name: "Categoria" }).textContent).toContain("Despesa: Lazer");
    await user.click(within(dialog).getByRole("button", { name: "Criar recorrência" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Nova recorrência" })).toBeNull());
    const made = rules(ledger).find((r) => r.description === "Netflix")!;
    expect(made.amount.toFixed()).toBe("39.90");
    expect(made.day).toBe(12);
    expect(await screen.findByText("Recorrência criada a partir das cobranças repetidas.")).toBeTruthy();
    // it is registered now: it is no longer a candidate
    await waitFor(() => expect(screen.queryByRole("grid", { name: "Cobranças que parecem recorrentes" })).toBeNull());
    undoOnce(workspace);
    expect(rules(ledger).some((r) => r.description === "Netflix")).toBe(false);
    expect(await screen.findByRole("grid", { name: "Cobranças que parecem recorrentes" })).toBeTruthy();
  });

  it("collapses and reopens the subscriptions section", async () => {
    const { user } = await open();
    const toggle = screen.getByRole("button", { name: "Assinaturas e contas fixas" });
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    await user.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    await waitFor(() => expect(screen.queryByRole("grid", { name: "Assinaturas e contas fixas" })).toBeNull());
    await user.click(toggle);
    expect(await screen.findByRole("grid", { name: "Assinaturas e contas fixas" })).toBeTruthy();
  });

  it("explains the empty project and its New button refuses to save without accounts", async () => {
    const { workspace, user } = await openPage("/recorrencias", "Recorrências", { empty: true });
    expect(await screen.findByRole("heading", { name: "Nenhuma recorrência" })).toBeTruthy();
    expect(screen.queryByRole("grid")).toBeNull();
    expect(flat(document.body.textContent)).toContain("Previsões nunca alteram saldos.");
    const buttons = screen.getAllByRole("button", { name: "Nova recorrência…" });
    expect(buttons).toHaveLength(2);
    await user.click(buttons[1]!);
    const dialog = await screen.findByRole("dialog", { name: "Nova recorrência" });
    await user.type(within(dialog).getByLabelText("Descrição"), "Aluguel");
    await user.click(within(dialog).getByRole("button", { name: "Criar recorrência" }));
    expect(await within(dialog).findByText("Escolha a conta.")).toBeTruthy();
    expect(workspace.ledger.entities("recurrence_rule").size).toBe(0);
    expect(workspace.undoStack.canUndo()).toBe(false);
  });

  it("is read only while another tab or device edits: nothing can be changed", async () => {
    const { workspace } = await openPage("/recorrencias", "Recorrências", { readOnly: true });
    expect(workspace.readOnly).toBe(true);
    const button = screen.getAllByRole("button", { name: "Nova recorrência…" })[0]!;
    expect(button.hasAttribute("disabled")).toBe(true);
    expect(button.getAttribute("title")).toMatch(/editando este projeto/);
  });

  it("changes nothing in the reads: a day later the same rule just has other states", async () => {
    // forecasts take `today` explicitly (never the clock): the same ledger on another day reads differently
    const { ledger, workspace } = await open();
    const rule = rules(ledger)[0]!;
    const asOf = (today: IsoDate) =>
      dom.recurrence.forecasts(ledger, ...forecastWindow(today), today).map((f) => [f.dueOn, f.status]);
    expect(asOf(day(6)).slice(0, 4)).toEqual([
      ["2026-07-10", "late"],
      ["2026-08-10", "late"],
      ["2026-09-10", "late"],
      ["2026-10-10", "pending"],
    ]);
    expect(asOf(makeDate(2026, 10, 20)).find((f) => f[0] === "2026-10-10")).toEqual(["2026-10-10", "late"]);
    expect(rule.id).toBeTruthy();
    expect(workspace.undoStack.canUndo()).toBe(false);
    reactAct(() => undefined);
  });
});
