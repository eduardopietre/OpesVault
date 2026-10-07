/**
 * Screenshots of the Assistente in light and dark at each size (docs/18 §5.3), written to web/build/telas.
 *   pnpm --filter @opesvault/app screens
 */
import { test } from "@playwright/test";
import { openDemo, settle } from "../helpers.ts";
import { ask, firstIdOf, idle, scriptedOllama } from "./assistente_helpers.ts";
import { forEachScreen, screenshot } from "../shots.ts";

forEachScreen(({ suffix }) => {
  test("assistente", async ({ page }) => {
    const model = await scriptedOllama(page);
    await openDemo(page, "/assistente");
    await settle(page, 600);
    await screenshot(page, `assistente-${suffix}`);

    // a conversation: a read, a change approved, a shortcut and an answer
    model.turns.push(
      { calls: [{ name: "search_operations", arguments: { text: "Aluguel", start: "2026-08-01", limit: 5 } }] },
      { content: "Encontrei o aluguel de agosto e de setembro, os dois em Moradia (R$ 2.350,00 cada)." },
      { calls: [{ name: "search_operations", arguments: { text: "Aluguel", limit: 3 } }] },
      (body) => ({
        calls: [
          {
            name: "reclassify_operations",
            arguments: { ids: [firstIdOf(body)], category: "Lazer", reason: "Pedido do usuário" },
          },
        ],
      }),
      {
        calls: [{ name: "show_in_ledger", arguments: { account: "Lazer", start: "2026-01-01", end: "2026-12-31" } }],
      },
      { content: "Pronto: o aluguel foi para Lazer. Use o atalho para conferir no Livro." },
    );
    await ask(page, "Quanto paguei de aluguel em agosto?");
    await page.getByText(/Encontrei o aluguel de agosto/).waitFor();
    await idle(page);
    await ask(page, "Mova o aluguel mais recente para Lazer e mostre no Livro");
    const dialog = page.getByRole("dialog", { name: "Aprovar alteração" });
    await dialog.waitFor();
    await settle(page, 500);
    await screenshot(page, `assistente-aprovar-${suffix}`);
    await dialog.getByRole("button", { name: "Aprovar" }).click();
    await page.getByText(/Pronto: o aluguel foi para Lazer/).waitFor();
    await idle(page);
    await settle(page, 600);
    await screenshot(page, `assistente-conversa-${suffix}`);
    await page.evaluate(() => document.getElementById("conteudo")?.scrollTo(0, 0));
    await settle(page, 300);
    await screenshot(page, `assistente-inicio-${suffix}`);
  });

  test("assistente com problemas", async ({ page }) => {
    const model = await scriptedOllama(page, "origin");
    await openDemo(page, "/assistente");
    await ask(page, "Qual o saldo?");
    await page.getByRole("alert", { name: /não aceita este endereço/ }).waitFor();
    await settle(page, 600);
    await screenshot(page, `assistente-origem-${suffix}`);
    model.mode = "ok";
    const release = model.hold();
    model.turns.push({ content: "Pronto." });
    await page.getByRole("button", { name: "Tentar de novo" }).click();
    await page.getByText(/O assistente está pensando/).waitFor();
    await settle(page, 500);
    await screenshot(page, `assistente-pensando-${suffix}`);
    release();
  });
});
