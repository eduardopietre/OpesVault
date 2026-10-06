/** Automatic accessibility audit (axe, WCAG 2.2 AA): no violations on any screen, open overlay or theme. */
import AxeBuilder from "@axe-core/playwright";
import { animationsDone } from "./helpers.ts";
import { expect, test, type Page } from "@playwright/test";
import { DEMO, SCHEMES, openDemo, settle } from "./helpers.ts";

async function audit(page: Page, label: string) {
  await settle(page, 300);
  await animationsDone(page);
  const result = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    .analyze();
  const summary = result.violations.map(
    (violation) =>
      `${label}: ${violation.id} (${violation.impact}) ${violation.nodes
        .map((node) => `${node.target.join(" ")} ${node.failureSummary ?? ""}`)
        .slice(0, 3)
        .join(", ")}`,
  );
  expect(summary).toEqual([]);
}

for (const scheme of SCHEMES) {
  for (const viewport of [
    { width: 1280, height: 800 },
    { width: 390, height: 844 },
  ]) {
    test.describe(`${scheme} ${viewport.width}`, () => {
      test.use({ colorScheme: scheme, viewport, contextOptions: { reducedMotion: "reduce" } });

      test("catalog", async ({ page }) => {
        await page.goto("/catalogo");
        await page.getByRole("heading", { name: "Sistema visual" }).waitFor();
        await audit(page, "catálogo");
      });

      test("shell, pages and overlays", async ({ page }) => {
        for (const path of ["/visao-geral", "/livro", "/configuracoes"]) {
          await openDemo(page, path);
          await audit(page, path);
        }
        await page.keyboard.press("Control+k");
        await page.getByRole("combobox", { name: "Buscar comando ou seção" }).waitFor();
        await audit(page, "paleta");
        await page.keyboard.press("Escape");
        await page.keyboard.press("F1");
        await page.getByRole("dialog", { name: /Ajuda/ }).waitFor();
        await audit(page, "ajuda");
        await page.keyboard.press("Escape");
        if (viewport.width < 640) {
          await page.getByRole("button", { name: /Mais seções/ }).click();
          await page.getByRole("dialog", { name: "Todas as seções" }).waitFor();
          await audit(page, "mais");
          await page.keyboard.press("Escape");
        }
        await page.getByRole("button", { name: "Conta de Ana Souza" }).click();
        await page.getByRole("menu").waitFor();
        await audit(page, "menu da conta");
        await page.keyboard.press("Escape");
        await page.getByRole("button", { name: "Bloquear o projeto" }).click();
        await page.getByRole("heading", { name: /bloqueado/ }).waitFor();
        await audit(page, "bloqueio");
      });

      test("welcome, sign in, sign up and projects", async ({ page }) => {
        await page.goto("/boas-vindas");
        await audit(page, "boas-vindas");
        await page.goto("/criar-conta");
        await audit(page, "criar conta");
        await page.goto("/entrar");
        await audit(page, "entrar");
        await page.getByLabel("E-mail").fill(DEMO.email);
        await page.getByLabel("Senha da conta").fill(DEMO.password);
        await page.getByRole("button", { name: "Entrar", exact: true }).click();
        await page.getByRole("heading", { name: "Projetos" }).waitFor();
        await audit(page, "projetos");
        await page.getByRole("button", { name: /Casa/ }).click();
        await page.getByRole("dialog", { name: "Abrir Casa" }).waitFor();
        await audit(page, "abrir projeto");
      });
    });
  }
}
