/**
 * Screenshots of Configurações in light and dark at each size (docs/18 §5.3), written to web/build/telas.
 *   pnpm --filter @opesvault/app screens
 */
import { fileURLToPath } from "node:url";
import { test, type Page } from "@playwright/test";
import { DEMO, SCHEMES, SIZES, openDemo, settle } from "../helpers.ts";

const OUT = fileURLToPath(new URL("../../../../build/telas/", import.meta.url));

const TABS = [
  ["projeto", "Projeto"],
  ["ia", "IA local"],
  ["seguranca", "Segurança"],
  ["backup", "Backup e salvamento"],
  ["privacidade", "Privacidade deste aparelho"],
] as const;

async function shot(page: Page, name: string, fullPage = true) {
  await settle(page, 500);
  await page.screenshot({ path: `${OUT}configuracoes-${name}.png`, fullPage });
}

for (const size of SIZES) {
  for (const scheme of SCHEMES) {
    const suffix = `${size.width}x${size.height}-${scheme === "light" ? "claro" : "escuro"}`;
    test.describe(suffix, () => {
      test.use({ viewport: size, colorScheme: scheme, contextOptions: { reducedMotion: "reduce" } });

      test("configurações", async ({ page }) => {
        await page.route("http://127.0.0.1:11434/**", async (route) => {
          const url = new URL(route.request().url());
          const headers = { "access-control-allow-origin": "*", "content-type": "application/json" };
          const body =
            url.pathname === "/api/version"
              ? { version: "0.35.1" }
              : url.pathname === "/api/tags"
                ? { models: [{ name: "gemma4:12b" }, { name: "llama3.2:3b" }] }
                : url.pathname === "/api/ps"
                  ? { models: [{ name: "gemma4:12b", size: 8_000_000_000, size_vram: 8_000_000_000 }] }
                  : { done: true };
          await route.fulfill({ status: 200, headers, body: JSON.stringify(body) });
        });
        await openDemo(page, "/configuracoes");
        for (const [id, label] of TABS) {
          await page.getByRole("tab", { name: label, exact: true }).click();
          if (id === "ia") {
            await page.getByRole("button", { name: "Verificar Ollama" }).click();
            await page
              .getByText(/Ollama 0\.35\.1 respondeu/)
              .waitFor({ timeout: 8000 })
              .catch(() => undefined);
            await page.getByRole("button", { name: /Como liberar este endereço/ }).click();
          }
          await shot(page, `${id}-${suffix}`);
        }
        // dialogs
        await page.getByRole("tab", { name: "Segurança", exact: true }).click();
        await page.getByRole("button", { name: "Trocar senha…" }).click();
        await page.getByLabel("Nova senha", { exact: true }).fill("curta");
        await shot(page, `dialogo-senha-${suffix}`, false);
        await page.keyboard.press("Escape");
        await page.getByRole("button", { name: "Gerar nova chave…" }).click();
        await page.getByLabel("Senha do projeto").fill(DEMO.projectPassword);
        await page.getByRole("button", { name: "Gerar nova chave", exact: true }).click();
        await page.getByRole("dialog", { name: "Guarde a nova chave de recuperação" }).waitFor();
        await shot(page, `dialogo-chave-${suffix}`, false);
        await page.getByRole("checkbox", { name: /Já guardei a nova chave/ }).click();
        await page.getByRole("button", { name: "Concluir" }).click();
        await page.getByRole("tab", { name: "Backup e salvamento", exact: true }).click();
        await page.getByRole("button", { name: "Fazer backup agora…" }).click();
        await shot(page, `dialogo-backup-${suffix}`, false);
        await page.getByLabel("Senha do projeto").fill(DEMO.projectPassword);
        await page.getByRole("button", { name: "Gerar backup" }).click();
        await page.getByRole("dialog", { name: "Backup pronto" }).waitFor({ timeout: 20_000 });
        await shot(page, `dialogo-backup-pronto-${suffix}`, false);
        await page.getByRole("button", { name: "Fechar" }).click();
        await shot(page, `backup-feito-${suffix}`);
        await page.getByRole("button", { name: "Verificar arquivo…" }).click();
        await shot(page, `dialogo-verificar-${suffix}`, false);
        await page.keyboard.press("Escape");
        await page.getByRole("button", { name: "Restaurar backup…" }).click();
        await shot(page, `dialogo-restaurar-${suffix}`, false);
        await page.keyboard.press("Escape");
        await page.getByRole("tab", { name: "Privacidade deste aparelho", exact: true }).click();
        await page.getByRole("button", { name: "Esquecer este aparelho…" }).click();
        await shot(page, `dialogo-esquecer-${suffix}`, false);
      });
    });
  }
}
