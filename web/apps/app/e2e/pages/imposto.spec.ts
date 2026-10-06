/**
 * Imposto de renda end to end (docs/18 §5, SCREENS.md): the demonstration project, every button and menu item,
 * every dialog submitted, no console errors, no sideways scroll at the five sizes, axe clean, light and dark.
 */
import { expect, test, type Page } from "@playwright/test";
import { SCHEMES, SIZES, expectNoHorizontalOverflow, recordAddresses, settle, watchErrors } from "../helpers.ts";
import { audit, tableOf } from "./sharing_helpers.ts";

/** The demonstration project on the year its tax data is in. */
async function open(page: Page) {
  await page.goto("/imposto-de-renda?demo&ref=year:2026");
  await expect(page.getByRole("heading", { level: 1, name: "Imposto de renda" })).toBeVisible();
  await expect(page.getByRole("list", { name: "Pendências da declaração" })).toBeVisible();
}

const section = (page: Page, heading: string | RegExp) =>
  page.getByRole("heading", { name: heading, level: 2 }).locator("xpath=ancestor::section[1]");

async function menu(page: Page, button: string, item: string | RegExp) {
  await page.getByRole("button", { name: button, exact: true }).click();
  await page.getByRole("menuitem", { name: item }).click();
}

/** Closes the open dialog with its Cancel (or Close) button. */
async function leave(page: Page, name: string | RegExp) {
  const box = page.getByRole("dialog", { name });
  await box
    .getByRole("button", { name: /^(Cancelar|Fechar)$/ })
    .last()
    .click();
  await expect(box).toBeHidden();
}

for (const size of SIZES) {
  for (const scheme of SCHEMES) {
    test.describe(`imposto ${size.width}x${size.height} ${scheme}`, () => {
      test.use({ viewport: size, colorScheme: scheme, contextOptions: { reducedMotion: "reduce" } });
      const phone = size.width < 640;

      test("every button, menu and dialog works, cleanly", async ({ page }) => {
        const errors = watchErrors(page);
        const addresses = await recordAddresses(page);
        await open(page);
        await expect(tableOf(page, "Pagamentos efetuados", phone)).toBeVisible();
        await expect(tableOf(page, "Rendimentos tributáveis de pessoa jurídica", phone)).toContainText(
          "Empresa Exemplo Ltda",
        );
        // nothing fiscal is embedded: the simulation says what is missing
        await expect(page.getByText(/Falta informar a tabela anual de 2026/)).toBeVisible();
        await settle(page);
        await expectNoHorizontalOverflow(page);
        await audit(page, "imposto");

        // ── a pending item: the CPF/CNPJ of a payee, masked and checked ──
        await page
          .getByRole("button", { name: /^Informar CPF\/CNPJ… \(CPF\/CNPJ de quem recebeu: Consulta Pediatra/ })
          .click();
        let box = page.getByRole("dialog", { name: "CPF ou CNPJ" });
        await box.getByLabel("CPF ou CNPJ").fill("11222333000180");
        await expect(box.getByLabel("CPF ou CNPJ")).toHaveValue("11.222.333/0001-80");
        await expect(box.getByText("CPF ou CNPJ inválido: confira os dígitos.").first()).toBeVisible();
        await expectNoHorizontalOverflow(page);
        await audit(page, "cpf/cnpj com erro");
        await box.getByLabel("CPF ou CNPJ").fill("11222333000181");
        await box.getByRole("button", { name: "Salvar", exact: true }).click();
        await expect(box).toBeHidden();
        await expect(page.getByText("CPF/CNPJ salvo.")).toBeVisible();
        const resolver = page.getByRole("button", {
          name: /^Informar CPF\/CNPJ… \(CPF\/CNPJ de quem recebeu: Consulta Pediatra/,
        });
        await expect(resolver).toHaveCount(0); // the pending item is resolved
        // one undo with the project's shortcut, and back
        await page.keyboard.press("Control+z");
        await expect(resolver).toBeVisible();
        await page.keyboard.press("Control+Shift+z");
        await expect(resolver).toHaveCount(0);

        // ── receipts and payslips ──
        await page
          .getByRole("button", { name: /^Comprovantes… \(Comprovante não anexado: Farmácia São Paulo/ })
          .click();
        box = page.getByRole("dialog", { name: "Comprovantes" });
        await expect(box.getByLabel("Escolher o comprovante")).toBeAttached();
        await audit(page, "comprovantes");
        await leave(page, "Comprovantes");

        await page.getByRole("button", { name: /^Contracheques… \(Bruto, imposto retido e INSS/ }).click();
        box = page.getByRole("dialog", { name: "Contracheques" });
        await box.locator("[data-row-id]").nth(1).click(); // the deposit of 05/02/2026
        await box.getByRole("button", { name: "Detalhar…" }).click();
        const detail = page.getByRole("dialog", { name: "Detalhar rendimento" });
        await detail.getByLabel("Bruto").fill("9600");
        await detail.getByLabel("IR retido").fill("700");
        await detail.getByRole("button", { name: "Salvar", exact: true }).click();
        await expect(detail).toBeHidden();
        await expect(box).toContainText("R$ 9.600,00 / R$ 700,00 / —");
        await leave(page, "Contracheques");

        // ── an asset: group and code chosen from the IRPF table ──
        await page.getByRole("button", { name: /^Classificar… \(Grupo e código do bem: Conjunta/ }).click();
        box = page.getByRole("dialog", { name: "Bens e Direitos" });
        await box.getByRole("button", { name: "Salvar", exact: true }).click();
        await expect(box.getByText("Escolha o grupo e o código na tabela do IRPF.")).toBeVisible();
        const kind = box.getByRole("combobox", { name: "Tipo (grupo e código do IRPF)" });
        await kind.fill("06.01");
        await page.getByRole("option", { name: /^06\.01/ }).click();
        await expectNoHorizontalOverflow(page);
        await audit(page, "bens e direitos");
        await box.getByRole("button", { name: "Salvar", exact: true }).click();
        await expect(box).toBeHidden();
        await expect(page.getByText("Bem classificado.")).toBeVisible();

        // ── Cadastros ──
        await menu(page, "Cadastros", "Declarantes e dependentes…");
        box = page.getByRole("dialog", { name: "Declarantes e dependentes" });
        await tableOf(page, "Integrantes", phone).getByText("Bruno").click();
        await box.getByRole("button", { name: "Editar…" }).click();
        const member = page.getByRole("dialog", { name: "Dados fiscais — Bruno" });
        await expect(member.getByLabel("CPF")).toHaveValue("111.444.777-35");
        await member.getByLabel("Relação de dependência").fill("Enteado(a)");
        await expectNoHorizontalOverflow(page);
        await audit(page, "dados fiscais");
        await member.getByRole("button", { name: "Salvar", exact: true }).click();
        await expect(member).toBeHidden();
        await expect(box.getByText("Dados fiscais salvos.")).toBeVisible();
        await leave(page, "Declarantes e dependentes");

        await menu(page, "Cadastros", "Natureza dos rendimentos…");
        box = page.getByRole("dialog", { name: "Natureza dos rendimentos" });
        await box.getByRole("combobox", { name: "Natureza: Outras receitas" }).click();
        await page.getByRole("option", { name: /Isento e não tributável/ }).click();
        await expectNoHorizontalOverflow(page);
        await audit(page, "natureza");
        await box.getByRole("button", { name: "Salvar", exact: true }).click();
        await expect(box).toBeHidden();
        await expect(page.getByText("Natureza dos rendimentos salva.")).toBeVisible();

        await menu(page, "Cadastros", "Novo bem (imóvel, veículo)…");
        box = page.getByRole("dialog", { name: "Novo bem" });
        await box.getByLabel(/^Nome do bem/).fill("Carro");
        await box.getByRole("combobox", { name: "Tipo (grupo e código do IRPF)" }).fill("02.01");
        await page.getByRole("option", { name: /^02\.01/ }).click();
        await box.getByLabel("Custo de aquisição").fill("45000");
        await expectNoHorizontalOverflow(page);
        await audit(page, "novo bem");
        await box.getByRole("button", { name: "Salvar", exact: true }).click();
        await expect(box).toBeHidden();
        await expect(tableOf(page, "Bens e direitos", phone)).toContainText("Carro");

        await menu(page, "Cadastros", "Tabela e limites do ano…");
        box = page.getByRole("dialog", { name: "Tabela e limites de 2026" });
        await box.getByLabel("Faixa 1: base anual até").fill("30000");
        await box.getByLabel("Faixa 1: alíquota (%)").fill("10");
        await box.getByLabel("Faixa 2: alíquota (%)").fill("20");
        await box.getByLabel("Faixa 2: parcela a deduzir").fill("3000");
        await box.getByLabel("Desconto simplificado (%)").fill("20");
        await box.getByLabel("Teto do desconto simplificado").fill("16000");
        await expectNoHorizontalOverflow(page);
        await audit(page, "tabela do ano");
        await box.getByRole("button", { name: "Salvar", exact: true }).click();
        await expect(box).toBeHidden();
        await expect(page.getByText("Tabela do ano salva.")).toBeVisible();
        await expect(page.getByText(/Falta informar a tabela anual de 2026/)).toHaveCount(0);

        await menu(page, "Cadastros", "Regras de renda variável…");
        box = page.getByRole("dialog", { name: "Regras de renda variável" });
        await box.getByLabel("Operações comuns (ações e ETF) (%)").fill("15");
        await box.getByLabel("Fonte", { exact: true }).fill("Receita Federal");
        await expectNoHorizontalOverflow(page);
        await audit(page, "regras");
        await box.getByRole("button", { name: "Salvar", exact: true }).click();
        await expect(box).toBeHidden();
        await expect(page.getByText("Regras de renda variável salvas.")).toBeVisible();

        // ── a DARF, from a reminder's link ──
        await page.evaluate(() => {
          window.history.pushState({}, "", "/imposto-de-renda?ref=variable_income:2026-04&act=darf");
          window.dispatchEvent(new PopStateEvent("popstate"));
        });
        box = page.getByRole("dialog", { name: "DARF de renda variável" });
        await expect(box).toBeVisible();
        await expect(box).toContainText("Apuração de 04/2026");
        await box.getByRole("button", { name: "Registrar pagamento" }).click();
        await expect(box.getByText("Informe o valor pago.")).toBeVisible();
        await audit(page, "darf");
        await box.getByLabel("Valor pago").fill("120");
        await box.getByRole("button", { name: "Registrar pagamento" }).click();
        await expect(box).toBeHidden();
        await expect(page.getByText("Pagamento do DARF registrado.")).toBeVisible();
        await expect(page).not.toHaveURL(/act=/);

        // ── documents of the year ──
        const docs = section(page, /^Documentos do ano/);
        await tableOf(page, "Documentos do ano", phone).getByText("Saldo devedor em 31/12").click();
        await docs.getByRole("button", { name: "Recebido / não recebido" }).click();
        await expect(tableOf(page, "Documentos do ano", phone)).toContainText("Recebido (marcado)");
        await docs.getByRole("button", { name: "Recebido / não recebido" }).click();
        await expect(tableOf(page, "Documentos do ano", phone)).not.toContainText("Recebido (marcado)");
        await tableOf(page, "Documentos do ano", phone).getByText("Recibos e notas — Farmácia").click();
        await docs.getByRole("button", { name: "Abrir…" }).click();
        await expect(page.getByRole("dialog", { name: "Comprovantes" })).toBeVisible();
        await leave(page, "Comprovantes");

        // ── informes ──
        const reports = section(page, "Informes");
        await reports.getByRole("button", { name: "Abrir…" }).click();
        box = page.getByRole("dialog", { name: "Informe de rendimentos" });
        await expect(box.getByRole("combobox", { name: "De quem é o informe" })).toContainText("Banco A");
        await expectNoHorizontalOverflow(page);
        await audit(page, "informe");
        await leave(page, "Informe de rendimentos");
        await menu(page, "Mais", "Novo informe sem arquivo…");
        box = page.getByRole("dialog", { name: "Informe de rendimentos" });
        await box.getByRole("button", { name: "Salvar informe" }).click();
        await expect(box.getByText("Escolha de quem é o informe.")).toBeVisible();
        await leave(page, "Informe de rendimentos");
        await reports.getByRole("button", { name: "Remover" }).click();
        const ask = page.getByRole("alertdialog", { name: "Remover este informe?" });
        await ask.getByRole("button", { name: "Remover" }).click();
        await expect(page.getByText("Informe removido.")).toBeVisible();
        await expect(page.getByText(/Nenhum informe deste ano/)).toBeVisible();
        await page.keyboard.press("Control+z");
        await expect(tableOf(page, "Informes de rendimentos", phone)).toBeVisible();

        // ── the other sheet buttons guide when nothing is chosen ──
        await section(page, "Pagamentos efetuados").getByRole("button", { name: "CPF/CNPJ…" }).click();
        await expect(page.getByText("Escolha um pagamento na tabela.").first()).toBeVisible();
        await section(page, "Rendimentos").getByRole("button", { name: "CNPJ da fonte…" }).click();
        await expect(page.getByText("Escolha uma fonte pagadora.").first()).toBeVisible();

        // ── the print view and back ──
        await page.evaluate(() => {
          window.print = () => undefined;
        });
        await menu(page, "Mais", "Relatório para a declaração (PDF)…");
        await expect(page).toHaveURL(/\/imprimir\/imposto/);
        await expect(page.getByRole("heading", { level: 1 })).toContainText("imposto de renda, ano-calendário 2026");
        await expect(
          page.getByRole("heading", { level: 2, name: "Bens e direitos (custo de aquisição)" }),
        ).toBeVisible();
        await expectNoHorizontalOverflow(page);
        await audit(page, "relatório");
        await page.getByRole("button", { name: "Voltar ao Imposto de renda" }).click();
        await expect(page.getByRole("heading", { level: 1, name: "Imposto de renda" })).toBeVisible();

        // ── every collapsible section closes and opens ──
        const toggles = page.locator("button[aria-expanded]");
        const count = await toggles.count();
        for (let index = 0; index < count; index++) {
          const toggle = toggles.nth(index);
          if (!(await toggle.isVisible())) continue;
          await toggle.click();
          await toggle.click();
        }
        // a pending item leads to another screen
        expect((await addresses()).length).toBeGreaterThan(0);
        await settle(page);
        await expectNoHorizontalOverflow(page);
        await audit(page, "depois de usar");
        expect(errors).toEqual([]);
      });

      test("an empty year and an empty declarant are states, not errors", async ({ page }) => {
        const errors = watchErrors(page);
        await page.goto("/imposto-de-renda?demo&ref=year:2023");
        await expect(page.getByRole("heading", { level: 1, name: "Imposto de renda" })).toBeVisible();
        await expect(page.getByText(/ano-calendário 2023\)/)).toBeVisible();
        await expect(page.getByText(/Nenhuma receita no ano/)).toBeVisible();
        await expect(page.getByText(/Nenhum informe deste ano/)).toBeVisible();
        await expectNoHorizontalOverflow(page);
        await audit(page, "ano vazio");
        expect(errors).toEqual([]);
      });
    });
  }
}
