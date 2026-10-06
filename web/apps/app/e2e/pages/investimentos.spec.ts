/**
 * Investimentos end to end (docs/18 §5, SCREENS.md): the demonstration project, every button and menu item,
 * every dialog submitted (with its refusals), links in and out, the internal rate of return computed in its
 * worker under the production CSP, no console errors, no sideways scroll at the five sizes, axe clean, light
 * and dark.
 */
import { expect, test } from "@playwright/test";
import {
  SCHEMES,
  SIZES,
  expectNoHorizontalOverflow,
  openDemo,
  recordAddresses,
  settle,
  watchErrors,
} from "../helpers.ts";
import { audit, choose, field, menu, notice, openDialog, submit, tableOf } from "./investimentos_helpers.ts";

for (const size of SIZES) {
  for (const scheme of SCHEMES) {
    test.describe(`${size.width}x${size.height} ${scheme}`, () => {
      test.use({ viewport: size, colorScheme: scheme, contextOptions: { reducedMotion: "reduce" } });
      const phone = size.width < 640;

      test("carteira e detalhe: números, gráficos, rentabilidade calculada no worker", async ({ page }) => {
        const errors = watchErrors(page);
        await openDemo(page, "/investimentos");
        await expect(page.getByRole("heading", { level: 1, name: "Investimentos" })).toBeVisible();
        const portfolio = tableOf(page, "Investimentos", phone);
        await expect(portfolio).toBeVisible();
        await expect(portfolio.getByText("CDB Banco X 2028")).toBeVisible();
        await expect(page.getByRole("heading", { level: 2, name: "CDB Banco X 2028" })).toBeVisible();
        // the figures and the sections of the selected investment
        await expect(page.getByText("Custo remanescente").first()).toBeVisible();
        await expect(page.getByText("Vencimento").first()).toBeVisible();
        await expect(page.getByText(/110% do CDI/)).toBeVisible();
        await expect(page.getByRole("heading", { name: "Evolução do investimento" })).toBeVisible();
        await expect(page.getByRole("heading", { name: "Resultado acumulado do investimento" })).toBeVisible();
        await expect(tableOf(page, "Avaliações", phone)).toBeVisible();
        await expect(tableOf(page, "Movimentos", phone)).toBeVisible();
        // the returns: the quick methods at once, the rate of return after its worker answers
        const returns = tableOf(page, "Rentabilidade por método", phone);
        await expect(returns).toBeVisible();
        await expect(returns.getByText("calculando…")).toHaveCount(0, { timeout: 20_000 });
        await expect(returns.getByText(/XIRR/)).toBeVisible();
        // the slow half really ran in the worker (the page's CSP and Trusted Types let it start)
        expect(page.workers().some((worker) => /xirr\.worker/.test(worker.url()))).toBe(true);
        await expect(page.getByRole("heading", { name: /Rentabilidade \d\d\/\d\d\/\d{4} a/ })).toBeVisible();
        await expect(page.getByRole("heading", { name: "Notas de negociação" })).toBeVisible();
        await settle(page, 800);
        await expectNoHorizontalOverflow(page);
        await audit(page, "investimentos");
        expect(errors).toEqual([]);
      });

      test("avaliações: registrar, usar outra observação e corrigir", async ({ page }) => {
        const errors = watchErrors(page);
        await openDemo(page, "/investimentos");
        await expect(tableOf(page, "Avaliações", phone)).toBeVisible();
        // Registrar › Avaliação…: the refusal, then a value
        await menu(page, "Registrar", "Avaliação…");
        let dialog = await openDialog(page, /Nova avaliação — CDB Banco X 2028/, "nova avaliação");
        await submit(dialog, "Registrar");
        await expect(dialog.getByText("Informe o valor.")).toBeVisible();
        await field(dialog, "Data").fill("28/03/2026");
        await field(dialog, "Valor").fill("9.999,00");
        await expect(dialog.getByText(/Já existe avaliação desta fonte em 28\/03\/2026/)).toBeVisible();
        await submit(dialog, "Registrar");
        await expect(dialog.getByText(/use 'corrigir observação'/)).toBeVisible();
        await audit(page, "nova avaliação com erro");
        // another source on the same date is kept apart
        await field(dialog, "Fonte").fill("extrato do banco");
        await field(dialog, "Valor").fill("5.140,00");
        await submit(dialog, "Registrar");
        await expect(dialog).toBeHidden();
        const valuations = tableOf(page, "Avaliações", phone);
        await expect(valuations.getByText("extrato do banco")).toBeVisible();

        // Usar esta observação: asks to select first, then switches to the new one
        await page.getByRole("button", { name: "Usar esta observação" }).click();
        await expect(notice(page, "Selecione uma observação na tabela Avaliações.")).toBeVisible();
        await valuations.getByText("extrato do banco").click();
        await page.getByRole("button", { name: "Usar esta observação" }).click();
        await expect(notice(page, "Observação usada nos cálculos.")).toBeVisible();

        // Corrigir observação…
        await valuations.getByText("extrato do banco").click();
        await page.getByRole("button", { name: "Corrigir observação…" }).click();
        dialog = await openDialog(page, "Corrigir observação", "corrigir observação");
        await field(dialog, "Valor corrigido").fill("5.150,00");
        await submit(dialog, "Corrigir");
        await expect(dialog.getByText("Correções exigem motivo.")).toBeVisible();
        await field(dialog, "Motivo").fill("extrato conferido");
        await submit(dialog, "Corrigir");
        await expect(dialog).toBeHidden();
        await expect(valuations.getByText("R$ 5.150,00")).toBeVisible();
        await expectNoHorizontalOverflow(page);
        expect(errors).toEqual([]);
      });

      test("registrar: aporte, provento, resgates, completar e imposto", async ({ page }) => {
        const errors = watchErrors(page);
        await openDemo(page, "/investimentos");
        const movements = tableOf(page, "Movimentos", phone);
        await expect(movements).toBeVisible();

        await menu(page, "Registrar", "Aporte…");
        let dialog = await openDialog(page, /Aporte — CDB Banco X 2028/, "aporte");
        await submit(dialog, "Registrar");
        await expect(dialog.getByText("Informe o valor.")).toBeVisible();
        await field(dialog, "Valor").fill("100,00");
        await submit(dialog, "Registrar");
        await expect(dialog).toBeHidden();
        await expect(notice(page, "Aporte registrado.")).toBeVisible();
        await expect(movements.getByText("R$ 100,00").first()).toBeVisible();

        await menu(page, "Registrar", "Provento…");
        dialog = await openDialog(page, /Provento pago fora do investimento/, "provento");
        await field(dialog, "Valor bruto").fill("50,00");
        await field(dialog, "Imposto retido").fill("7,50");
        await submit(dialog, "Registrar");
        await expect(dialog).toBeHidden();
        await expect(movements.getByText("Provento").first()).toBeVisible();

        await menu(page, "Registrar", "Resgate…");
        dialog = await openDialog(page, /Resgate — CDB Banco X 2028/, "resgate");
        await field(dialog, "Valor bruto").fill("300,00");
        await field(dialog, "Imposto retido no ato").fill("3,00");
        await submit(dialog, "Registrar");
        await expect(dialog).toBeHidden();
        await expect(notice(page, "Resgate registrado.")).toBeVisible();
        await expect(movements.getByText("Resgate").first()).toBeVisible();

        // only the net known: incomplete, then completed from the selected row
        await menu(page, "Registrar", "Resgate só com o líquido…");
        dialog = await openDialog(page, /Resgate com deduções a discriminar/, "resgate só com o líquido");
        await field(dialog, "Líquido recebido").fill("200,00");
        await submit(dialog, "Registrar");
        await expect(dialog).toBeHidden();
        await expect(movements.getByText("a discriminar")).toBeVisible();
        await menu(page, "Registrar", "Completar resgate…");
        await expect(notice(page, "Selecione o resgate incompleto em Movimentos.")).toBeVisible();
        await movements.getByText("a discriminar").click();
        await page.getByRole("button", { name: "Completar resgate…" }).click();
        dialog = await openDialog(page, "Completar resgate", "completar resgate");
        await field(dialog, "Valor bruto").fill("220,00");
        await field(dialog, "Imposto retido").fill("15,00");
        await field(dialog, "Taxas").fill("5,00");
        await submit(dialog, "Completar");
        await expect(dialog).toBeHidden();
        await expect(movements.getByText("a discriminar")).toHaveCount(0);

        await menu(page, "Registrar", "Pagamento de imposto…");
        dialog = await openDialog(page, "Pagamento de imposto devido", "pagamento de imposto");
        await field(dialog, "Valor").fill("10,00");
        await submit(dialog, "Registrar");
        await expect(dialog).toBeHidden();
        await expect(notice(page, "Pagamento de imposto registrado.")).toBeVisible();
        await expectNoHorizontalOverflow(page);
        expect(errors).toEqual([]);
      });

      test("simulador, regra de imposto, características e índice de referência", async ({ page }) => {
        const errors = watchErrors(page);
        await openDemo(page, "/investimentos");
        await expect(tableOf(page, "Avaliações", phone)).toBeVisible();

        // no rule yet: the application brings none
        await menu(page, "Registrar", /Simular resgate/);
        await expect(notice(page, /Cadastre antes uma regra de imposto/)).toBeVisible();
        await menu(page, "Mais", "Regra de imposto…");
        let dialog = await openDialog(page, "Regra de imposto (simulação)", "regra de imposto");
        await submit(dialog, "Salvar");
        await expect(dialog.getByText("Informe o nome.")).toBeVisible();
        await field(dialog, "Nome").fill("Regra fictícia 15%");
        await submit(dialog, "Salvar");
        await expect(dialog.getByText(/Informe a alíquota/)).toBeVisible();
        await field(dialog, "Alíquota (%)").fill("15");
        await submit(dialog, "Salvar");
        await expect(dialog).toBeHidden();

        await menu(page, "Registrar", /Simular resgate/);
        dialog = await openDialog(page, /Simular resgate — CDB Banco X 2028/, "simulador");
        await submit(dialog, "Simular");
        await expect(dialog.getByText("Informe o valor.")).toBeVisible();
        await field(dialog, "Valor bruto a resgatar").fill("1.000,00");
        await field(dialog, "Taxas").fill("10,00");
        await submit(dialog, "Simular");
        const result = dialog.getByRole("region", { name: "Resultado da simulação" });
        await expect(result).toBeVisible();
        await expect(result.getByText("estimado").first()).toBeVisible();
        await expect(result.getByText(/Campos estimados/)).toBeVisible();
        await expectNoHorizontalOverflow(page);
        await audit(page, "resultado da simulação");
        // Registrar resgate…: the redemption opens filled, nothing written until confirmed
        await dialog.getByRole("button", { name: "Registrar resgate…" }).click();
        dialog = await openDialog(page, /Resgate — CDB Banco X 2028/, "resgate preenchido");
        await expect(field(dialog, "Valor bruto")).toHaveValue("1.000,00");
        await submit(dialog, "Registrar");
        await expect(dialog).toBeHidden();

        // Características…
        await menu(page, "Mais", /^Características/);
        dialog = await openDialog(page, "Características do investimento", "características");
        await field(dialog, "Emissor").fill("Banco Y S.A.");
        await submit(dialog, "Salvar");
        await expect(dialog).toBeHidden();
        await expect(notice(page, "Características salvas.")).toBeVisible();

        // Importar índice de referência…: a local series, set beside the return
        await menu(page, "Mais", "Importar índice de referência…");
        dialog = await openDialog(page, "Importar índice de referência", "importar índice");
        await submit(dialog, "Importar");
        await expect(dialog.getByText("Escolha o arquivo da série (data;valor).")).toBeVisible();
        await dialog.getByLabel(/Série do índice/).setInputFiles({
          name: "cdi.csv",
          mimeType: "text/csv",
          buffer: Buffer.from("data;valor\n28/01/2026;100,00\n28/03/2026;102,00\n"),
        });
        await expect(field(dialog, "Nome do índice")).toHaveValue("cdi");
        await submit(dialog, "Importar");
        await expect(dialog).toBeHidden();
        await expect(notice(page, "Índice cdi importado.")).toBeVisible();
        await choose(page, page, "Índice de referência", "cdi");
        await expect(
          tableOf(page, "Rentabilidade por método", phone).getByText(/variação do índice cdi/),
        ).toBeVisible();
        await expectNoHorizontalOverflow(page);
        expect(errors).toEqual([]);
      });

      test("novo investimento e negociação por quantidade", async ({ page }) => {
        const errors = watchErrors(page);
        await openDemo(page, "/investimentos");
        await expect(tableOf(page, "Avaliações", phone)).toBeVisible();
        // a position tracked by value: trades are explained, not opened
        await menu(page, "Negociação", "Compra…");
        await expect(notice(page, /Negociações são para ativos acompanhados por quantidade/)).toBeVisible();

        await page.getByRole("button", { name: "Novo investimento…" }).first().click();
        let dialog = await openDialog(page, "Novo investimento", "novo investimento");
        await submit(dialog, "Criar");
        await expect(dialog.getByText("Informe o nome.")).toBeVisible();
        await field(dialog, "Nome").fill("VALE3");
        await choose(page, dialog, "Classe", "Ações");
        await choose(page, dialog, "Acompanhamento", "Por quantidade e preço");
        await field(dialog, "Código (opcional)").fill("VALE3");
        await expectNoHorizontalOverflow(page);
        await submit(dialog, "Criar");
        await expect(dialog).toBeHidden();
        await expect(page.getByRole("heading", { level: 2, name: "VALE3" })).toBeVisible();

        await menu(page, "Negociação", "Posição inicial…");
        dialog = await openDialog(page, /Posição inicial — VALE3/, "posição inicial");
        await field(dialog, "Quantidade").fill("100");
        await field(dialog, "Custo total conhecido").fill("6.000,00");
        await submit(dialog, "Registrar");
        await expect(dialog).toBeHidden();
        const lots = tableOf(page, "Lotes", phone);
        await expect(lots).toBeVisible();

        await menu(page, "Negociação", "Compra…");
        dialog = await openDialog(page, /Compra — VALE3/, "compra");
        await field(dialog, "Quantidade").fill("50");
        await field(dialog, "Preço unitário").fill("62,50");
        await field(dialog, "Custos").fill("4,90");
        await submit(dialog, "Registrar");
        await expect(dialog).toBeHidden();
        await expect(lots.getByText(/^50|50$/).first()).toBeVisible();

        await menu(page, "Negociação", "Venda…");
        dialog = await openDialog(page, /Venda — VALE3/, "venda");
        await field(dialog, "Quantidade").fill("abc");
        await field(dialog, "Preço unitário").fill("65,00");
        await submit(dialog, "Registrar");
        await expect(dialog.getByText("Quantidade inválida.")).toBeVisible();
        await field(dialog, "Quantidade").fill("40");
        await choose(page, dialog, "Custo", "Por lote (mais antigo)");
        await submit(dialog, "Registrar");
        await expect(dialog).toBeHidden();

        await menu(page, "Negociação", /^Desdobramento/);
        dialog = await openDialog(page, /Desdobramento\/grupamento — VALE3/, "desdobramento");
        await field(dialog, "Fator (2 = cada ação vira 2)").fill("2");
        await submit(dialog, "Registrar");
        await expect(dialog).toBeHidden();

        await menu(page, "Negociação", "Bonificação…");
        dialog = await openDialog(page, /Bonificação — VALE3/, "bonificação");
        await field(dialog, "Quantidade recebida").fill("5");
        await submit(dialog, "Registrar");
        await expect(dialog).toBeHidden();
        await expect(notice(page, "Negociação registrada.")).toBeVisible();
        await expect(tableOf(page, "Movimentos", phone).getByText("Bonificação").first()).toBeVisible();
        await expectNoHorizontalOverflow(page);
        await audit(page, "carteira com posição por quantidade");
        expect(errors).toEqual([]);
      });

      test("links: ver lançamentos, ver conta bancária, composição e o link que chega", async ({ page }) => {
        const errors = watchErrors(page);
        const addresses = await recordAddresses(page);
        await openDemo(page, "/investimentos");
        await expect(tableOf(page, "Avaliações", phone)).toBeVisible();
        await page.getByRole("button", { name: "Ver lançamentos" }).click();
        await expect(page.getByRole("heading", { level: 1, name: "Livro financeiro" })).toBeVisible();
        expect((await addresses()).some((a) => a.startsWith("/livro") && a.includes("ref=conta"))).toBe(true);

        await page.goBack();
        await expect(page.getByRole("heading", { level: 1, name: "Investimentos" })).toBeVisible();
        await page.getByRole("button", { name: "Ver conta bancária" }).click();
        await expect(page.getByRole("heading", { level: 1, name: "Contas e cartões" })).toBeVisible();
        expect((await addresses()).some((a) => a.startsWith("/contas") && a.includes("ref=banco"))).toBe(true);

        await page.goBack();
        await expect(page.getByRole("heading", { level: 1, name: "Investimentos" })).toBeVisible();
        await menu(page, "Mais", /Composição da carteira/);
        await expect(page.getByRole("heading", { level: 1, name: "Relatórios" })).toBeVisible();
        expect((await addresses()).some((a) => a.startsWith("/relatorios") && a.includes("ref=composition"))).toBe(
          true,
        );
        expect(errors).toEqual([]);
      });
    });
  }
}
