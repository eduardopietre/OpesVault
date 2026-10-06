/** Faturas (paying, late payment settles the overdue bill first) and Financiamentos (contract, schedule, payments). */
import {
  AccountType,
  CardSchema,
  Dec,
  dom,
  formatBrl,
  formatDateBr,
  type Id,
  type IsoDate,
  type Ledger,
  LedgerAccountSchema,
  ymOf,
} from "@opesvault/domain";
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
  rowById,
  rowOf,
  snapshot,
  submit,
  table,
  undoOnce,
} from "./contas_harness.tsx";

vi.mock("../../../../packages/ui/src/chart/echarts.ts", async () => await import("./fake_echarts.ts"));

const { cards, loans } = dom;

const cardOf = (ledger: Ledger) => [...ledger.cards.values()][0]!;
const dueText = (due: IsoDate) => formatDateBr(due);
/** The card's bills from `from` months before today to six months after, those with movement. */
const billsOf = (ledger: Ledger, today: IsoDate, from = 6) => {
  const here = ymOf(today);
  const months = Array.from({ length: from + 7 }, (_, i) => {
    const total = here.year * 12 + here.month - 1 + i - from;
    return { year: Math.floor(total / 12), month: (total % 12) + 1 };
  });
  return cards.bills(ledger, cardOf(ledger).id, months).filter((b) => !b.total.isZero() || !b.payments.isZero());
};
const shown = (ledger: Ledger, today: IsoDate) => billsOf(ledger, today, 6);
const everything = (ledger: Ledger, today: IsoDate) => billsOf(ledger, today, 36);
const monthOf = (bill: dom.cards.Bill) => `${bill.cycle.month.year}-${String(bill.cycle.month.month).padStart(2, "0")}`;

async function openBills() {
  const opened = await openContas();
  await goTab(opened.user, "Faturas");
  return { ...opened, grid: await table("Faturas do cartão") };
}

describe("Faturas", () => {
  it("lists the card's bills with the amounts and the state in words, and draws them month by month", async () => {
    const { ledger, workspace, grid } = await openBills();
    const bills = shown(ledger, workspace.today());
    expect(bills.length).toBeGreaterThan(2);
    for (const bill of bills) {
      const text = flat(rowOf(grid, dueText(bill.cycle.due)).textContent);
      expect(text).toContain(formatBrl(bill.total));
      expect(text).toContain(formatBrl(bill.remaining));
      expect(text).toContain(
        { open: "Aberta", closed: "Fechada", paid: "Paga", partially_paid: "Paga parcialmente", overdue: "Vencida" }[
          bill.status(workspace.today())
        ],
      );
    }
    expect(screen.getByRole("heading", { name: "Faturas mês a mês" })).toBeTruthy();
    expect(screen.getByRole("img", { name: /Faturas: Cartão X: gráfico com Total da fatura, Pago/ })).toBeTruthy();
  });

  it("selects the oldest bill with a balance, so Pagar… is ready without a click", async () => {
    const { ledger, workspace, grid } = await openBills();
    const oldest = shown(ledger, workspace.today()).find((b) => b.remaining.isPositive())!;
    const selected = within(grid)
      .getAllByRole("row")
      .find((row) => row.getAttribute("aria-selected") === "true")!;
    expect(flat(selected.textContent)).toContain(dueText(oldest.cycle.due));
    expect((screen.getByRole("button", { name: "Pagar…" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("pays the selected bill: remaining amount, today and the card's account come filled in; one undo reverts", async () => {
    const { ledger, workspace, user } = await openBills();
    const today = workspace.today();
    const card = cardOf(ledger);
    const oldest = shown(ledger, today).find((b) => b.remaining.isPositive())!;
    const before = snapshot(ledger);
    await user.click(screen.getByRole("button", { name: "Pagar…" }));
    const box = await dialog("Pagar fatura — Cartão X");
    expect(flat(box.textContent)).toContain(`Vencimento ${dueText(oldest.cycle.due)}`);
    expect((within(box).getByLabelText("Valor") as HTMLInputElement).value).toBe(
      formatBrl(oldest.remaining).replace("R$ ", ""),
    );
    expect((within(box).getByLabelText("Data do pagamento") as HTMLInputElement).value).toBe(dueText(today));
    expect(within(box).getByRole("combobox", { name: "Pago pela conta" }).textContent).toContain("Banco A");
    // after the due date: the note says the overdue bill is settled first
    expect(within(box).getByText("Pagamento após o vencimento: quita primeiro esta fatura vencida.")).toBeTruthy();
    await submit(user, box, "Registrar pagamento");
    await closed(/Pagar fatura/);
    expect(await screen.findByText("Pagamento da fatura de Cartão X registrado.")).toBeTruthy();
    const payment = [...ledger.operations.values()].at(-1)!;
    expect(payment).toMatchObject({ kind: "card_payment", card_id: card.id });
    expect(payment.postings.find((p) => p.account_id === card.liability_account_id)!.amount.eq(oldest.remaining)).toBe(
      true,
    );
    // the money went to the oldest overdue bill (docs/04 §5), which may be older than the six months shown
    expect(everything(ledger, today).some((b) => b.payments.isPositive())).toBe(true);
    undoOnce(workspace);
    expect(snapshot(ledger)).toBe(before);
  });

  it("a late payment on a newer bill settles the oldest overdue bill first (docs/04 §5)", async () => {
    const { ledger, workspace, user, grid } = await openBills();
    const today = workspace.today();
    const open = everything(ledger, today).filter((b) => b.remaining.isPositive());
    const oldest = open[0]!;
    const newer = shown(ledger, today)
      .filter((b) => b.remaining.isPositive())
      .at(-1)!;
    expect(oldest.cycle.due < newer.cycle.due).toBe(true);
    await pick(user, grid, dueText(newer.cycle.due));
    await user.click(screen.getByRole("button", { name: "Pagar…" }));
    const box = await dialog("Pagar fatura — Cartão X");
    await fill(user, box, "Valor", "300,00");
    await submit(user, box, "Registrar pagamento");
    await closed(/Pagar fatura/);
    const after = everything(ledger, today);
    // the 300,00 went oldest first, each overdue bill taking what it still owed, not to the bill that was selected
    let left = Dec.from(300);
    for (const bill of open) {
      const share = Dec.min(left, bill.remaining);
      expect(after.find((b) => monthOf(b) === monthOf(bill))!.payments.eq(share), monthOf(bill)).toBe(true);
      left = left.sub(share);
    }
    expect(left.isZero()).toBe(true);
    expect(after.find((b) => monthOf(b) === monthOf(oldest))!.remaining.isZero()).toBe(true);
    expect(after.find((b) => monthOf(b) === monthOf(newer))!.payments.isZero()).toBe(true);
    undoOnce(workspace);
    expect(everything(ledger, today).every((b) => b.payments.isZero())).toBe(true);
  });

  it("refuses an amount that is not positive or a date that is not a date, inside the dialog", async () => {
    const { ledger, workspace, user } = await openBills();
    const before = snapshot(ledger);
    await user.click(screen.getByRole("button", { name: "Pagar…" }));
    const box = await dialog("Pagar fatura — Cartão X");
    await fill(user, box, "Valor", "0,00");
    await submit(user, box, "Registrar pagamento");
    expect(within(box).getByText("Informe um valor positivo.")).toBeTruthy();
    await fill(user, box, "Valor", "10,00");
    await fill(user, box, "Data do pagamento", "31/02/2026");
    await submit(user, box, "Registrar pagamento");
    expect(within(box).getByText("A data do pagamento é inválida. Use dd/mm/aaaa.")).toBeTruthy();
    expect(snapshot(ledger)).toBe(before);
    expect(workspace.undoStack.canUndo()).toBe(false);
    await submit(user, box, "Cancelar");
    await closed(/Pagar fatura/);
  });

  it("says a paid bill is already paid instead of opening the payment (double click)", async () => {
    const { ledger, workspace, user } = await openBills();
    const today = workspace.today();
    const card = cardOf(ledger);
    const owed = everything(ledger, today).reduce((sum, b) => sum.add(b.remaining), Dec.from(0));
    workspace.act((l) => l.recordCardPayment(card.id, card.settlement_account_id!, owed, today));
    const paid = shown(ledger, today).find((b) => b.status(today) === "paid")!;
    const row = rowById(await table("Faturas do cartão"), monthOf(paid));
    expect(flat(row.textContent)).toContain("Paga");
    await user.dblClick(row);
    expect(await screen.findByText("Esta fatura já está paga.")).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("switches card: another card has its own bills, or none", async () => {
    const { ledger, workspace, user } = await openBills();
    const first = cardOf(ledger);
    const liability = [...ledger.accounts.values()].find((a) => a.subtype === "credit_card")!;
    workspace.act((l) => {
      const account = l.addAccount(
        LedgerAccountSchema.parse({ name: "Cartão Novo", type: AccountType.LIABILITY, subtype: liability.subtype }),
      );
      l.addCard(
        CardSchema.parse({
          name: "Cartão Novo",
          liability_account_id: account.id,
          holder_id: first.holder_id,
          last4: "9999",
          closing_day: 5,
          due_day: 12,
        }),
      );
    });
    await user.click(screen.getByRole("combobox", { name: "Cartão" }));
    await user.click(await screen.findByRole("option", { name: "Cartão Novo" }));
    expect(await screen.findByRole("heading", { name: "Sem faturas por perto" })).toBeTruthy();
    expect(screen.queryByRole("grid", { name: "Faturas do cartão" })).toBeNull();
    expect((screen.getByRole("button", { name: "Pagar…" }) as HTMLButtonElement).disabled).toBe(true);
    await user.click(screen.getByRole("combobox", { name: "Cartão" }));
    await user.click(await screen.findByRole("option", { name: "Cartão X" }));
    expect(await table("Faturas do cartão")).toBeTruthy();
  });
});

// ── financings ───────────────────────────────────

const planOf = (ledger: Ledger) => [...loans.plans(ledger).values()][0]!;
const scheduleRowText = async (number: number) => {
  const grid = await screen.findByRole("grid", { name: "Cronograma de parcelas" });
  return flat(rowById(grid, String(number)).textContent);
};

async function openLoans() {
  const opened = await openContas();
  await goTab(opened.user, "Financiamentos");
  return { ...opened, grid: await table("Financiamentos") };
}

describe("Financiamentos", () => {
  it("lists the contract with system, rate, paid installments, next one and the balance, then its figures and schedule", async () => {
    const { ledger, workspace, grid } = await openLoans();
    const plan = planOf(ledger);
    const status = loans.status(ledger, plan.id, workspace.today());
    const text = flat(rowOf(grid, plan.name).textContent);
    expect(text).toContain("Price");
    expect(text).toContain("1,4900% ao mês");
    expect(text).toContain(`${status.paid} de ${status.installments.length}`);
    expect(text).toContain(formatBrl(status.outstanding));
    const figures = flat(screen.getByRole("region", { name: `Situação de ${plan.name}` }).textContent);
    expect(figures).toContain("Saldo devedor");
    expect(figures).toContain("Juros a pagar");
    expect(figures).toContain(String(status.overdue));
    expect(figures).toContain(formatDateBr(status.end!));
    expect(screen.getByRole("heading", { name: "Saldo devedor, juros e amortização" })).toBeTruthy();
    // the schedule: paid and overdue installments say so, and the next unpaid one is selected
    expect(await scheduleRowText(1)).toContain("Paga");
    expect(await scheduleRowText(3)).toContain("Vencida");
    const schedule = await screen.findByRole("grid", { name: "Cronograma de parcelas" });
    const selected = within(schedule)
      .getAllByRole("row")
      .find((row) => row.getAttribute("aria-selected") === "true")!;
    expect(selected.getAttribute("data-row-id")).toBe("3");
  });

  it("pays the selected installment with amortization, interest and fees apart; one undo reverts", async () => {
    const { ledger, workspace, user } = await openLoans();
    const plan = planOf(ledger);
    const item = loans.planSchedule(ledger, plan.id).find((i) => i.number === 3)!;
    const before = snapshot(ledger);
    await user.click(screen.getByRole("button", { name: "Pagar parcela…" }));
    const box = await dialog(`Pagar parcela 3 — ${plan.name}`);
    expect(flat(box.textContent)).toContain(`amortização ${formatBrl(item.amortization)}`);
    expect(flat(box.textContent)).toContain(`juros ${formatBrl(item.interest)}`);
    expect((within(box).getByLabelText("Valor pago") as HTMLInputElement).value).toBe(
      formatBrl(item.payment).replace("R$ ", ""),
    );
    await submit(user, box, "Registrar pagamento");
    await closed(/Pagar parcela/);
    expect(await screen.findByText("Parcela 3 registrada: amortização, juros e encargos separados.")).toBeTruthy();
    expect(loans.paidNumbers(ledger, plan.id).has(3)).toBe(true);
    const op = [...ledger.operations.values()].at(-1)!;
    const amount = (accountId: Id) => op.postings.find((p) => p.account_id === accountId)?.amount;
    expect(amount(plan.liability_account_id)!.eq(item.amortization)).toBe(true);
    expect(amount(plan.interest_category_id)!.eq(item.interest)).toBe(true);
    expect(await scheduleRowText(3)).toContain("Paga");
    undoOnce(workspace);
    expect(snapshot(ledger)).toBe(before);
    expect(loans.paidNumbers(ledger, plan.id).has(3)).toBe(false);
  });

  it("an amount above the installment (late charges) goes to interest; below it is refused", async () => {
    const { ledger, workspace, user } = await openLoans();
    const plan = planOf(ledger);
    const item = loans.planSchedule(ledger, plan.id).find((i) => i.number === 3)!;
    await user.click(screen.getByRole("button", { name: "Pagar parcela…" }));
    const box = await dialog(/Pagar parcela 3/);
    await fill(user, box, "Valor pago", "1.000,00");
    await submit(user, box, "Registrar pagamento");
    expect(within(box).getByText("O valor não pode ser menor que a parcela.")).toBeTruthy();
    expect(workspace.undoStack.canUndo()).toBe(false);
    await fill(user, box, "Valor pago", formatBrl(item.payment.add("28.50")).replace("R$ ", ""));
    await submit(user, box, "Registrar pagamento");
    await closed(/Pagar parcela/);
    const op = [...ledger.operations.values()].at(-1)!;
    const interest = op.postings.find((p) => p.account_id === plan.interest_category_id)!.amount;
    expect(interest.eq(item.interest.add("28.50"))).toBe(true);
  });

  it("says an installment is already paid instead of opening the payment (double click)", async () => {
    const { user } = await openLoans();
    const schedule = await screen.findByRole("grid", { name: "Cronograma de parcelas" });
    await user.dblClick(rowById(schedule, "1"));
    expect(await screen.findByText("Esta parcela já está paga.")).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("simulates an early payment while typing, then registers it; the schedule is recalculated; one undo reverts", async () => {
    const { ledger, workspace, user } = await openLoans();
    const plan = planOf(ledger);
    const before = snapshot(ledger);
    await user.click(screen.getByRole("button", { name: "Mais" }));
    await user.click(await screen.findByRole("menuitem", { name: "Simular ou registrar amortização antecipada…" }));
    const box = await dialog(`Amortização antecipada — ${plan.name}`);
    const result = within(box).getByRole("status", { name: "Resultado da simulação" });
    expect(result.textContent).toContain("Informe um valor para ver a economia.");
    await fill(user, box, "Valor da amortização", "10.000,00");
    const term = loans.simulatePrepayment(ledger, plan.id, "10000", loans.PrepaymentMode.REDUCE_TERM);
    expect(result.textContent).toContain(
      `Juros a pagar: ${formatBrl(term.interestBefore)} → ${formatBrl(term.interestAfter)} (economia ${formatBrl(term.interestSaved)})`,
    );
    expect(result.textContent).toContain(`Parcelas restantes: ${term.installmentsBefore} → ${term.installmentsAfter}`);
    expect(result.textContent).toContain("nada é registrado até você confirmar");
    // nothing was recorded by simulating
    expect(snapshot(ledger)).toBe(before);
    // the other effect changes the numbers
    await choose(user, box, "Efeito", "Reduzir a parcela");
    const payment = loans.simulatePrepayment(ledger, plan.id, "10000", loans.PrepaymentMode.REDUCE_PAYMENT);
    expect(result.textContent).toContain(
      `Próxima parcela: ${formatBrl(payment.nextPaymentBefore!)} → ${formatBrl(payment.nextPaymentAfter!)}`,
    );
    await submit(user, box, "Registrar amortização");
    await closed(/Amortização antecipada/);
    expect(await screen.findByText("Amortização antecipada registrada; o cronograma foi recalculado.")).toBeTruthy();
    expect(loans.prepayments(ledger).size).toBe(1);
    const status = loans.status(ledger, plan.id, workspace.today());
    expect(status.installments.some((i) => !i.prepaidAfter.isZero())).toBe(true);
    expect(await scheduleRowText(2)).toContain("amortização antecipada de R$ 10.000,00");
    undoOnce(workspace);
    expect(snapshot(ledger)).toBe(before);
    expect(loans.prepayments(ledger).size).toBe(0);
  });

  it("refuses an empty amount or one above the debt for an early payment", async () => {
    const { workspace, user } = await openLoans();
    await user.click(screen.getByRole("button", { name: "Mais" }));
    await user.click(await screen.findByRole("menuitem", { name: /amortização antecipada/ }));
    const box = await dialog(/Amortização antecipada/);
    await submit(user, box, "Registrar amortização");
    expect(within(box).getByText("Informe um valor positivo.")).toBeTruthy();
    await fill(user, box, "Valor da amortização", "999.999,00");
    await submit(user, box, "Registrar amortização");
    expect(within(box).getByText("O valor passa do saldo devedor.")).toBeTruthy();
    expect(workspace.undoStack.canUndo()).toBe(false);
  });

  it("creates a financing as the contract says (existing debt as opening balance) and one undo removes it all", async () => {
    const { ledger, workspace, user } = await openLoans();
    const before = snapshot(ledger);
    const plans = loans.plans(ledger).size;
    await user.click(screen.getByRole("button", { name: "Novo financiamento…" }));
    const box = await dialog("Novo financiamento");
    await fill(user, box, "Nome", "Apartamento");
    await fill(user, box, "Saldo devedor", "120.000,00");
    await fill(user, box, "Parcelas restantes", "120");
    await fill(user, box, "Taxa de juros (%)", "0,80");
    await choose(user, box, "Sistema de amortização", /SAC/);
    await fill(user, box, "Vencimento da próxima parcela", "10/11/2026");
    await fill(user, box, "Seguros e tarifas por parcela", "45,00");
    await submit(user, box, "Criar financiamento");
    await closed("Novo financiamento");
    expect(loans.plans(ledger).size).toBe(plans + 1);
    const plan = [...loans.plans(ledger).values()].find((p) => p.name === "Apartamento")!;
    expect(plan).toMatchObject({ term: 120, system: "sac", first_due: "2026-11-10" });
    expect(plan.monthly_rate.eq("0.008")).toBe(true);
    expect(plan.fees_per_installment.eq(45)).toBe(true);
    expect(plan.fees_category_id).toBe(plan.interest_category_id); // both start on "Juros e encargos"
    const liability = ledger.account(plan.liability_account_id);
    expect(liability).toMatchObject({ type: AccountType.LIABILITY, subtype: "loan" });
    expect(await screen.findByText("Financiamento criado. O cronograma foi calculado pelo contrato.")).toBeTruthy();
    // the new contract is selected, with its schedule
    expect(await screen.findByRole("region", { name: "Situação de Apartamento" })).toBeTruthy();
    expect(await scheduleRowText(1)).toContain("A vencer");
    undoOnce(workspace);
    expect(snapshot(ledger)).toBe(before);
    expect(loans.plans(ledger).size).toBe(plans);
  });

  it("creates a financing whose money was received now in an account, with a yearly rate", async () => {
    const { ledger, user } = await openLoans();
    const checking = [...ledger.accounts.values()].find((a) => a.name === "Banco A")!;
    await user.click(screen.getByRole("button", { name: "Novo financiamento…" }));
    const box = await dialog("Novo financiamento");
    await fill(user, box, "Nome", "Empréstimo pessoal");
    await fill(user, box, "Saldo devedor", "5.000,00");
    await fill(user, box, "Parcelas restantes", "12");
    await fill(user, box, "Taxa de juros (%)", "12");
    await choose(user, box, "Período da taxa", "% ao ano (efetiva)");
    expect(
      (within(box).getByRole("combobox", { name: "Conta que recebeu o dinheiro" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    await choose(user, box, "Como a dívida entra no livro", "Dinheiro recebido agora numa conta");
    await choose(user, box, "Conta que recebeu o dinheiro", "Banco A");
    await fill(user, box, "Data do saldo", "01/10/2026");
    await submit(user, box, "Criar financiamento");
    await closed("Novo financiamento");
    const plan = [...loans.plans(ledger).values()].find((p) => p.name === "Empréstimo pessoal")!;
    // a yearly effective 12% is about 0,9489% a month
    expect(plan.monthly_rate.toFixed().startsWith("0.00948")).toBe(true);
    const release = [...ledger.operations.values()].find((o) => o.description === "Liberação — Empréstimo pessoal")!;
    expect(release.postings.some((p) => p.account_id === checking.id && p.amount.eq(5000))).toBe(true);
  });

  it("checks the contract before saving: name, balance, rate, term", async () => {
    const { ledger, workspace, user } = await openLoans();
    const before = snapshot(ledger);
    await user.click(screen.getByRole("button", { name: "Novo financiamento…" }));
    const box = await dialog("Novo financiamento");
    await submit(user, box, "Criar financiamento");
    expect(within(box).getByText("Informe o nome do financiamento.")).toBeTruthy();
    await fill(user, box, "Nome", "Teste");
    await submit(user, box, "Criar financiamento");
    expect(within(box).getByText("Informe o saldo devedor.")).toBeTruthy();
    await fill(user, box, "Saldo devedor", "1.000,00");
    await fill(user, box, "Taxa de juros (%)", "abc");
    await submit(user, box, "Criar financiamento");
    expect(within(box).getByText("Taxa inválida. Use o formato 0,99.")).toBeTruthy();
    await fill(user, box, "Taxa de juros (%)", "100");
    await submit(user, box, "Criar financiamento");
    expect(within(box).getByText("Informe a taxa em %, entre 0 e 100.")).toBeTruthy();
    await fill(user, box, "Taxa de juros (%)", "1");
    await fill(user, box, "Parcelas restantes", "0");
    await submit(user, box, "Criar financiamento");
    expect(within(box).getByText("Informe de 1 a 600 parcelas.")).toBeTruthy();
    expect(snapshot(ledger)).toBe(before);
    expect(workspace.undoStack.canUndo()).toBe(false);
  });

  it("opens the contract's operations in the Livro (Ver lançamentos do financiamento)", async () => {
    const { ledger, router, user } = await openLoans();
    await user.click(screen.getByRole("button", { name: "Mais" }));
    await user.click(await screen.findByRole("menuitem", { name: "Ver lançamentos do financiamento" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/livro"));
    expect((router.state.location.search as { ref?: string }).ref).toBe(`conta:${planOf(ledger).liability_account_id}`);
  });

  it("explains that nothing is selected in an empty project", async () => {
    const { user } = await openContas("/contas", { empty: true });
    await goTab(user, "Financiamentos");
    await user.click(screen.getByRole("button", { name: "Pagar parcela…" }));
    expect(await screen.findByText("Selecione uma parcela.")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Mais" }));
    await user.click(await screen.findByRole("menuitem", { name: /amortização antecipada/ }));
    expect(await screen.findByText("Selecione um financiamento.")).toBeTruthy();
  });
});
