/**
 * Assistente end to end (docs/18 §5, SCREENS.md): the demonstration project and a scripted stand-in for Ollama
 * (a real one is never contacted). A whole conversation with reads, a change refused and a change approved,
 * the shortcut to the Livro, cancel and "Nova conversa"; the four ways the local AI can be unavailable; no
 * console errors, no sideways scroll at the five sizes, axe clean, light and dark.
 */
import { expect, test, type Page } from "@playwright/test";
import { TEST_SCHEMES, TEST_SIZES, expectNoHorizontalOverflow, openDemo, watchErrors, auditWith } from "../helpers.ts";
import { ask, firstIdOf, idle, scriptedOllama } from "./assistente_helpers.ts";

const audit = auditWith({ settleMs: 300, skipNotices: false });

const log = (page: Page) => page.getByRole("log", { name: "Conversa com o assistente" });
const dialog = (page: Page) => page.getByRole("dialog", { name: "Aprovar alteração" });

for (const size of TEST_SIZES) {
  for (const scheme of TEST_SCHEMES) {
    test.describe(`${size.width}x${size.height} ${scheme}`, () => {
      test.use({ viewport: size, colorScheme: scheme, contextOptions: { reducedMotion: "reduce" } });

      test("a whole conversation: reads, a refusal, an approval, the Livro, cancel and a new conversation", async ({
        page,
      }) => {
        const errors = watchErrors(page);
        const model = await scriptedOllama(page);
        await openDemo(page, "/assistente");
        await expect(page.getByRole("heading", { level: 1, name: "Assistente" })).toBeVisible();
        await expect(page.getByRole("group", { name: "Perguntas de exemplo" })).toBeVisible();
        await expect(page.getByText("IA local · gemma4:12b")).toBeVisible();
        await expectNoHorizontalOverflow(page);
        await audit(page, "assistente vazio");

        // an example question: a read, then the answer
        model.turns.push(
          { calls: [{ name: "search_operations", arguments: { text: "Aluguel", limit: 5 } }] },
          { content: "Há lançamentos de aluguel em vários meses, todos em Moradia." },
        );
        await page.getByRole("button", { name: "Há lançamentos de Uber fora de Transporte?" }).click();
        await expect(log(page).getByText("Há lançamentos de aluguel em vários meses, todos em Moradia.")).toBeVisible();
        const tools = log(page).getByRole("list", { name: "Ferramentas consultadas" });
        await expect(tools.getByText("Busca de lançamentos")).toBeVisible();
        await expect(tools.getByText(/encontrado\(s\)/)).toBeVisible();
        await idle(page);
        await expect(page.getByRole("group", { name: "Perguntas de exemplo" })).toHaveCount(0);
        await expectNoHorizontalOverflow(page);
        await audit(page, "assistente com leitura");

        // a change: refused first
        const reclassify = (body: Parameters<typeof firstIdOf>[0]) => ({
          calls: [
            {
              name: "reclassify_operations",
              arguments: { ids: [firstIdOf(body)], category: "Lazer", reason: "Pedido do usuário" },
            },
          ],
        });
        model.turns.push(
          { calls: [{ name: "search_operations", arguments: { text: "Aluguel", limit: 3 } }] },
          reclassify,
          { content: "Tudo bem, deixei o aluguel como estava." },
        );
        await ask(page, "Mova o aluguel para Lazer");
        await expect(dialog(page)).toBeVisible();
        await expect(dialog(page).getByRole("list", { name: "O que muda" })).toContainText("Aluguel");
        await expect(dialog(page).getByText(/Proposta pelo assistente \(IA local, gemma4:12b\)/)).toBeVisible();
        await expect(dialog(page).getByRole("button", { name: "Recusar" })).toBeFocused();
        await expectNoHorizontalOverflow(page);
        await audit(page, "aprovar alteração");
        await dialog(page).getByRole("button", { name: "Recusar" }).click();
        await expect(dialog(page)).toHaveCount(0);
        await expect(log(page).getByText("Tudo bem, deixei o aluguel como estava.")).toBeVisible();
        await expect(log(page).getByText("Recusada")).toBeVisible();
        await idle(page);

        // the same change, approved: one undo step
        model.turns.push(
          { calls: [{ name: "search_operations", arguments: { text: "Aluguel", limit: 3 } }] },
          reclassify,
          { content: "Feito: o aluguel agora está em Lazer." },
        );
        await ask(page, "Mova o aluguel para Lazer, por favor");
        await expect(dialog(page)).toBeVisible();
        await dialog(page).getByRole("button", { name: "Aprovar" }).click();
        await expect(dialog(page)).toHaveCount(0);
        await expect(log(page).getByText("Feito: o aluguel agora está em Lazer.")).toBeVisible();
        await expect(log(page).getByText("Aplicada")).toBeVisible();
        await expect(log(page).getByText(/^Aplicado:/)).toBeVisible();
        await idle(page);
        await expectNoHorizontalOverflow(page);
        await audit(page, "assistente com alteração aplicada");

        // the shortcut to the Livro
        model.turns.push(
          {
            calls: [
              { name: "show_in_ledger", arguments: { account: "Moradia", start: "2026-08-01", end: "2026-08-31" } },
            ],
          },
          { content: "Abra o atalho para ver os lançamentos." },
        );
        await ask(page, "Mostre a moradia de agosto no Livro");
        await expect(log(page).getByText("Abra o atalho para ver os lançamentos.")).toBeVisible();
        await idle(page);
        const link = log(page).getByRole("button", { name: /^Ver no Livro: Moradia/ });
        await expect(link).toBeVisible();
        await audit(page, "assistente com atalho");
        await link.click();
        await expect(page.getByRole("heading", { level: 1, name: "Livro financeiro" })).toBeVisible();
        // (the period is in the filters: beside the table, or behind "Filtros" on a phone)
        if (size.width >= 640) await expect(page.getByLabel("Data inicial")).toHaveValue("01/08/2026");
        // back to the Assistente (the sidebar, the drawer or the bottom bar by size): the conversation is still there
        await page.goBack();
        await expect(page.getByRole("heading", { level: 1, name: "Assistente" })).toBeVisible();
        await expect(log(page).getByText("Feito: o aluguel agora está em Lazer.")).toBeVisible();

        // cancel
        const release = model.hold();
        model.turns.push({ content: "Esta resposta chega tarde demais." });
        await ask(page, "Uma pergunta que será cancelada");
        await expect(page.getByText(/O assistente está pensando/)).toBeVisible();
        await audit(page, "assistente pensando");
        await page.getByRole("button", { name: "Cancelar" }).click();
        await expect(log(page).getByText("Consulta cancelada.")).toBeVisible();
        release();
        await idle(page);
        await expect(log(page).getByText("Esta resposta chega tarde demais.")).toHaveCount(0);

        // Nova conversa forgets everything
        await page.getByRole("button", { name: "Nova conversa" }).click();
        await expect(page.getByRole("group", { name: "Perguntas de exemplo" })).toBeVisible();
        await expect(log(page).getByText("Feito: o aluguel agora está em Lazer.")).toHaveCount(0);

        // wrong answers: three in a row stop the question
        model.turns.length = 0;
        model.turns.push(
          { calls: [{ name: "nada", arguments: {} }] },
          { content: "" },
          { calls: [{ name: "tambem_nada", arguments: {} }] },
          { content: "Não deve ser pedida." },
        );
        await ask(page, "Uma pergunta que dá errado");
        await expect(log(page).getByText(/errou 3 vezes seguidas e a pergunta foi interrompida/)).toBeVisible();
        await idle(page);
        await expectNoHorizontalOverflow(page);
        await audit(page, "assistente interrompido");

        expect(errors).toEqual([]);
      });

      test("a question with a CPF is not sent; Enter sends; the box stays free", async ({ page }) => {
        const errors = watchErrors(page);
        const model = await scriptedOllama(page);
        await openDemo(page, "/assistente");
        const box = page.getByRole("textbox", { name: "Pergunta ao assistente" });
        await box.fill("O CPF 529.982.247-25 aparece onde?");
        await box.press("Enter");
        await expect(page.getByText(/Tire o CPF ou CNPJ da pergunta/)).toBeVisible();
        expect(model.chats).toHaveLength(0);
        model.turns.push({ content: "Respondido pelo Enter." });
        await box.fill("Uma pergunta normal");
        await box.press("Enter");
        await expect(log(page).getByText("Respondido pelo Enter.")).toBeVisible();
        expect(JSON.stringify(model.chats)).not.toContain("529.982.247-25");
        expect(errors).toEqual([]);
      });

      test("explains each way the local AI can be unavailable", async ({ page }) => {
        const errors = watchErrors(page);
        const model = await scriptedOllama(page, "down");
        await openDemo(page, "/assistente");

        // the server is off
        await ask(page, "Qual o saldo?");
        const off = log(page).getByRole("alert", { name: "Não foi possível falar com o Ollama" });
        await expect(off).toBeVisible();
        await expect(off).toContainText("http://127.0.0.1:11434");
        await expect(off.getByRole("button", { name: "Abrir Configurações" })).toBeVisible();
        await expectNoHorizontalOverflow(page);
        await audit(page, "ollama fora do ar");

        // it comes back: Tentar de novo asks the same question
        model.mode = "ok";
        model.turns.push({ content: "O saldo está conferido." });
        await off.getByRole("button", { name: "Tentar de novo" }).click();
        await expect(log(page).getByText("O saldo está conferido.")).toBeVisible();
        await expect(log(page).getByText("Qual o saldo?")).toHaveCount(1);

        // running, but this origin is not allowed: the exact origin to add
        model.mode = "origin";
        await ask(page, "E agora?");
        const refused = log(page).getByRole("alert", { name: /não aceita este endereço/ });
        await expect(refused).toBeVisible();
        const origin = new URL(page.url()).origin;
        await expect(refused.getByText(`OLLAMA_ORIGINS=${origin}`)).toBeVisible();
        await expect(refused).toContainText(`setx OLLAMA_ORIGINS "${origin}"`);
        await expect(refused.getByRole("button", { name: "Copiar origem" })).toBeVisible();
        await expectNoHorizontalOverflow(page);
        await audit(page, "origem não permitida");

        // a model without tools
        model.mode = "no-tools";
        await refused.getByRole("button", { name: "Tentar de novo" }).click();
        const tools = log(page).getByRole("alert", { name: "O modelo não aceita ferramentas" });
        await expect(tools).toBeVisible();
        await expect(tools).toContainText("O modelo gemma4:12b não aceita ferramentas");
        await audit(page, "modelo sem ferramentas");
        await tools.getByRole("button", { name: "Abrir Configurações" }).click();
        await expect(page.getByRole("heading", { level: 1, name: "Configurações" })).toBeVisible();
        expect(errors.filter((e) => !/Failed to load resource|CORS|net::ERR/i.test(e))).toEqual([]);
      });
    });
  }
}
