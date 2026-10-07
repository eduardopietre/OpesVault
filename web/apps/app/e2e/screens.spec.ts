/**
 * Screenshots of the catalog and the shell in light and dark at each size (docs/18 §5.3), written to
 * web/build/telas for review, like the desktop's scripts/capturar_telas.py.
 *   pnpm --filter @opesvault/app screens
 */
import { test } from "@playwright/test";
import { DEMO, openDemo, settle } from "./helpers.ts";
import { forEachScreen, screenshot } from "./shots.ts";

forEachScreen(({ size, suffix }) => {
  test("catálogo", async ({ page }) => {
    await page.goto("/catalogo");
    await page.getByRole("heading", { name: "Sistema visual" }).waitFor();
    await settle(page, 900);
    await screenshot(page, `catalogo-${suffix}`, { fullPage: true });
  });

  test("shell", async ({ page }) => {
    await openDemo(page, "/visao-geral");
    await settle(page);
    await screenshot(page, `shell-visao-geral-${suffix}`);
    await openDemo(page, "/livro");
    await settle(page);
    await screenshot(page, `shell-livro-${suffix}`);
    await page.keyboard.press("Control+k");
    await settle(page);
    await screenshot(page, `shell-paleta-${suffix}`);
    await page.keyboard.press("Escape");
    if (size.width < 640) {
      await page.getByRole("button", { name: /Mais seções/ }).click();
      await settle(page);
      await screenshot(page, `shell-mais-${suffix}`);
      await page.keyboard.press("Escape");
    } else if (size.width < 1024) {
      await page.getByRole("button", { name: "Abrir menu de seções" }).click();
      await settle(page);
      await screenshot(page, `shell-gaveta-${suffix}`);
      await page.keyboard.press("Escape");
    }
    await page.getByRole("button", { name: "Bloquear o projeto" }).click();
    await page.getByRole("heading", { name: /bloqueado/ }).waitFor();
    await settle(page);
    await screenshot(page, `shell-bloqueio-${suffix}`);
  });

  test("visão geral e calendário", async ({ page }) => {
    await openDemo(page, "/visao-geral");
    await settle(page, 1200);
    await screenshot(page, `visao-geral-${suffix}`);
    // The content scrolls inside the shell: the rest of the page, after the first screen.
    const scrollDown = async () => {
      await page.evaluate(() => document.getElementById("conteudo")?.scrollTo(0, 1e6));
      await settle(page, 600);
    };
    await scrollDown();
    await screenshot(page, `visao-geral-fim-${suffix}`);
    await openDemo(page, "/calendario");
    await settle(page, 800);
    await screenshot(page, `calendario-${suffix}`);
    await scrollDown();
    await screenshot(page, `calendario-fim-${suffix}`);
    await openDemo(page, "/imprimir/relatorio-mensal");
    await settle(page);
    await screenshot(page, `relatorio-mensal-${suffix}`, { fullPage: true });
  });

  test("início", async ({ page }) => {
    await page.goto("/boas-vindas");
    await settle(page);
    await screenshot(page, `inicio-boas-vindas-${suffix}`);
    await page.goto("/entrar");
    await page.getByLabel("E-mail").fill(DEMO.email);
    await page.getByLabel("Senha da conta").fill(DEMO.password);
    await settle(page);
    await screenshot(page, `inicio-entrar-${suffix}`);
    await page.getByRole("button", { name: "Entrar", exact: true }).click();
    await page.getByRole("heading", { name: "Projetos" }).waitFor();
    await settle(page);
    await screenshot(page, `inicio-projetos-${suffix}`);
  });
});
