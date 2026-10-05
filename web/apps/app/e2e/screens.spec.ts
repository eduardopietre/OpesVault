/**
 * Screenshots of the catalog and the shell in light and dark at each size (docs/18 §5.3), written to
 * web/build/telas for review, like the desktop's scripts/capturar_telas.py.
 *   pnpm --filter @opesvault/app screens
 */
import { fileURLToPath } from "node:url";
import { test } from "@playwright/test";
import { DEMO, SCHEMES, SIZES, openDemo, settle } from "./helpers.ts";

const OUT = fileURLToPath(new URL("../../../build/telas/", import.meta.url));

for (const size of SIZES) {
  for (const scheme of SCHEMES) {
    const suffix = `${size.width}x${size.height}-${scheme === "light" ? "claro" : "escuro"}`;
    test.describe(`${suffix}`, () => {
      test.use({ viewport: size, colorScheme: scheme, contextOptions: { reducedMotion: "reduce" } });

      test("catálogo", async ({ page }) => {
        await page.goto("/catalogo");
        await page.getByRole("heading", { name: "Sistema visual" }).waitFor();
        await settle(page, 900);
        await page.screenshot({ path: `${OUT}catalogo-${suffix}.png`, fullPage: true });
      });

      test("shell", async ({ page }) => {
        await openDemo(page, "/visao-geral");
        await settle(page);
        await page.screenshot({ path: `${OUT}shell-visao-geral-${suffix}.png` });
        await openDemo(page, "/livro");
        await settle(page);
        await page.screenshot({ path: `${OUT}shell-livro-${suffix}.png` });
        await page.keyboard.press("Control+k");
        await settle(page);
        await page.screenshot({ path: `${OUT}shell-paleta-${suffix}.png` });
        await page.keyboard.press("Escape");
        if (size.width < 640) {
          await page.getByRole("button", { name: /Mais seções/ }).click();
          await settle(page);
          await page.screenshot({ path: `${OUT}shell-mais-${suffix}.png` });
          await page.keyboard.press("Escape");
        } else if (size.width < 1024) {
          await page.getByRole("button", { name: "Abrir menu de seções" }).click();
          await settle(page);
          await page.screenshot({ path: `${OUT}shell-gaveta-${suffix}.png` });
          await page.keyboard.press("Escape");
        }
        await page.getByRole("button", { name: "Bloquear o projeto" }).click();
        await page.getByRole("heading", { name: /bloqueado/ }).waitFor();
        await settle(page);
        await page.screenshot({ path: `${OUT}shell-bloqueio-${suffix}.png` });
      });

      test("início", async ({ page }) => {
        await page.goto("/boas-vindas");
        await settle(page);
        await page.screenshot({ path: `${OUT}inicio-boas-vindas-${suffix}.png` });
        await page.goto("/entrar");
        await page.getByLabel("E-mail").fill(DEMO.email);
        await page.getByLabel("Senha da conta").fill(DEMO.password);
        await settle(page);
        await page.screenshot({ path: `${OUT}inicio-entrar-${suffix}.png` });
        await page.getByRole("button", { name: "Entrar", exact: true }).click();
        await page.getByRole("heading", { name: "Projetos" }).waitFor();
        await settle(page);
        await page.screenshot({ path: `${OUT}inicio-projetos-${suffix}.png` });
      });
    });
  }
}
