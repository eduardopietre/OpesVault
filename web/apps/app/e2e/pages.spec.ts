/**
 * Every destination and the catalog render without console errors (CSP and Trusted Types included) and
 * never scroll sideways, at each size of docs/16 §4 and docs/18 §5.1, in light and dark.
 */
import { expect, test } from "@playwright/test";
import { SCHEMES, SIZES, expectNoHorizontalOverflow, openDemo, settle, watchErrors } from "./helpers.ts";

const PATHS = [
  ["/visao-geral", "Visão geral"],
  ["/orcamento", "Orçamento"],
  ["/calendario", "Calendário"],
  ["/livro", "Livro financeiro"],
  ["/importar", "Importar e revisar"],
  ["/contas", "Contas e cartões"],
  ["/recorrencias", "Recorrências"],
  ["/investimentos", "Investimentos"],
  ["/relatorios", "Relatórios"],
  ["/assistente", "Assistente"],
  ["/metas", "Metas"],
  ["/reembolsos", "Reembolsos e acertos"],
  ["/imposto-de-renda", "Imposto de renda"],
  ["/documentos", "Documentos"],
  ["/configuracoes", "Configurações"],
] as const;

for (const size of SIZES) {
  for (const scheme of SCHEMES) {
    test.describe(`${size.width}x${size.height} ${scheme}`, () => {
      test.use({ viewport: size, colorScheme: scheme });

      test("every page renders cleanly", async ({ page }) => {
        const errors = watchErrors(page);
        for (const [path, title] of PATHS) {
          await openDemo(page, path);
          await expect(page.getByRole("heading", { level: 1, name: title })).toBeVisible();
          await expectNoHorizontalOverflow(page);
        }
        expect(errors).toEqual([]);
      });

      test("the catalog renders cleanly", async ({ page }) => {
        const errors = watchErrors(page);
        await page.goto("/catalogo");
        await expect(page.getByRole("heading", { name: "Sistema visual" })).toBeVisible();
        // The charts are drawn (lazy chunk, canvas) without a fallback message.
        await expect(page.locator("canvas").first()).toBeVisible();
        await expect(page.getByText("Não foi possível desenhar o gráfico")).toHaveCount(0);
        await settle(page);
        await expectNoHorizontalOverflow(page);
        expect(errors).toEqual([]);
      });

      test("the screens before a project render cleanly", async ({ page }) => {
        const errors = watchErrors(page);
        for (const path of ["/boas-vindas", "/entrar", "/criar-conta"]) {
          await page.goto(path);
          await expect(page.locator("h1").first()).toBeVisible();
          await expectNoHorizontalOverflow(page);
        }
        expect(errors).toEqual([]);
      });
    });
  }
}

test("production build carries the strict CSP", async ({ page }) => {
  await page.goto("/entrar");
  const csp = await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute("content");
  expect(csp).toContain("script-src 'self'");
  expect(csp).toContain("style-src 'self'");
  expect(csp).toContain("require-trusted-types-for 'script'");
  expect(csp).not.toContain("unsafe-inline");
  expect(csp).not.toContain("unsafe-eval");
  // No third-party origin anywhere in the document.
  const external = await page.evaluate(() =>
    [...document.querySelectorAll("script[src], link[href]")]
      .map((element) => element.getAttribute("src") ?? element.getAttribute("href") ?? "")
      .filter((url) => /^https?:\/\//.test(url) && !url.startsWith(location.origin)),
  );
  expect(external).toEqual([]);
});
