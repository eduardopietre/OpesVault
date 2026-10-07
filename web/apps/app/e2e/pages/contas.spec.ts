/**
 * Contas e cartões end to end (docs/18 §5, SCREENS.md): the demonstration project, every tab, every button and
 * menu item, every dialog submitted (with its refusals), links in and out, no console errors, no sideways
 * scroll at the five sizes, axe clean, light and dark.
 */
import AxeBuilder from "@axe-core/playwright";
import { animationsDone } from "../helpers.ts";
import { expect, test, type Locator, type Page } from "@playwright/test";
import {
  TEST_SCHEMES,
  TEST_SIZES,
  expectNoHorizontalOverflow,
  openDemo,
  recordAddresses,
  settle,
  watchErrors,
} from "../helpers.ts";

/** A required field's label ends with "*". */
const NAME = /^Nome\s*\*?$/;

async function audit(page: Page, label: string) {
  await page.mouse.move(1, 1); // a hovered button is another color: audit the resting state
  await settle(page, 250);
  await animationsDone(page);
  const result = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    .analyze();
  expect(
    result.violations.map(
      (violation) =>
        `${label}: ${violation.id} (${violation.impact}) ${violation.nodes
          .map((node) => `${node.target.join(" ")} ${node.failureSummary ?? ""}`)
          .slice(0, 3)
          .join(", ")}`,
    ),
  ).toEqual([]);
}

/** A tab of the page's own list (the shell has other tabs and navigation). */
const goTab = async (page: Page, name: string) => {
  await page.getByRole("tab", { name, exact: true }).click();
  await expect(page.getByRole("tab", { name, exact: true })).toHaveAttribute("aria-selected", "true");
  await settle(page, 200);
};

/** A table: a grid, or a list of cards on a phone. */
const tableOf = (page: Page, name: string, phone: boolean): Locator =>
  page.getByRole(phone ? "listbox" : "grid", { name, exact: true });

/** The open dialog by its name; checks it fits and is accessible. */
async function openDialog(page: Page, name: string | RegExp, label: string): Promise<Locator> {
  const dialog = page.getByRole("dialog", { name });
  await expect(dialog).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await audit(page, label);
  return dialog;
}

const submit = async (dialog: Locator, name: string) => dialog.getByRole("button", { name, exact: true }).click();

/** Types into a combobox that searches (a bank, an IRPF type) and picks the option. */
async function searchAndPick(page: Page, dialog: Locator, label: string, typed: string, option: RegExp) {
  const field = dialog.getByRole("combobox", { name: label, exact: true });
  await field.click();
  await field.fill(typed);
  await page.getByRole("listbox", { name: label, exact: true }).getByRole("option", { name: option }).first().click();
}

/** Chooses an option of a select. */
async function choose(page: Page, dialog: Locator, label: string, option: string | RegExp) {
  await dialog.getByRole("combobox", { name: label, exact: true }).click();
  await page.getByRole("listbox", { name: label, exact: true }).getByRole("option", { name: option }).first().click();
}

for (const size of TEST_SIZES) {
  for (const scheme of TEST_SCHEMES) {
    test.describe(`${size.width}x${size.height} ${scheme}`, () => {
      test.use({ viewport: size, colorScheme: scheme, contextOptions: { reducedMotion: "reduce" } });
      const phone = size.width < 640;

      test("contas bancárias: create, edit, values, investment, characteristics, close", async ({ page }) => {
        const errors = watchErrors(page);
        await openDemo(page, "/contas");
        await expect(page.getByRole("heading", { level: 1, name: "Contas e cartões" })).toBeVisible();
        const banks = tableOf(page, "Contas bancárias", phone);
        await expect(banks).toBeVisible();
        await expect(banks.getByText("Itaú da Ana")).toBeVisible();
        await expect(page.getByRole("heading", { name: "Composição" })).toBeVisible();
        await settle(page);
        await expectNoHorizontalOverflow(page);
        await audit(page, "contas bancárias");

        // Nova conta bancária…: the refusals, then a joint account with both parts
        await page.getByRole("button", { name: "Nova conta bancária…" }).click();
        let dialog = await openDialog(page, "Nova conta bancária", "nova conta bancária");
        await submit(dialog, "Salvar");
        await expect(dialog.getByText("Escolha o banco na lista ou Outra instituição.")).toBeVisible();
        await audit(page, "nova conta bancária com erro");
        await dialog.getByLabel("Nome da conta").fill("Conta conjunta nova");
        await searchAndPick(page, dialog, "Banco", "260", /^260/);
        await dialog.getByLabel("Agência").fill("0002");
        await dialog.getByLabel("Número da conta").fill("55555-5");
        await dialog.getByRole("checkbox", { name: "Conta conjunta" }).click();
        await choose(page, dialog, "Segundo titular", "Bruno");
        await dialog.getByRole("checkbox", { name: "Incluir conta corrente" }).click();
        await dialog.getByRole("checkbox", { name: "Incluir poupança" }).click();
        await dialog.getByLabel("Conta corrente: saldo inicial").fill("1.000,00");
        await dialog.getByLabel("Poupança: saldo inicial").fill("250,50");
        await submit(dialog, "Salvar");
        await expect(dialog).toBeHidden();
        await expect(banks.getByText("Conta conjunta nova")).toBeVisible();

        // Editar…
        await banks.getByText("Conta conjunta nova").click();
        await page.getByRole("button", { name: "Editar…" }).click();
        dialog = await openDialog(page, "Editar conta bancária", "editar conta bancária");
        await dialog.getByLabel("Nome da conta").fill("Nubank conjunta");
        await submit(dialog, "Salvar");
        await expect(dialog).toBeHidden();
        await expect(banks.getByText("Nubank conjunta")).toBeVisible();

        // Valores em uma data…: the refusal, then a value
        await page.getByRole("button", { name: "Valores em uma data…" }).click();
        dialog = await openDialog(page, /Valores em uma data — Nubank conjunta/, "valores em uma data");
        await submit(dialog, "Registrar valores");
        await expect(dialog.getByText("Informe ao menos um valor.")).toBeVisible();
        await dialog.getByLabel("Valor no banco: Conta corrente").fill("1.000,00");
        await submit(dialog, "Registrar valores");
        await expect(dialog).toBeHidden();
        await expect(page.getByText("Valores registrados.").first()).toBeVisible();

        // Novo investimento…: refusals, then one held at this account
        await page.getByRole("button", { name: "Novo investimento…" }).click();
        dialog = await openDialog(page, "Novo investimento", "novo investimento");
        await submit(dialog, "Salvar");
        await expect(dialog.getByText("Informe o nome do investimento.")).toBeVisible();
        await dialog.getByLabel(/^Nome do investimento\s*\*?$/).fill("CDB teste 2027");
        await dialog.getByLabel("Valor aplicado").fill("500,00");
        await searchAndPick(page, dialog, "Tipo do investimento (IRPF)", "04.02", /^04\.02/);
        await choose(page, dialog, "Indexador", "CDI");
        await dialog.getByLabel("Taxa (%)").fill("105");
        await expectNoHorizontalOverflow(page);
        await submit(dialog, "Salvar");
        await expect(dialog).toBeHidden();
        const parts = tableOf(page, "Composição da conta bancária", phone);
        await expect(parts.getByText("CDB teste 2027")).toBeVisible();

        // Características…: a part that is not an investment explains; an investment opens
        await parts.getByText("Conta corrente").first().click();
        await page.getByRole("button", { name: "Características…" }).click();
        await expect(page.getByText("Escolha um investimento na composição.").first()).toBeVisible();
        await parts.getByText("CDB teste 2027").click();
        await page.getByRole("button", { name: "Características…" }).click();
        dialog = await openDialog(page, "Características do investimento", "características do investimento");
        await dialog.getByLabel(/^Emissor$/).fill("Nu Pagamentos");
        await dialog.getByLabel("CNPJ do emissor").fill("11.111.111/1111-11");
        await submit(dialog, "Salvar");
        await expect(dialog.getByText("CNPJ inválido: confira os dígitos.")).toBeVisible();
        await audit(page, "características com erro");
        await dialog.getByLabel("CNPJ do emissor").fill("");
        await submit(dialog, "Salvar");
        await expect(dialog).toBeHidden();

        // Mais → Encerrar conta bancária…: cancel, then confirm and undo from the notice
        await page.getByRole("button", { name: "Mais", exact: true }).click();
        await page.getByRole("menuitem", { name: "Encerrar conta bancária…" }).click();
        const ask = page.getByRole("alertdialog", { name: "Encerrar esta conta bancária?" });
        await expect(ask).toBeVisible();
        await audit(page, "encerrar conta bancária");
        await ask.getByRole("button", { name: "Cancelar" }).click();
        await expect(banks.getByText("Nubank conjunta")).toBeVisible();
        await page.getByRole("button", { name: "Mais", exact: true }).click();
        await page.getByRole("menuitem", { name: "Encerrar conta bancária…" }).click();
        await ask.getByRole("button", { name: "Encerrar" }).click();
        await expect(banks.getByText("Nubank conjunta")).toHaveCount(0);
        await page.getByRole("button", { name: "Desfazer", exact: true }).click();
        await expect(banks.getByText("Nubank conjunta")).toBeVisible();

        // every collapsible section opens and closes
        const toggles = page.locator("main button[aria-expanded]");
        for (let index = 0; index < (await toggles.count()); index++) {
          await toggles.nth(index).click();
          await toggles.nth(index).click();
        }
        await expectNoHorizontalOverflow(page);
        await audit(page, "contas bancárias depois de usar");
        expect(errors).toEqual([]);
      });

      test("todas as contas, cartões e categorias: every command and dialog", async ({ page }) => {
        const errors = watchErrors(page);
        const addresses = await recordAddresses(page);
        await openDemo(page, "/contas");
        await goTab(page, "Todas as contas");
        const accounts = tableOf(page, "Contas", phone);
        await expect(accounts).toBeVisible();
        await expect(page.getByRole("heading", { name: /^Saldo: / })).toBeVisible();
        // the chart draws (lazy chunk) and the table of its values sits with it
        await expect(page.locator("canvas").first()).toBeVisible();
        await expect(page.getByText("Não foi possível desenhar o gráfico")).toHaveCount(0);
        await expect(page.getByRole("table", { name: /^Valores de Saldo: / })).toBeVisible();
        await settle(page);
        await expectNoHorizontalOverflow(page);
        await audit(page, "todas as contas");

        // Nova conta…: refusals, then an account with an opening balance
        await page.getByRole("button", { name: "Nova conta…" }).click();
        let dialog = await openDialog(page, "Nova conta", "nova conta");
        await submit(dialog, "Salvar conta");
        await expect(dialog.getByText("Informe o nome da conta.")).toBeVisible();
        await dialog.getByLabel(NAME).fill("Caixinha");
        await choose(page, dialog, "Tipo", "Dinheiro");
        await choose(page, dialog, "Segundo titular", "Bruno");
        await submit(dialog, "Salvar conta");
        await expect(dialog.getByText("Escolha o titular antes do segundo titular.")).toBeVisible();
        await choose(page, dialog, "Titular", "Ana");
        await dialog.getByLabel("Saldo de abertura").fill("150,25");
        await submit(dialog, "Salvar conta");
        await expect(dialog).toBeHidden();
        await expect(accounts.getByText("Caixinha")).toBeVisible();

        // Editar…
        await page.getByRole("button", { name: "Editar…" }).click();
        dialog = await openDialog(page, "Editar conta", "editar conta");
        await dialog.getByLabel("Identificação").fill("carteira");
        await submit(dialog, "Salvar conta");
        await expect(dialog).toBeHidden();

        // Conferir saldo…: refusal, then a balance that matches
        await page.getByRole("button", { name: "Conferir saldo…" }).click();
        dialog = await openDialog(page, /Conferir saldo — Caixinha/, "conferir saldo");
        await submit(dialog, "Conferir");
        await expect(dialog.getByText("Informe o valor.")).toBeVisible();
        await dialog.getByLabel("Saldo no banco", { exact: true }).fill("150,25");
        await submit(dialog, "Conferir");
        await expect(dialog).toBeHidden();
        await expect(page.getByText("Saldo conferido: confere com o banco.").first()).toBeVisible();
        await expect(tableOf(page, "Conferências com o banco", phone)).toBeVisible();
        await audit(page, "conferências");

        // Ver lançamentos goes to the ledger with the account, and back
        await page.getByRole("button", { name: "Ver lançamentos" }).click();
        await expect.poll(async () => (await addresses()).some((u) => /\/livro\?.*ref=conta/.test(u))).toBe(true);
        await expect(page.getByRole("heading", { level: 1, name: "Livro financeiro" })).toBeVisible();
        await page.goBack();
        await expect(page.getByRole("heading", { level: 1, name: "Contas e cartões" })).toBeVisible();

        // Cartões
        await goTab(page, "Cartões");
        const cards = tableOf(page, "Cartões", phone);
        await expect(cards.getByText("Cartão X")).toBeVisible();
        await expectNoHorizontalOverflow(page);
        await audit(page, "cartões");
        await page.getByRole("button", { name: "Editar…" }).click();
        await expect(page.getByText("Selecione um cartão.").first()).toBeVisible();
        await page.getByRole("button", { name: "Novo cartão…" }).click();
        dialog = await openDialog(page, "Novo cartão de crédito", "novo cartão");
        await submit(dialog, "Salvar cartão");
        await expect(dialog.getByText("Informe o nome do cartão.")).toBeVisible();
        await dialog.getByLabel(NAME).fill("Cartão Y");
        await dialog.getByLabel("Final").fill("4321");
        await dialog.getByLabel("Dia de fechamento").fill("20");
        await dialog.getByLabel("Dia de vencimento").fill("27");
        await choose(page, dialog, "Conta de pagamento", "Banco A");
        await submit(dialog, "Salvar cartão");
        await expect(dialog).toBeHidden();
        await expect(cards.getByText("Cartão Y")).toBeVisible();
        await cards.getByText("Cartão Y").click();
        await page.getByRole("button", { name: "Editar…" }).click();
        dialog = await openDialog(page, "Editar cartão de crédito", "editar cartão");
        await dialog.getByLabel("Dia de fechamento").fill("12");
        await submit(dialog, "Salvar cartão");
        await expect(dialog).toBeHidden();
        await page.getByRole("button", { name: "Ver lançamentos" }).click();
        await expect.poll(async () => (await addresses()).filter((u) => /\/livro\?.*ref=conta/.test(u)).length).toBe(2);
        await page.goBack();
        await expect(page.getByRole("heading", { level: 1, name: "Contas e cartões" })).toBeVisible();

        // Categorias
        await goTab(page, "Categorias");
        const categories = tableOf(page, "Categorias", phone);
        await expect(categories.getByText("Saúde").first()).toBeVisible();
        await expectNoHorizontalOverflow(page);
        await audit(page, "categorias");
        await page.getByRole("button", { name: "Dedutível no IR…" }).click();
        await expect(page.getByText("Selecione uma categoria.").first()).toBeVisible();
        await page.getByRole("button", { name: "Nova categoria…" }).click();
        dialog = await openDialog(page, "Nova categoria", "nova categoria");
        await submit(dialog, "Criar categoria");
        await expect(dialog.getByText("Informe o nome.")).toBeVisible();
        await dialog.getByLabel(NAME).fill("Restaurantes");
        await choose(page, dialog, "Dentro de", "Alimentação");
        await submit(dialog, "Criar categoria");
        await expect(dialog).toBeHidden();
        await expect(categories.getByText("Restaurantes")).toBeVisible();
        await categories.getByText("Restaurantes").click();
        await page.getByRole("button", { name: "Dedutível no IR…" }).click();
        dialog = await openDialog(page, /Despesa dedutível — Restaurantes/, "dedutível");
        await choose(page, dialog, "Tipo de dedução", /Saúde|Educação/);
        await submit(dialog, "Salvar");
        await expect(dialog).toBeHidden();
        await expect(page.getByText("Categoria marcada como dedutível.").first()).toBeVisible();
        await expectNoHorizontalOverflow(page);
        expect(errors).toEqual([]);
      });

      test("faturas e financiamentos: pay, simulate, create", async ({ page }) => {
        const errors = watchErrors(page);
        const addresses = await recordAddresses(page);
        await openDemo(page, "/contas");
        await goTab(page, "Faturas");
        const bills = tableOf(page, "Faturas do cartão", phone);
        await expect(bills).toBeVisible();
        await expect(page.getByText("Vencida").first()).toBeVisible();
        await expect(page.locator("canvas").first()).toBeVisible();
        await expect(page.getByText("Não foi possível desenhar o gráfico")).toHaveCount(0);
        await settle(page);
        await expectNoHorizontalOverflow(page);
        await audit(page, "faturas");

        // Pagar… on the selected bill: refusals, then pay
        await page.getByRole("button", { name: "Pagar…" }).click();
        let dialog = await openDialog(page, "Pagar fatura — Cartão X", "pagar fatura");
        await expect(
          dialog.getByText("Pagamento após o vencimento: quita primeiro esta fatura vencida."),
        ).toBeVisible();
        await dialog.getByLabel("Valor", { exact: true }).fill("0,00");
        await submit(dialog, "Registrar pagamento");
        await expect(dialog.getByText("Informe um valor positivo.")).toBeVisible();
        await audit(page, "pagar fatura com erro");
        await dialog.getByLabel("Valor", { exact: true }).fill("100,00");
        await submit(dialog, "Registrar pagamento");
        await expect(dialog).toBeHidden();
        await expect(page.getByText("Pagamento da fatura de Cartão X registrado.").first()).toBeVisible();
        // a double click on a bill opens its payment too
        await bills
          .getByText(/\d\d\/\d\d\/\d{4}/)
          .first()
          .dblclick();
        const again = page.getByRole("dialog", { name: "Pagar fatura — Cartão X" });
        await expect(again).toBeVisible();
        await again.getByRole("button", { name: "Cancelar" }).click();
        await expect(again).toBeHidden();
        // the card selector
        await page.getByRole("combobox", { name: "Cartão", exact: true }).click();
        await page.getByRole("option", { name: "Cartão X" }).click();

        // Financiamentos
        await goTab(page, "Financiamentos");
        const loans = tableOf(page, "Financiamentos", phone);
        await expect(loans.getByText("Financiamento do carro")).toBeVisible();
        await expect(page.locator("canvas").first()).toBeVisible();
        await expect(page.getByText("Não foi possível desenhar o gráfico")).toHaveCount(0);
        await settle(page);
        await expectNoHorizontalOverflow(page);
        await audit(page, "financiamentos");

        // Pagar parcela…: below the installment is refused; the installment itself is paid
        await page.getByRole("button", { name: "Pagar parcela…" }).click();
        dialog = await openDialog(page, /Pagar parcela 3/, "pagar parcela");
        await dialog.getByLabel("Valor pago").fill("1.000,00");
        await submit(dialog, "Registrar pagamento");
        await expect(dialog.getByText("O valor não pode ser menor que a parcela.")).toBeVisible();
        await dialog.getByLabel("Valor pago").fill("1.371,50");
        await submit(dialog, "Registrar pagamento");
        await expect(dialog).toBeHidden();
        await expect(
          page.getByText("Parcela 3 registrada: amortização, juros e encargos separados.").first(),
        ).toBeVisible();

        // Mais → amortização antecipada: the simulation answers while typing; then it is registered
        await page.getByRole("button", { name: "Mais", exact: true }).click();
        await page.getByRole("menuitem", { name: "Simular ou registrar amortização antecipada…" }).click();
        dialog = await openDialog(page, /Amortização antecipada/, "amortização antecipada");
        await submit(dialog, "Registrar amortização");
        await expect(dialog.getByText("Informe um valor positivo.")).toBeVisible();
        await dialog.getByLabel("Valor da amortização").fill("10.000,00");
        await expect(dialog.getByRole("status", { name: "Resultado da simulação" })).toContainText("economia");
        await choose(page, dialog, "Efeito", "Reduzir a parcela");
        await expect(dialog.getByRole("status", { name: "Resultado da simulação" })).toContainText("Próxima parcela");
        await audit(page, "amortização com simulação");
        await submit(dialog, "Registrar amortização");
        await expect(dialog).toBeHidden();
        await expect(
          page.getByText("Amortização antecipada registrada; o cronograma foi recalculado.").first(),
        ).toBeVisible();

        // Mais → Ver lançamentos do financiamento, and back
        await page.getByRole("button", { name: "Mais", exact: true }).click();
        await page.getByRole("menuitem", { name: "Ver lançamentos do financiamento" }).click();
        await expect.poll(async () => (await addresses()).some((u) => /\/livro\?.*ref=conta/.test(u))).toBe(true);
        await page.goBack();
        await expect(page.getByRole("heading", { level: 1, name: "Contas e cartões" })).toBeVisible();
        await goTab(page, "Financiamentos");

        // Novo financiamento…: refusals, then a contract
        await page.getByRole("button", { name: "Novo financiamento…" }).click();
        dialog = await openDialog(page, "Novo financiamento", "novo financiamento");
        await submit(dialog, "Criar financiamento");
        await expect(dialog.getByText("Informe o nome do financiamento.")).toBeVisible();
        await dialog.getByLabel(NAME).fill("Apartamento");
        await dialog.getByLabel("Saldo devedor").fill("120.000,00");
        await dialog.getByLabel("Parcelas restantes").fill("120");
        await dialog.getByLabel("Taxa de juros (%)").fill("0,80");
        await choose(page, dialog, "Sistema de amortização", /SAC/);
        await dialog.getByLabel("Vencimento da próxima parcela").fill("10/11/2026");
        await submit(dialog, "Criar financiamento");
        await expect(dialog).toBeHidden();
        await expect(loans.getByText("Apartamento")).toBeVisible();
        await expect(
          page.getByText("Financiamento criado. O cronograma foi calculado pelo contrato.").first(),
        ).toBeVisible();
        await expectNoHorizontalOverflow(page);
        await audit(page, "depois de criar o financiamento");

        // every collapsible section opens and closes
        const toggles = page.locator("main button[aria-expanded]");
        for (let index = 0; index < (await toggles.count()); index++) {
          await toggles.nth(index).click();
          await toggles.nth(index).click();
        }
        expect(errors).toEqual([]);
      });

      test("regras e integrantes: rules, proposals, members", async ({ page }) => {
        const errors = watchErrors(page);
        await openDemo(page, "/contas");
        await goTab(page, "Regras");
        const rules = tableOf(page, "Regras de categoria", phone);
        await expect(rules.getByText("PADARIA")).toBeVisible();
        await expect(page.getByRole("heading", { name: "Sugeridas pelo uso" })).toBeVisible();
        await expectNoHorizontalOverflow(page);
        await audit(page, "regras");

        // Editar… and Ativar… need a selected rule
        await page.getByRole("button", { name: "Editar…" }).click();
        await expect(page.getByText("Escolha uma regra.").first()).toBeVisible();

        // Nova regra…: preview, refusals, then a rule
        await page.getByRole("button", { name: "Nova regra…" }).click();
        let dialog = await openDialog(page, "Regra de categoria", "nova regra");
        await expect(dialog.getByRole("status")).toContainText("Digite ao menos 3 caracteres.");
        await submit(dialog, "Criar regra");
        await expect(dialog.getByText("Escolha a categoria.")).toBeVisible();
        await dialog.getByLabel(/^A descrição contém\s*\*?$/).fill("Cinema Central");
        await choose(page, dialog, "Categoria", "Despesa: Lazer");
        await expect(dialog.getByRole("status")).toContainText("item(ns) pendente(s) agora.");
        await submit(dialog, "Criar regra");
        await expect(dialog).toBeHidden();
        await expect(rules.getByText("CINEMA CENTRAL")).toBeVisible();

        // Editar… (the reason is required)
        await rules.getByText("CINEMA CENTRAL").click();
        await page.getByRole("button", { name: "Editar…" }).click();
        dialog = await openDialog(page, "Regra de categoria", "editar regra");
        await submit(dialog, "Salvar regra");
        await expect(dialog.getByText("Informe o motivo da alteração.")).toBeVisible();
        await dialog.getByLabel("Motivo da alteração").fill("renomeada");
        await submit(dialog, "Salvar regra");
        await expect(dialog).toBeHidden();

        // Ativar ou desativar…
        await page.getByRole("button", { name: "Ativar ou desativar…" }).click();
        dialog = await openDialog(page, "Desativar regra", "desativar regra");
        await submit(dialog, "Desativar");
        await expect(dialog.getByText("O motivo é obrigatório.")).toBeVisible();
        await dialog.getByLabel(/^Motivo\s*\*?$/).fill("não vale mais");
        await submit(dialog, "Desativar");
        await expect(dialog).toBeHidden();
        await expect(rules.getByText("Desativada")).toBeVisible();

        // Criar regra… from a proposal
        await page.getByRole("button", { name: "Criar regra…" }).click();
        await expect(page.getByText("Escolha uma das regras sugeridas.").first()).toBeVisible();
        const proposals = tableOf(page, "Regras sugeridas pelo uso", phone);
        await proposals.getByText("NETFLIX.COM").click();
        await page.getByRole("button", { name: "Criar regra…" }).click();
        dialog = await openDialog(page, "Regra de categoria", "regra sugerida");
        await expect(dialog.getByLabel(/^A descrição contém\s*\*?$/)).toHaveValue("NETFLIX.COM");
        await submit(dialog, "Criar regra");
        await expect(dialog).toBeHidden();
        await expect(rules.getByText("NETFLIX.COM")).toBeVisible();

        // Integrantes
        await goTab(page, "Integrantes");
        const members = tableOf(page, "Integrantes", phone);
        await expect(members.getByText("Ana")).toBeVisible();
        await expectNoHorizontalOverflow(page);
        await audit(page, "integrantes");
        await page.getByRole("button", { name: "Editar…" }).click();
        await expect(page.getByText("Selecione um integrante.").first()).toBeVisible();
        await page.getByRole("button", { name: "Novo integrante…" }).click();
        dialog = await openDialog(page, "Novo integrante", "novo integrante");
        await submit(dialog, "Adicionar");
        await expect(dialog.getByText("Informe o nome.")).toBeVisible();
        await dialog.getByLabel(NAME).fill("Carla");
        await choose(page, dialog, "Papel", "Dependente");
        await submit(dialog, "Adicionar");
        await expect(dialog).toBeHidden();
        await expect(members.getByText("Carla")).toBeVisible();
        await members.getByText("Carla").click();
        await page.getByRole("button", { name: "Editar…" }).click();
        dialog = await openDialog(page, "Editar integrante", "editar integrante");
        await dialog.getByRole("checkbox", { name: /Ativo/ }).click();
        await submit(dialog, "Salvar");
        await expect(dialog).toBeHidden();
        await expect(members.getByText("Inativo")).toBeVisible();
        await expectNoHorizontalOverflow(page);
        expect(errors).toEqual([]);
      });

      test("links: a bill and an installment from the calendar open ready to pay; a balance from the overview opens its account", async ({
        page,
      }) => {
        const errors = watchErrors(page);
        await openDemo(page, "/calendario");
        const pay = page.getByRole("button", { name: /^Pagar…: / });
        await expect(pay.first()).toBeVisible();
        const count = await pay.count();
        expect(count).toBeGreaterThan(0);
        for (let index = 0; index < count; index++) {
          await openDemo(page, "/calendario");
          await page
            .getByRole("button", { name: /^Pagar…: / })
            .nth(index)
            .click();
          await expect(page).toHaveURL(/\/contas/);
          // the payment of the bill or installment opens at once, on the right tab
          const dialog = page.getByRole("dialog", { name: /^Pagar (fatura|parcela)/ });
          await expect(dialog).toBeVisible();
          await expectNoHorizontalOverflow(page);
          if (index === 0) await audit(page, "pagar a partir do calendário");
          await dialog.getByRole("button", { name: "Cancelar" }).click();
          await expect(dialog).toBeHidden();
          await expect(page).not.toHaveURL(/act=/);
        }
        // a notice about a balance that differs from the bank opens that account's checks
        await openDemo(page, "/visao-geral");
        const check = page.getByRole("button", { name: /Ver conta/ }).first();
        if (await check.count()) {
          await check.click();
          await expect(page).toHaveURL(/\/contas/);
          await expect(page.getByRole("tab", { name: "Todas as contas", exact: true })).toHaveAttribute(
            "aria-selected",
            "true",
          );
          await expect(page.getByRole("heading", { name: /^Saldo: / })).toBeVisible();
          await expect(tableOf(page, "Conferências com o banco", phone)).toBeVisible();
          await expectNoHorizontalOverflow(page);
        }
        expect(errors).toEqual([]);
      });
    });
  }
}
