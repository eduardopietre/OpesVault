/** Regras (own rules, learned proposals, contradicted rules) and the links into the page (docs `data/links.ts`). */
import {
  AccountType,
  Dec,
  dom,
  formatDateBr,
  importing,
  makeDate,
  ymOf,
  type Id,
  type Ledger,
} from "@opesvault/domain";
import { act as reactAct, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { alertLink, eventLink } from "../../src/data/links.ts";
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
} from "./contas_harness.tsx";

vi.mock("../../../../packages/ui/src/chart/echarts.ts", async () => await import("./fake_echarts.ts"));

const { rules, learning } = importing;
const { ItemStatus } = importing.importModel;

const category = (ledger: Ledger, name: string) =>
  ledger.categories(AccountType.EXPENSE).find((c) => c.name === name)!.id;
const rulesOf = (ledger: Ledger) => [...rules.rules(ledger).values()];
const patterns = (ledger: Ledger) =>
  JSON.stringify(rulesOf(ledger).map((r) => [r.id, r.pattern, r.target_account_id, r.active, r.version]));

async function openRules() {
  const opened = await openContas();
  await goTab(opened.user, "Regras");
  return { ...opened, grid: await table("Regras de categoria") };
}

/** Three purchases with the same description in the same category: what the app learns from. */
function learnFrom(
  ledger: Ledger,
  workspace: { act: (f: (l: Ledger) => unknown) => unknown },
  text: string,
  name: string,
) {
  const bank = [...ledger.accounts.values()].find((a) => a.name === "Banco A")!.id;
  workspace.act((l) => {
    for (const day of [2, 9, 16]) l.recordExpense(bank, category(l, name), "30.00", makeDate(2026, 3, day), text);
  });
}

describe("Regras", () => {
  it("lists the user's rules with category, scope, uses and state, and explains the order of the sources", async () => {
    const { ledger, grid } = await openRules();
    for (const rule of rulesOf(ledger)) {
      const text = flat(rowOf(grid, rule.pattern).textContent);
      expect(text).toContain(ledger.account(rule.target_account_id).name);
      expect(text).toContain("Qualquer conta");
      expect(text).toContain("Ativa");
      expect(text).toContain(String(rules.usage(ledger, rule.id)));
    }
    expect(screen.getByText(/A escolha feita à mão vale mais que tudo/)).toBeTruthy();
  });

  it("previews how many pending items a rule catches, creates it and re-categorizes them; one undo reverts all", async () => {
    const { ledger, workspace, user } = await openRules();
    const pending = [...importing.importStore.items(ledger).values()].filter(
      (i) =>
        (i.status === ItemStatus.READY || i.status === ItemStatus.NEEDS_REVIEW) && i.description.trim().length >= 6,
    );
    expect(pending.length).toBeGreaterThan(0);
    const sample = pending.find((i) => i.target_account_id === null || i.suggestion_source !== null) ?? pending[0]!;
    const pattern = rules.suggestPattern(sample.description);
    expect(rules.normalize(pattern).length).toBeGreaterThanOrEqual(rules.MIN_PATTERN);
    const before = patterns(ledger);
    const items = snapshot(ledger);
    await user.click(screen.getByRole("button", { name: "Nova regra…" }));
    const box = await dialog("Regra de categoria");
    expect(within(box).getByRole("status").textContent).toBe("Digite ao menos 3 caracteres.");
    await fill(user, box, "A descrição contém", pattern);
    const hits = pending.filter((i) => rules.normalize(i.description).includes(rules.normalize(pattern)));
    expect(within(box).getByRole("status").textContent).toContain(`Pega ${hits.length} item(ns) pendente(s) agora.`);
    await choose(user, box, "Categoria", "Despesa: Lazer");
    await submit(user, box, "Criar regra");
    await closed("Regra de categoria");
    const created = rulesOf(ledger).find((r) => r.pattern === rules.normalize(pattern))!;
    expect(created.target_account_id).toBe(category(ledger, "Lazer"));
    expect(created.account_id).toBeNull();
    expect(await screen.findByText(/^Regra criada\. \d+ item\(ns\) pendente\(s\) recategorizado\(s\)\.$/)).toBeTruthy();
    // the rule is in the list and has been used by the items it caught (a person's own choice stays)
    expect(flat((await table("Regras de categoria")).textContent)).toContain(rules.normalize(pattern));
    const used = [...importing.importStore.items(ledger).values()].filter(
      (i) => i.suggestion_source === `user_rule:${created.id}`,
    );
    expect(used.every((i) => i.target_account_id === category(ledger, "Lazer"))).toBe(true);
    undoOnce(workspace);
    expect(patterns(ledger)).toBe(before);
    expect(snapshot(ledger)).toBe(items);
  });

  it("does not touch the pending items when 'Aplicar agora' is off", async () => {
    const { ledger, user } = await openRules();
    const sample = [...importing.importStore.items(ledger).values()].find(
      (i) => (i.status === ItemStatus.READY || i.status === ItemStatus.NEEDS_REVIEW) && i.description.length > 5,
    )!;
    const targets = JSON.stringify([...importing.importStore.items(ledger).values()].map((i) => i.target_account_id));
    await user.click(screen.getByRole("button", { name: "Nova regra…" }));
    const box = await dialog("Regra de categoria");
    await fill(user, box, "A descrição contém", rules.suggestPattern(sample.description));
    await choose(user, box, "Categoria", "Despesa: Lazer");
    await user.click(within(box).getByRole("checkbox", { name: "Aplicar agora aos itens pendentes de revisão" }));
    await submit(user, box, "Criar regra");
    await closed("Regra de categoria");
    expect(await screen.findByText(/Regra criada\. 0 item\(ns\) pendente\(s\) recategorizado\(s\)\./)).toBeTruthy();
    expect(JSON.stringify([...importing.importStore.items(ledger).values()].map((i) => i.target_account_id))).toBe(
      targets,
    );
  });

  it("refuses a missing category, a short text and a repeated rule, inside the dialog", async () => {
    const { ledger, workspace, user } = await openRules();
    const before = patterns(ledger);
    await user.click(screen.getByRole("button", { name: "Nova regra…" }));
    const box = await dialog("Regra de categoria");
    await submit(user, box, "Criar regra");
    expect(within(box).getByText("Escolha a categoria.")).toBeTruthy();
    await choose(user, box, "Categoria", "Despesa: Lazer");
    await fill(user, box, "A descrição contém", "ab");
    await submit(user, box, "Criar regra");
    expect(within(box).getByText("O texto precisa ter ao menos 3 caracteres.")).toBeTruthy();
    await fill(user, box, "A descrição contém", "Padaria");
    await submit(user, box, "Criar regra");
    expect(within(box).getByText("Já existe uma regra ativa com esse texto para essa conta.")).toBeTruthy();
    expect(patterns(ledger)).toBe(before);
    expect(workspace.undoStack.canUndo()).toBe(false);
  });

  it("edits a rule asking the reason, kept in the history; one undo reverts", async () => {
    const { ledger, workspace, user, grid } = await openRules();
    const rule = rulesOf(ledger)[0]!;
    const before = patterns(ledger);
    await pick(user, grid, rule.pattern);
    await user.click(screen.getByRole("button", { name: "Editar…" }));
    const box = await dialog("Regra de categoria");
    expect((within(box).getByLabelText(/^A descrição contém/) as HTMLInputElement).value).toBe(rule.pattern);
    await choose(user, box, "Categoria", "Despesa: Lazer");
    await submit(user, box, "Salvar regra");
    expect(within(box).getByText("Informe o motivo da alteração.")).toBeTruthy();
    await fill(user, box, "Motivo da alteração", "Padaria virou lazer");
    await submit(user, box, "Salvar regra");
    await closed("Regra de categoria");
    const saved = rules.rules(ledger).get(rule.id)!;
    expect(saved).toMatchObject({ target_account_id: category(ledger, "Lazer"), version: rule.version + 1 });
    expect(ledger.historyOf(rule.id).at(-1)!.reason).toBe("Padaria virou lazer");
    expect(await screen.findByText("Regra alterada.")).toBeTruthy();
    undoOnce(workspace);
    expect(patterns(ledger)).toBe(before);
  });

  it("turns a rule off and on, asking the reason each time; one undo reverts each", async () => {
    const { ledger, workspace, user, grid } = await openRules();
    const rule = rulesOf(ledger)[0]!;
    await pick(user, grid, rule.pattern);
    await user.click(screen.getByRole("button", { name: "Ativar ou desativar…" }));
    let box = await dialog("Desativar regra");
    await submit(user, box, "Desativar");
    expect(within(box).getByText("O motivo é obrigatório.")).toBeTruthy();
    await fill(user, box, "Motivo", "não vale mais");
    await submit(user, box, "Desativar");
    await closed("Desativar regra");
    expect(rules.rules(ledger).get(rule.id)!.active).toBe(false);
    expect(await screen.findByText(/^Regra desativada\. \d+ item\(ns\) pendente\(s\) revisto\(s\)\.$/)).toBeTruthy();
    expect(flat(rowOf(await table("Regras de categoria"), rule.pattern).textContent)).toContain("Desativada");
    await user.click(screen.getByRole("button", { name: "Ativar ou desativar…" }));
    box = await dialog("Ativar regra");
    await fill(user, box, "Motivo", "voltou");
    await submit(user, box, "Ativar");
    await closed("Ativar regra");
    expect(rules.rules(ledger).get(rule.id)!.active).toBe(true);
    expect(await screen.findByText(/^Regra ativada\./)).toBeTruthy();
    undoOnce(workspace);
    expect(rules.rules(ledger).get(rule.id)!.active).toBe(false);
    undoOnce(workspace);
    expect(rules.rules(ledger).get(rule.id)!.active).toBe(true);
  });

  it("asks to choose a rule instead of opening a dialog when none is selected", async () => {
    const { user } = await openRules();
    await user.click(screen.getByRole("button", { name: "Editar…" }));
    expect(await screen.findByText("Escolha uma regra.")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Ativar ou desativar…" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("warns when the family keeps choosing another category for a rule", async () => {
    const { ledger, workspace, user } = await openContas();
    // "padaria" → Alimentação is the rule; three operations with that word were categorized as Lazer
    learnFrom(ledger, workspace, "Padaria da esquina", "Lazer");
    expect(learning.contradictions(ledger).size).toBe(1);
    await goTab(user, "Regras");
    const text = flat(rowOf(await table("Regras de categoria"), "PADARIA").textContent);
    expect(text).toMatch(/Ativa · contrariada 3 de \d+ vezes \(vocês escolhem Lazer\)/);
  });

  it("offers the descriptions categorized the same way several times as rules; creating one is the user's choice", async () => {
    const { ledger, workspace, user } = await openContas();
    learnFrom(ledger, workspace, "Farmácia Saúde Viva", "Saúde");
    const proposal = learning.proposals(ledger).find((p) => p.pattern === "FARMACIA SAUDE VIVA")!;
    expect(proposal.count).toBe(3);
    await goTab(user, "Regras");
    const grid = await screen.findByRole("grid", { name: "Regras sugeridas pelo uso" });
    expect(screen.getByRole("heading", { name: "Sugeridas pelo uso" })).toBeTruthy();
    const text = flat(rowOf(grid, "FARMACIA SAUDE VIVA").textContent);
    expect(text).toContain("Saúde");
    expect(text).toContain("3");
    // nothing chosen: guidance
    await user.click(screen.getByRole("button", { name: "Criar regra…" }));
    expect(await screen.findByText("Escolha uma das regras sugeridas.")).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
    const before = patterns(ledger);
    await pick(user, grid, "FARMACIA SAUDE VIVA");
    await user.click(screen.getByRole("button", { name: "Criar regra…" }));
    const box = await dialog("Regra de categoria");
    // pattern and category come filled in, still editable
    expect((within(box).getByLabelText(/^A descrição contém/) as HTMLInputElement).value).toBe(proposal.pattern);
    expect(within(box).getByRole("combobox", { name: "Categoria" }).textContent).toContain("Saúde");
    await submit(user, box, "Criar regra");
    await closed("Regra de categoria");
    expect(await screen.findByText(new RegExp(`^Regra “${proposal.pattern}” criada\\.`))).toBeTruthy();
    expect(
      rulesOf(ledger).some((r) => r.pattern === proposal.pattern && r.target_account_id === proposal.category_id),
    ).toBe(true);
    // a rule now says so: the proposal is gone
    await waitFor(() => {
      const left = screen.queryByRole("grid", { name: "Regras sugeridas pelo uso" });
      expect(left === null || !flat(left.textContent).includes("FARMACIA SAUDE VIVA")).toBe(true);
    });
    undoOnce(workspace);
    expect(patterns(ledger)).toBe(before);
    // double click on a proposal opens the same dialog
    const again = await screen.findByRole("grid", { name: "Regras sugeridas pelo uso" });
    await user.dblClick(rowOf(again, "FARMACIA SAUDE VIVA"));
    expect(await dialog("Regra de categoria")).toBeTruthy();
  });
});

// ── links into the page ──────────────────────────

const cardOf = (ledger: Ledger) => [...ledger.cards.values()][0]!;
const selectedRow = (grid: HTMLElement) =>
  within(grid)
    .getAllByRole("row")
    .find((row) => row.getAttribute("aria-selected") === "true");
const monthKey = (month: { year: number; month: number }) => `${month.year}-${String(month.month).padStart(2, "0")}`;

type Router = Awaited<ReturnType<typeof openContas>>["router"];
/** Follows a link the way another page does: navigating to this one with `ref` and `act`. */
const follow = (router: Router, ref: string, act?: string) =>
  reactAct(() => router.navigate({ to: "/contas", search: { ref, ...(act ? { act } : {}) } as never }));
const tabSelected = (name: string) =>
  waitFor(() => expect(screen.getByRole("tab", { name }).getAttribute("aria-selected")).toBe("true"));

describe("Links into Contas e cartões", () => {
  it("a bill with the action 'pagar' opens Faturas on that bill and its payment, and the link is consumed", async () => {
    const { ledger, workspace, router } = await openContas();
    const card = cardOf(ledger);
    const today = workspace.today();
    const bill = dom.cards
      .bills(
        ledger,
        card.id,
        [-3, -2, -1].map((i) => ({ year: ymOf(today).year, month: ymOf(today).month + i })),
      )
      .find((b) => b.remaining.isPositive())!;
    await follow(router, `${card.id}:${monthKey(bill.cycle.month)}`, "pagar");
    expect(await dialog("Pagar fatura — Cartão X")).toBeTruthy();
    await tabSelected("Faturas");
    expect(flat(screen.getByRole("dialog").textContent)).toContain(`Vencimento ${formatDateBr(bill.cycle.due)}`);
    await waitFor(() => expect(router.state.location.search).toEqual({}));
    // the bill is selected behind the dialog
    expect(selectedRow(await table("Faturas do cartão"))!.getAttribute("data-row-id")).toBe(monthKey(bill.cycle.month));
  });

  it("a bill without the action only opens Faturas with the bill selected", async () => {
    const { ledger, workspace, router } = await openContas();
    const card = cardOf(ledger);
    const here = ymOf(workspace.today());
    const bill = dom.cards
      .bills(ledger, card.id, [{ year: here.year, month: here.month - 3 }])
      .find((b) => !b.total.isZero())!;
    await follow(router, `${card.id}:${monthKey(bill.cycle.month)}`);
    await tabSelected("Faturas");
    const grid = await table("Faturas do cartão");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(selectedRow(grid)!.getAttribute("data-row-id")).toBe(monthKey(bill.cycle.month));
    await waitFor(() => expect(router.state.location.search).toEqual({}));
  });

  it("a bill that is already paid says so instead of opening the payment", async () => {
    const { ledger, workspace, router } = await openContas();
    const card = cardOf(ledger);
    const today = workspace.today();
    const owed = dom.cards
      .bills(
        ledger,
        card.id,
        Array.from({ length: 36 }, (_, i) => ({ year: 2024 + Math.floor(i / 12), month: (i % 12) + 1 })),
      )
      .reduce((sum, b) => sum.add(b.remaining), Dec.from(0));
    workspace.act((l) => l.recordCardPayment(card.id, card.settlement_account_id!, owed, today));
    const paid = dom.cards.bills(ledger, card.id, [{ year: 2026, month: 4 }]).find((b) => b.status(today) === "paid")!;
    await follow(router, `${card.id}:${monthKey(paid.cycle.month)}`, "pagar");
    expect(await screen.findByText("Esta fatura já está paga.")).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("an installment with the action 'pagar' opens Financiamentos on it and its payment", async () => {
    const { ledger, router } = await openContas();
    const plan = [...dom.loans.plans(ledger).values()][0]!;
    await follow(router, `loan:${plan.id}:4`, "pagar");
    expect(await dialog(`Pagar parcela 4 — ${plan.name}`)).toBeTruthy();
    await tabSelected("Financiamentos");
    const grid = await screen.findByRole("grid", { name: "Cronograma de parcelas" });
    expect(selectedRow(grid)!.getAttribute("data-row-id")).toBe("4");
  });

  it("an installment already paid says so instead of opening the payment", async () => {
    const { ledger, router } = await openContas();
    const plan = [...dom.loans.plans(ledger).values()][0]!;
    await follow(router, `loan:${plan.id}:1`, "pagar");
    expect(await screen.findByText("Esta parcela já está paga.")).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
    const grid = await screen.findByRole("grid", { name: "Cronograma de parcelas" });
    expect(selectedRow(grid)!.getAttribute("data-row-id")).toBe("1");
  });

  it("a balance that differs from the bank opens Todas as contas on that account with its checks", async () => {
    const { ledger, router } = await openContas();
    const divergent = dom.balanceChecks.divergent(ledger).at(-1)!;
    const id = divergent.check.account_id;
    await follow(router, `check:${id}`);
    await tabSelected("Todas as contas");
    const grid = await table("Contas");
    expect(selectedRow(grid)!.getAttribute("data-row-id")).toBe(id);
    expect(screen.getByRole("heading", { name: `Saldo: ${ledger.account(id).name}` })).toBeTruthy();
    const checks = await screen.findByRole("grid", { name: "Conferências com o banco" });
    expect(flat(checks.textContent)).toContain(dom.balanceChecks.results(ledger, id)[0]!.check.note ?? "");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("'conta:' selects the account and 'cartao:' the card, each in its own tab", async () => {
    const { ledger, router } = await openContas();
    const account = [...ledger.accounts.values()].find((a) => a.name === "Conjunta")!;
    await follow(router, `conta:${account.id}`);
    await tabSelected("Todas as contas");
    expect(selectedRow(await table("Contas"))!.getAttribute("data-row-id")).toBe(account.id);
    await follow(router, `cartao:${cardOf(ledger).id}`);
    await tabSelected("Cartões");
    expect(selectedRow(await table("Cartões"))!.getAttribute("data-row-id")).toBe(cardOf(ledger).id);
  });

  it("a bank account by 'banco:' and a bare card id reach their tabs; an unknown reference is ignored", async () => {
    const { ledger, router } = await openContas();
    const bank = [...dom.banking.bankAccounts(ledger).values()].find((b) => b.name === "Nubank do Bruno")!;
    await follow(router, `banco:${bank.id}`);
    await tabSelected("Contas bancárias");
    expect(selectedRow(await table("Contas bancárias"))!.getAttribute("data-row-id")).toBe(bank.id);
    await follow(router, cardOf(ledger).id);
    await tabSelected("Faturas");
    expect(await table("Faturas do cartão")).toBeTruthy();
    await follow(router, "nao-existe:2026-13", "pagar");
    await waitFor(() => expect(router.state.location.search).toEqual({}));
    expect(screen.getByRole("tab", { name: "Faturas" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("every calendar entry and notice that targets this page lands on its object (the real links)", async () => {
    const { ledger, workspace, router, user } = await openContas();
    const today = workspace.today();
    const events = dom.agenda
      .monthEvents(ledger, ymOf(today), today)
      .filter((e) => e.target === "accounts" && e.state !== dom.agenda.EventState.DONE);
    const links = events.map(eventLink);
    for (const alert of [
      ...dom.alerts.cardAlerts(ledger, today),
      ...dom.alerts.loanAlerts(ledger, today),
      ...dom.alerts.balanceCheckAlerts(ledger),
    ]) {
      links.push(alertLink(alert));
    }
    const unique = [...new Map(links.map((l) => [`${l.ref}|${l.act}`, l])).values()];
    expect(unique.length).toBeGreaterThan(0);
    const kinds = new Set<string>();
    for (const link of unique) {
      expect(link.page).toBe("contas");
      const tab = link.ref!.startsWith("loan:")
        ? "Financiamentos"
        : link.ref!.startsWith("check:")
          ? "Todas as contas"
          : "Faturas";
      kinds.add(tab);
      await follow(router, link.ref!, link.act);
      await tabSelected(tab);
      if (link.act === "pagar") {
        // the payment opens, or a notice says the bill or installment is already paid
        await waitFor(() =>
          expect(
            screen.queryByRole("dialog") !== null || screen.queryAllByText(/já está paga/).length > 0,
            link.ref,
          ).toBe(true),
        );
      } else {
        expect(screen.queryByRole("dialog"), link.ref).toBeNull();
      }
      if (screen.queryByRole("dialog")) {
        await user.keyboard("{Escape}");
        await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      }
    }
    // the demonstration has installments and a balance to confer among its notices and entries
    expect(kinds.has("Financiamentos")).toBe(true);
    expect(kinds.has("Todas as contas")).toBe(true);
  });
});

export type { Id };
