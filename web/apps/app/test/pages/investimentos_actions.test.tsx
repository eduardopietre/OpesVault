/** Investimentos: every command of the page; each one is one undo step that brings the project back as it was. */
import { Dec, formatBrl, investments, makeDate, queries, type Id, type Ledger } from "@opesvault/domain";
import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  cashOf,
  cdbOf,
  choose,
  closed,
  dialog,
  fill,
  flat,
  menu,
  openInvestimentos,
  rowOf,
  snapshot,
  submit,
  table,
  undoOnce,
} from "./investimentos_harness.tsx";

vi.mock("../../../../packages/ui/src/chart/echarts.ts", async () => await import("./fake_echarts.ts"));

const { service, trades, performance, model } = investments;

const SOURCE_DATE = "28/03/2026";

/** A position tracked by quantity with an opening lot, so the trades have something to work on. */
function quantityPosition(workspace: { act: <T>(f: (l: Ledger) => T) => T }, name = "PETR4"): Id {
  return workspace.act((l) => {
    const position = service.createPosition(l, name, model.AssetClass.STOCK, makeDate(2026, 1, 5), {
      mode: model.TrackingMode.QUANTITY,
      ticker: name,
    });
    trades.openingLot(l, position.id, makeDate(2026, 1, 5), "100", "3000");
    return position.id;
  });
}

describe("Novo investimento", () => {
  it("refuses a missing name and a missing cost, inside the dialog, and changes nothing", async () => {
    const { user, ledger } = await openInvestimentos();
    const before = snapshot(ledger);
    await user.click(screen.getAllByRole("button", { name: "Novo investimento…" })[0]!);
    const box = await dialog("Novo investimento");
    await submit(user, box, "Criar");
    expect(within(box).getByText("Informe o nome.")).toBeTruthy();
    await fill(user, box, "Nome", "Tesouro IPCA+ 2035");
    await submit(user, box, "Criar");
    expect(within(box).getByText("Informe o custo inicial ou um valor de referência.")).toBeTruthy();
    expect(snapshot(ledger)).toBe(before);
  });

  it("creates an investment by value with its capital taken from an account; one undo reverts all", async () => {
    const { user, ledger, workspace } = await openInvestimentos();
    const before = snapshot(ledger);
    const cash = cashOf(ledger);
    const cashBefore = queries.balance(ledger, cash);
    await user.click(screen.getAllByRole("button", { name: "Novo investimento…" })[0]!);
    const box = await dialog("Novo investimento");
    await fill(user, box, "Nome", "Tesouro IPCA+ 2035");
    await choose(user, box, "Classe", "Tesouro Direto");
    await fill(user, box, "Data inicial", "02/03/2026");
    await fill(user, box, "Capital/custo inicial", "1.000,00");
    await choose(user, box, "Dinheiro saiu de", /Banco A/);
    await submit(user, box, "Criar");
    await closed("Novo investimento");
    const created = [...service.positions(ledger).values()].find(
      (p) => service.assets(ledger).get(p.asset_id)!.name === "Tesouro IPCA+ 2035",
    )!;
    expect(created.mode).toBe("value");
    expect(formatBrl(service.remainingCost(ledger, created.id))).toBe("R$ 1.000,00");
    expect(queries.balance(ledger, cash).eq(cashBefore.sub(Dec.from(1000)))).toBe(true);
    expect(service.assets(ledger).get(created.asset_id)!.asset_class).toBe("treasury");
    // the new one is selected and its detail shown
    expect(await screen.findByRole("heading", { level: 2, name: "Tesouro IPCA+ 2035" })).toBeTruthy();
    expect(await screen.findByText(/Investimento criado/)).toBeTruthy();
    undoOnce(workspace);
    expect(snapshot(ledger)).toBe(before);
  });

  it("with only a reference value the cost stays unknown and the gain is unavailable with its reason", async () => {
    const { user, ledger, workspace } = await openInvestimentos();
    await user.click(screen.getAllByRole("button", { name: "Novo investimento…" })[0]!);
    const box = await dialog("Novo investimento");
    await fill(user, box, "Nome", "Fundo herdado");
    await fill(user, box, "Data inicial", "01/03/2026");
    await fill(user, box, "Valor de referência", "7.500,00");
    await submit(user, box, "Criar");
    await closed("Novo investimento");
    const created = [...service.positions(ledger).values()].find((p) => !p.cost_known)!;
    const grid = await table("Investimentos");
    const row = flat(rowOf(grid, "Fundo herdado").textContent);
    expect(row).toContain("desconhecido");
    expect(row).toContain("indisponível");
    expect(row).toContain(formatBrl(Dec.from(7500)));
    // the figure's reason, as the domain gives it
    const gain = performance.unrealized(ledger, created.id, workspace.today());
    expect(gain.value).toBeNull();
    expect(await screen.findByText(gain.notes[0]!)).toBeTruthy();
  });

  it("an asset tracked by quantity starts empty and does not ask for a cost", async () => {
    const { user, ledger } = await openInvestimentos();
    await user.click(screen.getAllByRole("button", { name: "Novo investimento…" })[0]!);
    const box = await dialog("Novo investimento");
    await fill(user, box, "Nome", "VALE3");
    await choose(user, box, "Classe", "Ações");
    await choose(user, box, "Acompanhamento", "Por quantidade e preço");
    await fill(user, box, "Código (opcional)", "VALE3");
    expect(within(box).queryByLabelText(/Capital\/custo inicial/)).toBeNull();
    await submit(user, box, "Criar");
    await closed("Novo investimento");
    const created = [...service.positions(ledger).values()].find((p) => p.mode === "quantity")!;
    expect(service.assets(ledger).get(created.asset_id)!.ticker).toBe("VALE3");
    expect(service.remainingCost(ledger, created.id).isZero()).toBe(true);
  });
});

describe("Avaliações", () => {
  it("registers a valuation, one undo step; the same source on the same date is refused with the way out", async () => {
    const { user, ledger, workspace } = await openInvestimentos();
    const id = cdbOf(ledger);
    const before = snapshot(ledger);
    await menu(user, "Registrar", "Avaliação…");
    let box = await dialog(/Nova avaliação — CDB Banco X 2028/);
    await fill(user, box, "Data", "15/04/2026");
    await fill(user, box, "Valor", "5.200,00");
    await submit(user, box, "Registrar");
    await closed(/Nova avaliação/);
    const created = service.valuationsOf(ledger, id).find((v) => v.on === "2026-04-15")!;
    expect(formatBrl(created.value)).toBe("R$ 5.200,00");
    expect(created.selected).toBe(true);
    expect(created.nature).toBe("gross");
    expect(await screen.findByText("Avaliação registrada.")).toBeTruthy();
    undoOnce(workspace);
    expect(snapshot(ledger)).toBe(before);

    // the same source on a date that already has one
    await menu(user, "Registrar", "Avaliação…");
    box = await dialog(/Nova avaliação/);
    await fill(user, box, "Data", SOURCE_DATE);
    await fill(user, box, "Valor", "9.999,00");
    expect(within(box).getByText(/Já existe avaliação desta fonte em 28\/03\/2026/)).toBeTruthy();
    await submit(user, box, "Registrar");
    expect(within(box).getByText(/Já existe avaliação desta fonte nesta data: use 'corrigir observação'/)).toBeTruthy();
    expect(snapshot(ledger)).toBe(before);
  });

  it("another source on the same date is kept apart and the first stays the one used until the person picks", async () => {
    const { user, ledger, workspace } = await openInvestimentos();
    const id = cdbOf(ledger);
    const before = snapshot(ledger);
    await menu(user, "Registrar", "Avaliação…");
    const box = await dialog(/Nova avaliação/);
    await fill(user, box, "Data", SOURCE_DATE);
    await fill(user, box, "Valor", "5.140,00");
    await fill(user, box, "Fonte", "extrato do banco");
    expect(within(box).getByText(/Esta será registrada como outra fonte/)).toBeTruthy();
    await submit(user, box, "Registrar");
    await closed(/Nova avaliação/);
    const day = service.valuationsOf(ledger, id).filter((v) => v.on === "2026-03-28");
    expect(day).toHaveLength(2);
    expect(day.filter((v) => v.selected)).toHaveLength(1);
    expect(day.find((v) => v.source === "manual")!.selected).toBe(true);

    // use the new one: the observation used changes, one undo step
    const grid = await table("Avaliações");
    await user.click(rowOf(grid, "extrato do banco"));
    await user.click(screen.getByRole("button", { name: "Usar esta observação" }));
    await waitFor(() =>
      expect(service.valuationsOf(ledger, id).find((v) => v.source === "extrato do banco")!.selected).toBe(true),
    );
    expect(service.valuationsOf(ledger, id).find((v) => v.source === "manual" && v.on === "2026-03-28")!.selected).toBe(
      false,
    );
    undoOnce(workspace);
    expect(service.valuationsOf(ledger, id).find((v) => v.source === "manual" && v.on === "2026-03-28")!.selected).toBe(
      true,
    );
    undoOnce(workspace);
    expect(snapshot(ledger)).toBe(before);
  });

  it("notes when the day also has movements: the valuation is the close of the day, after them", async () => {
    const { user, ledger, workspace } = await openInvestimentos();
    const id = cdbOf(ledger);
    workspace.act((l) => service.contribute(l, id, "50", makeDate(2026, 4, 2), cashOf(l)));
    await menu(user, "Registrar", "Avaliação…");
    const box = await dialog(/Nova avaliação/);
    await fill(user, box, "Data", "02/04/2026");
    expect(within(box).getByText(/Há movimentos neste dia \(1 evento\)/)).toBeTruthy();
    expect(within(box).getByText(/fechamento do dia, depois dos movimentos/)).toBeTruthy();
  });

  it("corrects an observation with its reason; the history keeps the old value; one undo reverts it", async () => {
    const { user, ledger, workspace } = await openInvestimentos();
    const id = cdbOf(ledger);
    const before = snapshot(ledger);
    const grid = await table("Avaliações");
    await user.click(rowOf(grid, "28/03/2026"));
    await user.click(screen.getByRole("button", { name: "Corrigir observação…" }));
    const box = await dialog("Corrigir observação");
    await fill(user, box, "Valor corrigido", "5.150,00");
    await submit(user, box, "Corrigir");
    expect(within(box).getByText("Correções exigem motivo.")).toBeTruthy();
    await fill(user, box, "Motivo", "extrato conferido");
    await submit(user, box, "Corrigir");
    await closed("Corrigir observação");
    const fixed = service.valuationsOf(ledger, id).find((v) => v.on === "2026-03-28")!;
    expect(formatBrl(fixed.value)).toBe("R$ 5.150,00");
    expect(ledger.historyOf(fixed.id).some((h) => h.reason === "extrato conferido")).toBe(true);
    undoOnce(workspace);
    expect(snapshot(ledger)).toBe(before);
  });

  it("asks to select an observation first", async () => {
    const { user } = await openInvestimentos();
    await user.click(await screen.findByRole("button", { name: "Corrigir observação…" }));
    expect(await screen.findByText("Selecione uma observação na tabela Avaliações.")).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("Aportes, proventos e resgates", () => {
  it("registers a contribution as capital moved in, never as income; one undo reverts it", async () => {
    const { user, ledger, workspace } = await openInvestimentos();
    const id = cdbOf(ledger);
    const before = snapshot(ledger);
    const costBefore = service.remainingCost(ledger, id);
    await menu(user, "Registrar", "Aporte…");
    const box = await dialog(/Aporte — CDB Banco X 2028/);
    await fill(user, box, "Valor", "250,00");
    await submit(user, box, "Registrar");
    await closed(/Aporte/);
    const event = service.eventsOf(ledger, id).find((e) => e.kind === "contribution" && e.gross?.eq(Dec.from(250)))!;
    expect(event.net?.eq(Dec.from(250))).toBe(true);
    expect(service.remainingCost(ledger, id).eq(costBefore.add(Dec.from(250)))).toBe(true);
    expect(await screen.findByText("Aporte registrado.")).toBeTruthy();
    // it shows in Movimentos
    expect(flat(rowOf(await table("Movimentos"), "R$ 250,00").textContent)).toContain("Aporte");
    undoOnce(workspace);
    expect(snapshot(ledger)).toBe(before);
  });

  it("refuses a contribution without a value, inside the dialog", async () => {
    const { user, ledger } = await openInvestimentos();
    const before = snapshot(ledger);
    await menu(user, "Registrar", "Aporte…");
    const box = await dialog(/Aporte/);
    await submit(user, box, "Registrar");
    expect(within(box).getByText("Informe o valor.")).toBeTruthy();
    expect(snapshot(ledger)).toBe(before);
  });

  it("registers a distribution outside the position: income, with the tax withheld; one undo reverts it", async () => {
    const { user, ledger, workspace } = await openInvestimentos();
    const id = cdbOf(ledger);
    const before = snapshot(ledger);
    const costBefore = service.remainingCost(ledger, id);
    await menu(user, "Registrar", "Provento…");
    const box = await dialog(/Provento pago fora do investimento/);
    await fill(user, box, "Valor bruto", "100,00");
    await fill(user, box, "Imposto retido", "15,00");
    await submit(user, box, "Registrar");
    await closed(/Provento/);
    const event = service.eventsOf(ledger, id).find((e) => e.kind === "distribution")!;
    expect(event.net?.eq(Dec.from(85))).toBe(true);
    expect(service.remainingCost(ledger, id).eq(costBefore)).toBe(true);
    undoOnce(workspace);
    expect(snapshot(ledger)).toBe(before);
  });

  it("redeems with the tax apart; the net is credited; a total redemption closes the position; one undo reverts it", async () => {
    const { user, ledger, workspace } = await openInvestimentos();
    const id = cdbOf(ledger);
    const before = snapshot(ledger);
    await menu(user, "Registrar", "Resgate…");
    const box = await dialog(/Resgate — CDB Banco X 2028/);
    await fill(user, box, "Valor bruto", "1.000,00");
    await fill(user, box, "Imposto retido no ato", "20,00");
    await fill(user, box, "Taxas descontadas", "5,00");
    await submit(user, box, "Registrar");
    await closed(/Resgate/);
    const event = service.eventsOf(ledger, id).find((e) => e.kind === "withdrawal")!;
    expect(event.net?.eq(Dec.from(975))).toBe(true);
    expect(event.cost_method).toContain("proporcional");
    expect(await screen.findByText("Resgate registrado.")).toBeTruthy();
    undoOnce(workspace);
    expect(snapshot(ledger)).toBe(before);

    await menu(user, "Registrar", "Resgate…");
    const total = await dialog(/Resgate — CDB Banco X 2028/);
    await fill(user, total, "Valor bruto", "5.131,00");
    await user.click(within(total).getByRole("checkbox", { name: "Resgate total (encerra a posição)" }));
    await submit(user, total, "Registrar");
    await closed(/Resgate/);
    expect(service.position(ledger, id).closed).toBe(true);
    expect(await screen.findByText(/CDB Banco X 2028 \(encerrado\)/)).toBeTruthy();
    undoOnce(workspace);
    expect(snapshot(ledger)).toBe(before);
  });

  it("a redemption known only by its net is incomplete until completed; each is one undo step", async () => {
    const { user, ledger, workspace } = await openInvestimentos();
    const id = cdbOf(ledger);
    const before = snapshot(ledger);
    await menu(user, "Registrar", "Resgate só com o líquido…");
    const box = await dialog(/Resgate com deduções a discriminar/);
    await fill(user, box, "Líquido recebido", "480,00");
    await submit(user, box, "Registrar");
    await closed(/Resgate com deduções/);
    const incomplete = service.eventsOf(ledger, id).find((e) => e.kind === "withdrawal")!;
    expect(incomplete.quality).toBe("incomplete");
    const afterNet = snapshot(ledger);
    const grid = await table("Movimentos");
    expect(flat(rowOf(grid, "Resgate").textContent)).toContain("incompleto");
    expect(flat(rowOf(grid, "Resgate").textContent)).toContain("a discriminar");
    // the portfolio flags the incomplete realized result instead of showing it as complete
    expect(flat(rowOf(await table("Investimentos"), "CDB").textContent)).toContain("(incompleto)");

    // asking to complete without choosing the redemption explains
    await menu(user, "Registrar", "Completar resgate…");
    expect(await screen.findByText("Selecione o resgate incompleto em Movimentos.")).toBeTruthy();
    await user.click(rowOf(grid, "Resgate"));
    await menu(user, "Registrar", "Completar resgate…");
    const complete = await dialog("Completar resgate");
    await fill(user, complete, "Valor bruto", "500,00");
    await fill(user, complete, "Imposto retido", "15,00");
    await fill(user, complete, "Taxas", "5,00");
    await submit(user, complete, "Completar");
    await closed("Completar resgate");
    const completed = service.eventsOf(ledger, id).filter((e) => e.kind === "withdrawal");
    expect(completed.some((e) => e.quality === "complete" && e.net?.eq(Dec.from(480)))).toBe(true);
    undoOnce(workspace);
    expect(snapshot(ledger)).toBe(afterNet);
    undoOnce(workspace);
    expect(snapshot(ledger)).toBe(before);
  });

  it("pays the tax a redemption left due, as one undo step", async () => {
    const { user, ledger, workspace } = await openInvestimentos();
    const id = cdbOf(ledger);
    workspace.act((l) => service.redeem(l, id, makeDate(2026, 4, 1), "1000", cashOf(l), { tax_due_later: "30" }));
    const before = snapshot(ledger);
    await menu(user, "Registrar", "Pagamento de imposto…");
    const box = await dialog("Pagamento de imposto devido");
    await fill(user, box, "Valor", "30,00");
    await submit(user, box, "Registrar");
    await closed("Pagamento de imposto devido");
    expect(ledger.operations.size).toBe(JSON.parse(before)[8] + 1);
    expect(await screen.findByText("Pagamento de imposto registrado.")).toBeTruthy();
    undoOnce(workspace);
    expect(snapshot(ledger)).toBe(before);
  });
});

describe("Simulador de resgate", () => {
  it("asks for a tax rule first (the application brings none)", async () => {
    const { user } = await openInvestimentos();
    await menu(user, "Registrar", "Simular resgate (não grava)…");
    expect(await screen.findByText("Cadastre antes uma regra de imposto (Mais › Regra de imposto…).")).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("creates a rule, simulates with every field and the estimated ones named, writes nothing, and opens the redemption filled", async () => {
    const { user, ledger, workspace } = await openInvestimentos();
    const id = cdbOf(ledger);
    // a rule of the person's own
    await menu(user, "Mais", "Regra de imposto…");
    let box = await dialog("Regra de imposto (simulação)");
    await submit(user, box, "Salvar");
    expect(within(box).getByText("Informe o nome.")).toBeTruthy();
    await fill(user, box, "Nome", "Regra fictícia 15%");
    await submit(user, box, "Salvar");
    expect(within(box).getByText("Informe a alíquota: o aplicativo não traz nenhuma.")).toBeTruthy();
    await fill(user, box, "Alíquota (%)", "15");
    await submit(user, box, "Salvar");
    await closed("Regra de imposto (simulação)");
    const rule = [...ledger.entities<investments.model.TaxRule>("tax_rule").values()][0]!;
    expect(rule.rate?.eq(Dec.from("0.15"))).toBe(true);
    expect(rule.simulated).toBe(true);
    const afterRule = snapshot(ledger);

    await menu(user, "Registrar", "Simular resgate (não grava)…");
    box = await dialog(/Simular resgate — CDB Banco X 2028/);
    await submit(user, box, "Simular");
    expect(within(box).getByText("Informe o valor.")).toBeTruthy();
    await fill(user, box, "Valor bruto a resgatar", "1.000,00");
    await fill(user, box, "Taxas", "10,00");
    await submit(user, box, "Simular");
    const result = await within(box).findByRole("region", { name: "Resultado da simulação" });
    const observed = performance.valueAt(ledger, id, workspace.today());
    const sim = investments.simulation.simulate(ledger, id, workspace.today(), "1000", rule, {
      fees: "10",
      current_value: observed!.valuation.value,
    });
    const text = flat(result.textContent);
    expect(text).toContain("Simulação");
    expect(text).toContain(formatBrl(sim.cost_attributed!));
    expect(text).toContain(formatBrl(sim.gain!));
    expect(text).toContain(formatBrl(sim.tax!));
    expect(text).toContain(formatBrl(sim.net!));
    expect(text).toContain(sim.cost_method);
    expect(text).toContain("Campos estimados: imposto (simulado: Regra fictícia 15%), custo atribuído");
    // nothing was written
    expect(snapshot(ledger)).toBe(afterRule);

    // Registrar resgate…: the redemption opens filled, and asks for confirmation
    await user.click(within(box).getByRole("button", { name: "Registrar resgate…" }));
    const redeem = await dialog(/Resgate — CDB Banco X 2028/);
    expect((within(redeem).getByLabelText(/^Valor bruto/) as HTMLInputElement).value).toBe("1.000,00");
    expect((within(redeem).getByLabelText(/^Taxas descontadas/) as HTMLInputElement).value).toBe("10,00");
    expect(snapshot(ledger)).toBe(afterRule);
    await submit(user, redeem, "Registrar");
    await closed(/Resgate —/);
    expect(service.eventsOf(ledger, id).some((e) => e.kind === "withdrawal" && e.gross?.eq(Dec.from(1000)))).toBe(true);
    undoOnce(workspace);
    expect(snapshot(ledger)).toBe(afterRule);
    undoOnce(workspace);
    expect(ledger.entities("tax_rule").size).toBe(0);
  });

  it("a stale result is not shown after the values change", async () => {
    const { user, workspace } = await openInvestimentos();
    workspace.act((l) =>
      l.put(
        "tax_rule",
        investments.model.TaxRuleSchema.parse({ name: "R", kind: "rate_on_positive_gain", rate: "0.15" }) as never,
      ),
    );
    await menu(user, "Registrar", "Simular resgate (não grava)…");
    const box = await dialog(/Simular resgate/);
    await fill(user, box, "Valor bruto a resgatar", "500,00");
    await submit(user, box, "Simular");
    await within(box).findByRole("region", { name: "Resultado da simulação" });
    await fill(user, box, "Valor bruto a resgatar", "600,00");
    expect(within(box).queryByRole("region", { name: "Resultado da simulação" })).toBeNull();
    expect(within(box).getByText(/simule de novo/)).toBeTruthy();
  });
});

describe("Negociação", () => {
  it("explains that trades are for assets tracked by quantity", async () => {
    const { user, ledger } = await openInvestimentos();
    const before = snapshot(ledger);
    await menu(user, "Negociação", "Compra…");
    expect(await screen.findByText(/Negociações são para ativos acompanhados por quantidade/)).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(snapshot(ledger)).toBe(before);
  });

  it("buys, sells (cost method), registers an opening position, a split and a bonus; each is one undo step", async () => {
    const { user, ledger, workspace } = await openInvestimentos();
    const id = quantityPosition(workspace);
    await user.click(rowOf(await table("Investimentos"), "PETR4"));
    const base = snapshot(ledger);
    const qty = () => trades.holding(ledger, id).quantity.toFixed();

    await menu(user, "Negociação", "Compra…");
    let box = await dialog(/Compra — PETR4/);
    await fill(user, box, "Quantidade", "50");
    await fill(user, box, "Preço unitário", "32,50");
    await fill(user, box, "Custos", "4,90");
    await submit(user, box, "Registrar");
    await closed(/Compra/);
    expect(qty()).toBe("150");
    const buy = service.eventsOf(ledger, id).find((e) => e.kind === "buy" && e.quantity?.eq(Dec.from(50)))!;
    expect(formatBrl(buy.gross!)).toBe("R$ 1.629,90");
    expect(buy.fees.eq(Dec.from("4.90"))).toBe(true);
    // the lots and the movements show it
    expect(flat(rowOf(await table("Lotes"), "compra").textContent)).toContain("50");
    undoOnce(workspace);
    expect(snapshot(ledger)).toBe(base);

    await menu(user, "Negociação", "Venda…");
    box = await dialog(/Venda — PETR4/);
    await fill(user, box, "Quantidade", "40");
    await fill(user, box, "Preço unitário", "35,00");
    await choose(user, box, "Custo", "Por lote (mais antigo)");
    await submit(user, box, "Registrar");
    await closed(/Venda/);
    expect(qty()).toBe("60");
    expect(service.eventsOf(ledger, id).find((e) => e.kind === "sell")!.cost_method).toBeTruthy();
    undoOnce(workspace);
    expect(snapshot(ledger)).toBe(base);

    await menu(user, "Negociação", "Posição inicial…");
    box = await dialog(/Posição inicial — PETR4/);
    await fill(user, box, "Quantidade", "10");
    await fill(user, box, "Custo total conhecido", "250,00");
    await submit(user, box, "Registrar");
    await closed(/Posição inicial/);
    expect(qty()).toBe("110");
    undoOnce(workspace);
    expect(snapshot(ledger)).toBe(base);

    await menu(user, "Negociação", "Desdobramento ou grupamento…");
    box = await dialog(/Desdobramento\/grupamento — PETR4/);
    await fill(user, box, "Fator (2 = cada ação vira 2)", "2");
    await submit(user, box, "Registrar");
    await closed(/Desdobramento/);
    expect(qty()).toBe("200");
    expect(formatBrl(service.remainingCost(ledger, id))).toBe("R$ 3.000,00");
    undoOnce(workspace);
    expect(snapshot(ledger)).toBe(base);

    await menu(user, "Negociação", "Bonificação…");
    box = await dialog(/Bonificação — PETR4/);
    await fill(user, box, "Quantidade recebida", "5");
    await submit(user, box, "Registrar");
    await closed(/Bonificação/);
    expect(qty()).toBe("105");
    undoOnce(workspace);
    expect(snapshot(ledger)).toBe(base);
  });

  it("refuses a sale of more than is held and an invalid quantity, inside the dialog", async () => {
    const { user, ledger, workspace } = await openInvestimentos();
    quantityPosition(workspace);
    await user.click(rowOf(await table("Investimentos"), "PETR4"));
    const base = snapshot(ledger);
    await menu(user, "Negociação", "Venda…");
    const box = await dialog(/Venda — PETR4/);
    await fill(user, box, "Quantidade", "abc");
    await fill(user, box, "Preço unitário", "35,00");
    await submit(user, box, "Registrar");
    expect(within(box).getByText("Quantidade inválida.")).toBeTruthy();
    await fill(user, box, "Quantidade", "1.000");
    await submit(user, box, "Registrar");
    expect(within(box).getByRole("alert").textContent).toBeTruthy();
    expect(snapshot(ledger)).toBe(base);
  });
});

describe("Características, regras e índices", () => {
  it("edits the characteristics of the selected investment as one undo step", async () => {
    const { user, ledger, workspace } = await openInvestimentos();
    const id = cdbOf(ledger);
    const before = snapshot(ledger);
    await menu(user, "Mais", /^Características/);
    const box = await dialog("Características do investimento");
    await fill(user, box, "Emissor", "Banco Y S.A.");
    await submit(user, box, "Salvar");
    await closed("Características do investimento");
    expect(investments.profile.profileOf(ledger, id)!.issuer).toBe("Banco Y S.A.");
    expect(await screen.findByText("Características salvas.")).toBeTruthy();
    undoOnce(workspace);
    expect(snapshot(ledger)).toBe(before);
  });

  it("imports a reference index from a file and sets it beside the return, only on the dates the series has", async () => {
    const { user, ledger, workspace } = await openInvestimentos();
    const id = cdbOf(ledger);
    const before = snapshot(ledger);
    await menu(user, "Mais", "Importar índice de referência…");
    const box = await dialog("Importar índice de referência");
    await submit(user, box, "Importar");
    expect(within(box).getByText("Escolha o arquivo da série (data;valor).")).toBeTruthy();
    const csv = new File(["data;valor\n28/01/2026;100,00\n28/03/2026;102,00\n"], "cdi.csv", { type: "text/csv" });
    await user.upload(within(box).getByLabelText(/Série do índice/), csv);
    expect((within(box).getByLabelText(/Nome do índice/) as HTMLInputElement).value).toBe("cdi");
    await fill(user, box, "Nome do índice", "CDI local");
    await submit(user, box, "Importar");
    await closed("Importar índice de referência");
    const bench = [...investments.benchmarks.benchmarks(ledger).values()][0]!;
    expect(bench.name).toBe("CDI local");
    expect(bench.points).toHaveLength(2);
    expect(await screen.findByText("Índice CDI local importado.")).toBeTruthy();

    // beside the return
    await choose(user, document.body, "Índice de referência", "CDI local");
    await choose(user, document.body, "Início do período", "28/01/2026");
    const grid = await table("Rentabilidade por método");
    const row = flat(rowOf(grid, "variação do índice CDI local").textContent);
    expect(row).toContain("2,00%");
    // a period whose ends the series does not have: unavailable, with the reason
    await choose(user, document.body, "Início do período", "28/02/2026");
    const gap = flat(rowOf(await table("Rentabilidade por método"), "variação do índice CDI local").textContent);
    expect(gap).toContain("indisponível");
    expect(gap).toContain("A série local não tem valores exatamente nas datas do período.");
    undoOnce(workspace);
    expect(snapshot(ledger)).toBe(before);
    expect(id).toBeTruthy();
  });

  it("refuses a file that is not a series", async () => {
    const { user, ledger } = await openInvestimentos();
    const before = snapshot(ledger);
    await menu(user, "Mais", "Importar índice de referência…");
    const box = await dialog("Importar índice de referência");
    await user.upload(within(box).getByLabelText(/Série do índice/), new File(["nada"], "x.csv", { type: "text/csv" }));
    await submit(user, box, "Importar");
    expect(within(box).getByText("O arquivo precisa de ao menos duas datas com valores.")).toBeTruthy();
    expect(snapshot(ledger)).toBe(before);
  });
});

describe("Notas de negociação", () => {
  it("lists the trades of an approved note with its costs, and goes to the investment", async () => {
    const { user, workspace } = await openInvestimentos();
    const id = quantityPosition(workspace);
    workspace.act((l) =>
      trades.buy(l, id, makeDate(2026, 2, 3), "10", "30.00", cashOf(l), { fees: "1.20", note: "nota 8765" }),
    );
    const grid = await table("Notas de negociação");
    const text = flat(rowOf(grid, "8765").textContent);
    expect(text).toContain("03/02/2026");
    expect(text).toContain("1 compra");
    expect(text).toContain("PETR4");
    expect(text).toContain("R$ 301,20");
    expect(text).toContain("R$ 1,20");
    expect(text).toContain("incorporada");
    await user.click(screen.getByRole("button", { name: "Ver investimento" }));
    expect(await screen.findByText("Selecione uma nota na tabela.")).toBeTruthy();
    await user.click(rowOf(grid, "8765"));
    await user.click(screen.getByRole("button", { name: "Ver investimento" }));
    expect(await screen.findByRole("heading", { level: 2, name: "PETR4" })).toBeTruthy();
  });
});
