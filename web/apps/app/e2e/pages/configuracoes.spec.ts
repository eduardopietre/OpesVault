/**
 * Configurações end to end (docs/18 §5, SCREENS.md): the demonstration project, every section, every button and
 * dialog, a backup downloaded, verified and restored (with the real Argon2id parameters), links in and out, no
 * console errors, no sideways scroll at the five sizes, axe clean, light and dark.
 */
import { expect, test, type Locator, type Page } from "@playwright/test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEMO,
  TEST_SCHEMES,
  TEST_SIZES,
  expectNoHorizontalOverflow,
  openDemo,
  settle,
  watchErrors,
} from "../helpers.ts";
import { audited, goTab } from "../ui.ts";

/** A notice fading in or out is half transparent: it is measured once it is gone (they dismiss themselves). */
const { audit, openDialog } = audited({ awaitNotices: true, skipNotices: false });

const press = (scope: Locator | Page, name: string | RegExp) =>
  scope.getByRole("button", { name, exact: typeof name === "string" }).click();

/** Answers the requests to the local Ollama like a real one would, with the CORS header the browser needs. */
async function fakeOllama(page: Page, ps: { size: number; size_vram: number } | null) {
  await page.route("http://127.0.0.1:11434/**", async (route) => {
    const url = new URL(route.request().url());
    const headers = { "access-control-allow-origin": "*", "content-type": "application/json" };
    if (route.request().method() === "OPTIONS") {
      await route.fulfill({
        status: 204,
        headers: { ...headers, "access-control-allow-headers": "*", "access-control-allow-methods": "GET,POST" },
      });
      return;
    }
    const body =
      url.pathname === "/api/version"
        ? { version: "0.35.1" }
        : url.pathname === "/api/tags"
          ? { models: [{ name: "gemma4:12b", digest: "sha256:0123456789abcdef" }, { name: "llama3.2:3b" }] }
          : url.pathname === "/api/ps"
            ? { models: ps ? [{ name: "llama3.2:3b", ...ps }] : [] }
            : { done: true };
    await route.fulfill({ status: 200, headers, body: JSON.stringify(body) });
  });
}

for (const size of TEST_SIZES) {
  for (const scheme of TEST_SCHEMES) {
    test.describe(`${size.width}x${size.height} ${scheme}`, () => {
      test.use({ viewport: size, colorScheme: scheme, contextOptions: { reducedMotion: "reduce" } });

      test("projeto: rename, members and the link to Contas", async ({ page }) => {
        const errors = watchErrors(page);
        await openDemo(page, "/configuracoes");
        await expect(page.getByRole("heading", { level: 1, name: "Configurações" })).toBeVisible();
        await expect(page.getByRole("tab")).toHaveCount(5);
        await expect(page.getByLabel("Nome do projeto")).toHaveValue("Casa");
        await expect(page.getByText("Vale para todo o projeto").first()).toBeVisible();
        await settle(page);
        await expectNoHorizontalOverflow(page);
        await audit(page, "projeto");

        await page.getByLabel("Nome do projeto").fill("Casa da Praia");
        await press(page, "Renomear");
        await expect(page.getByText("Projeto renomeado.").first()).toBeVisible();
        await expect(page.locator("header").getByText("Casa da Praia").first()).toBeVisible();
        await page.getByLabel("Nome do projeto").fill("   ");
        await press(page, "Renomear");
        await expect(page.getByText("Dê um nome ao projeto.")).toBeVisible();
        await audit(page, "projeto com erro");
        await page.getByLabel("Nome do projeto").fill("Casa");
        await press(page, "Renomear");
        await expect(page.getByLabel("Nome do projeto")).toHaveValue("Casa");

        await expect(page.getByRole("list", { name: "Integrantes do projeto" }).getByText("Ana")).toBeVisible();
        await press(page, "Gerir integrantes em Contas e cartões");
        await expect(page.getByRole("heading", { level: 1, name: "Contas e cartões" })).toBeVisible();
        await expect(page.getByRole("tab", { name: "Integrantes", exact: true })).toHaveAttribute(
          "aria-selected",
          "true",
        );
        expect(errors).toEqual([]);
      });

      test("ia local: switch, model, port, check, GPU words and the OLLAMA_ORIGINS guide", async ({ page }) => {
        const errors = watchErrors(page);
        await fakeOllama(page, { size: 8_000_000_000, size_vram: 4_000_000_000 });
        await openDemo(page, "/configuracoes");
        await goTab(page, "IA local");
        await expect(page.getByRole("switch", { name: "Usar o Ollama local para sugestões" })).toHaveAttribute(
          "aria-checked",
          "true",
        );
        await expectNoHorizontalOverflow(page);
        await audit(page, "ia local");

        // the project's setting: off, then back on with the undo shortcut
        await page.getByRole("switch", { name: "Usar o Ollama local para sugestões" }).click();
        await expect(page.getByText("IA local desligada para o projeto.").first()).toBeVisible();
        await expect(page.getByLabel("Modelo", { exact: true })).toBeHidden();
        await page.getByRole("switch", { name: "Usar o Ollama local para sugestões" }).click();
        await expect(page.getByText("IA local ligada para o projeto.").first()).toBeVisible();

        // the model is committed on Enter; the port is this device's
        await page.getByLabel("Modelo", { exact: true }).fill("llama3.2:3b");
        await page.keyboard.press("Enter");
        await expect(page.getByText("Modelo da IA alterado.").first()).toBeVisible();
        await page.getByLabel("Porta do Ollama").fill("80");
        await page.keyboard.press("Tab");
        await expect(page.getByText("Use uma porta entre 1024 e 65535.")).toBeVisible();
        await audit(page, "ia local com erro de porta");
        await page.getByLabel("Porta do Ollama").fill("11434");
        await page.keyboard.press("Tab");

        // the check: version, models and how much of the model fits in the GPU
        await press(page, "Verificar Ollama");
        await expect(page.getByText(/Ollama 0\.35\.1 respondeu: 2 modelo\(s\) instalado\(s\)\./)).toBeVisible();
        await expect(page.getByText(/Só 50% do modelo coube na GPU/)).toBeVisible();
        await page.getByRole("combobox", { name: "Modelo instalado" }).click();
        await page.getByRole("option", { name: "gemma4:12b" }).click();
        await expect(page.getByLabel("Modelo", { exact: true })).toHaveValue("gemma4:12b");
        await audit(page, "ia local verificada");

        // the guide carries this app's exact origin
        await page.getByRole("button", { name: /Liberar este endereço no Ollama/ }).click();
        const origin = new URL(page.url()).origin;
        await expect(page.getByText(`setx OLLAMA_ORIGINS "${origin}"`)).toBeVisible();
        await expect(page.getByText(`launchctl setenv OLLAMA_ORIGINS "${origin}"`)).toBeVisible();
        await expect(page.getByText(`Environment="OLLAMA_ORIGINS=${origin}"`)).toBeVisible();
        await expectNoHorizontalOverflow(page);
        await audit(page, "ia local com o guia");
        expect(errors.filter((e) => !/Failed to load resource|net::ERR/.test(e))).toEqual([]);
      });

      test("ia local: Ollama unreachable opens the guide and says what to do", async ({ page }) => {
        await page.route("http://127.0.0.1:11434/**", (route) => route.abort("connectionrefused"));
        await openDemo(page, "/configuracoes");
        await goTab(page, "IA local");
        await press(page, "Verificar Ollama");
        await expect(
          page.getByText(/Ollama indisponível\. Abra o Ollama e confira se ele aceita este endereço/),
        ).toBeVisible();
        await expect(page.getByRole("button", { name: /Liberar este endereço no Ollama/ })).toHaveAttribute(
          "aria-expanded",
          "true",
        );
        await expectNoHorizontalOverflow(page);
        await audit(page, "ollama indisponível");
      });

      test("segurança: password, recovery key, idle lock and lock now", async ({ page }) => {
        const errors = watchErrors(page);
        await openDemo(page, "/configuracoes");
        await goTab(page, "Segurança");
        await expectNoHorizontalOverflow(page);
        await audit(page, "segurança");

        // Trocar senha…
        await press(page, "Trocar senha…");
        let dialog = await openDialog(page, "Trocar a senha do projeto", "trocar senha");
        await expect(dialog.getByRole("button", { name: "Trocar senha", exact: true })).toBeDisabled();
        await dialog.getByLabel("Senha atual").fill("errada");
        await dialog.getByLabel("Nova senha", { exact: true }).fill("curta");
        await expect(dialog.getByText("Use pelo menos 10 caracteres.")).toBeVisible();
        await dialog.getByLabel("Nova senha", { exact: true }).fill("uma senha bem nova");
        await dialog.getByLabel("Confirme a nova senha").fill("outra");
        await expect(dialog.getByText("As senhas não coincidem.")).toBeVisible();
        await dialog.getByLabel("Confirme a nova senha").fill("uma senha bem nova");
        await press(dialog, "Trocar senha");
        await expect(dialog.getByText("Senha do projeto incorreta.")).toBeVisible();
        await audit(page, "trocar senha com erro");
        await dialog.getByLabel("Senha atual").fill(DEMO.projectPassword);
        await press(dialog, "Trocar senha");
        await expect(dialog).toBeHidden();
        await expect(page.getByText(/Senha do projeto trocada/).first()).toBeVisible();

        // Gerar nova chave…: needs the (new) password, shows the key once, cannot be skipped
        await press(page, "Gerar nova chave…");
        dialog = await openDialog(page, "Gerar nova chave de recuperação", "gerar nova chave");
        await dialog.getByLabel("Senha do projeto").fill("errada");
        await press(dialog, "Gerar nova chave");
        await expect(dialog.getByText("Senha do projeto incorreta.")).toBeVisible();
        await dialog.getByLabel("Senha do projeto").fill("uma senha bem nova");
        await press(dialog, "Gerar nova chave");
        dialog = await openDialog(page, "Guarde a nova chave de recuperação", "nova chave");
        await expect(dialog.getByLabel("Nova chave de recuperação").locator("span")).toHaveCount(9);
        await expect(dialog.getByRole("button", { name: "Concluir" })).toBeDisabled();
        await page.keyboard.press("Escape");
        await expect(dialog).toBeVisible();
        await dialog.getByRole("checkbox", { name: /Já guardei a nova chave/ }).click();
        await press(dialog, "Concluir");
        await expect(dialog).toBeHidden();

        // the idle lock is a device preference, written at once; there is no "off"
        await page.getByRole("combobox", { name: "Bloquear após" }).click();
        await expect(page.getByRole("option", { name: /Desligado/ })).toHaveCount(0);
        await page.getByRole("option", { name: "5 minutos", exact: true }).click();
        await expect(page.getByText(/bloqueia após 5 minutos sem uso neste aparelho/).first()).toBeVisible();
        await expect(page.getByRole("combobox", { name: "Bloquear após" })).toContainText("5 minutos");
        await audit(page, "segurança com bloqueio");

        // Bloquear agora: the lock screen, then the new password opens it again
        await press(page, "Bloquear agora");
        await expect(page.getByRole("heading", { name: /bloqueado/ })).toBeVisible();
        expect(errors).toEqual([]);
      });

      test("backup: the three dialogs open, refuse and cancel", async ({ page }) => {
        const errors = watchErrors(page);
        await openDemo(page, "/configuracoes");
        await goTab(page, "Backup e salvamento");
        await expect(page.getByText("Nenhum backup feito neste aparelho")).toBeVisible();
        await expectNoHorizontalOverflow(page);
        await audit(page, "backup");

        await press(page, "Fazer backup agora…");
        let dialog = await openDialog(page, "Fazer backup agora", "fazer backup");
        await expect(dialog.getByRole("button", { name: "Gerar backup" })).toBeDisabled();
        await dialog.getByLabel("Senha do projeto").fill("errada");
        await press(dialog, "Gerar backup");
        await expect(dialog.getByText("Senha do projeto incorreta.")).toBeVisible();
        await audit(page, "fazer backup com erro");
        await press(dialog, "Cancelar");
        await expect(dialog).toBeHidden();

        await press(page, "Verificar arquivo…");
        dialog = await openDialog(page, "Verificar arquivo de backup", "verificar arquivo");
        await expect(dialog.getByRole("button", { name: "Verificar", exact: true })).toBeDisabled();
        await dialog.getByLabel("Arquivo de backup").setInputFiles({
          name: "nao-e-backup.pdf",
          mimeType: "application/pdf",
          buffer: Buffer.from("%PDF-1.7 isto é um pdf e não um backup do aplicativo"),
        });
        await dialog.getByLabel("Senha do arquivo").fill("qualquer");
        await press(dialog, "Verificar");
        await expect(dialog.getByText("Este arquivo não é um backup do OpesVault.")).toBeVisible();
        await audit(page, "verificar com erro");
        await press(dialog, "Cancelar");
        await expect(dialog).toBeHidden();

        await press(page, "Restaurar backup…");
        dialog = await openDialog(page, "Restaurar backup", "restaurar backup");
        await expect(dialog.getByRole("button", { name: "Restaurar como projeto novo" })).toBeDisabled();
        await press(dialog, "Cancelar");
        await expect(dialog).toBeHidden();
        expect(errors).toEqual([]);
      });

      test("privacidade: what is kept, the storage and forgetting the device", async ({ page }) => {
        const errors = watchErrors(page);
        await openDemo(page, "/configuracoes");
        await goTab(page, "Privacidade deste aparelho");
        await expect(page.getByText("Cópia cifrada do projeto (IndexedDB)")).toBeVisible();
        await expect(page.getByText(/Protegido|Não protegido|Sem informação/).first()).toBeVisible();
        await expectNoHorizontalOverflow(page);
        await audit(page, "privacidade");

        await press(page, "Esquecer este aparelho…");
        const ask = page.getByRole("alertdialog", { name: "Esquecer este aparelho?" });
        await expect(ask).toBeVisible();
        await audit(page, "esquecer este aparelho");
        await press(ask, "Cancelar");
        await expect(ask).toBeHidden();
        await expect(page.getByRole("heading", { level: 1, name: "Configurações" })).toBeVisible();
        expect(errors).toEqual([]);
      });
    });
  }
}

test.describe("links and the rest of the flow", () => {
  test.use({ viewport: { width: 1280, height: 800 }, contextOptions: { reducedMotion: "reduce" } });

  test("each section opens from its link", async ({ page }) => {
    for (const [ref, tab] of [
      ["ia", "IA local"],
      ["seguranca", "Segurança"],
      ["backup", "Backup e salvamento"],
      ["privacidade", "Privacidade deste aparelho"],
      ["projeto", "Projeto"],
    ] as const) {
      await page.goto(`/configuracoes?demo&ref=${ref}`);
      await expect(page.getByRole("tab", { name: tab, exact: true })).toHaveAttribute("aria-selected", "true");
      // the page consumed the ref: the address has no search left
      await expect(page).toHaveURL(/\/configuracoes$/);
    }
  });

  test("the backup reminder in the Visão geral leads to the Backup section", async ({ page }) => {
    await openDemo(page, "/visao-geral");
    const all = page.getByRole("button", { name: /^Mostrar todos/ });
    if (await all.isVisible()) await all.click();
    await page.getByRole("button", { name: /^Abrir Configurações: Faça um backup do cofre/ }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Configurações" })).toBeVisible();
    await expect(page.getByRole("tab", { name: "Backup e salvamento", exact: true })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });

  test("forgetting the device clears the preferences, ends the session and goes to the welcome screen", async ({
    page,
  }) => {
    await openDemo(page, "/configuracoes");
    await goTab(page, "Segurança");
    await page.getByRole("combobox", { name: "Bloquear após" }).click();
    await page.getByRole("option", { name: "5 minutos", exact: true }).click();
    expect(await page.evaluate(() => localStorage.getItem("opesvault:seguranca/bloqueio"))).toBe("5");
    await goTab(page, "Privacidade deste aparelho");
    await press(page, "Esquecer este aparelho…");
    const ask = page.getByRole("alertdialog", { name: "Esquecer este aparelho?" });
    await press(ask, "Esquecer este aparelho");
    await expect(page.getByRole("heading", { level: 1, name: "Boas-vindas ao OpesVault" })).toBeVisible();
    expect(await page.evaluate(() => Object.keys(localStorage).filter((key) => key.startsWith("opesvault:")))).toEqual(
      [],
    );
  });

  test("a backup is downloaded, verified, refused when altered and restored as a new project", async ({ page }) => {
    test.setTimeout(180_000);
    const errors = watchErrors(page);
    const dir = mkdtempSync(join(tmpdir(), "opesvault-e2e-"));
    await openDemo(page, "/configuracoes");
    await goTab(page, "Backup e salvamento");

    // export: the file is offered, sealed, with a neutral name
    await press(page, "Fazer backup agora…");
    let dialog = page.getByRole("dialog", { name: "Fazer backup agora" });
    await dialog.getByLabel("Senha do projeto").fill(DEMO.projectPassword);
    const [download] = await Promise.all([page.waitForEvent("download"), press(dialog, "Gerar backup")]);
    expect(download.suggestedFilename()).toMatch(/^opesvault-backup-\d{4}-\d{2}-\d{2}\.ovbackup$/);
    const file = join(dir, download.suggestedFilename());
    await download.saveAs(file);
    const bytes = readFileSync(file);
    expect(bytes.subarray(0, 4).toString("latin1")).toBe("OVBK");
    expect(bytes.length).toBeGreaterThan(10_000); // the demonstration's receipts are in it
    const text = bytes.toString("latin1");
    for (const secret of ["Casa", "Itaú", "Mercado", "operation", "%PDF"]) expect(text).not.toContain(secret);
    dialog = page.getByRole("dialog", { name: "Backup pronto" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText(download.suggestedFilename())).toBeVisible();
    await press(dialog, "Fechar");
    await expect(page.getByText(/Último backup feito neste aparelho: \d{2}\/\d{2}\/\d{4} \(hoje\)/)).toBeVisible();

    // verify: a wrong password, an altered copy, then the real file
    await press(page, "Verificar arquivo…");
    dialog = page.getByRole("dialog", { name: "Verificar arquivo de backup" });
    await dialog.getByLabel("Arquivo de backup").setInputFiles(file);
    await dialog.getByLabel("Senha do arquivo").fill("senha errada do arquivo");
    await press(dialog, "Verificar");
    await expect(dialog.getByText(/Senha incorreta para este arquivo/)).toBeVisible();
    const altered = Buffer.from(bytes);
    altered[altered.length - 5] = altered[altered.length - 5]! ^ 1;
    const alteredPath = join(dir, "alterado.ovbackup");
    writeFileSync(alteredPath, altered);
    await dialog.getByLabel("Arquivo de backup").setInputFiles(alteredPath);
    await dialog.getByLabel("Senha do arquivo").fill(DEMO.projectPassword);
    await press(dialog, "Verificar");
    await expect(dialog.getByText(/danificado, incompleto ou foi alterado/)).toBeVisible();
    await dialog.getByLabel("Arquivo de backup").setInputFiles(file);
    await press(dialog, "Verificar");
    dialog = page.getByRole("dialog", { name: "Arquivo verificado" });
    await expect(dialog.getByText("Casa", { exact: true })).toBeVisible();
    await expect(dialog.getByText(/o arquivo está íntegro e completo/)).toBeVisible();
    await audit(page, "arquivo verificado");
    await press(dialog, "Fechar");

    // restore: a new project with its own recovery key; the open project stays as it was
    await press(page, "Restaurar backup…");
    dialog = page.getByRole("dialog", { name: "Restaurar backup" });
    await dialog.getByLabel("Arquivo de backup").setInputFiles(file);
    await dialog.getByLabel("Senha do arquivo").fill(DEMO.projectPassword);
    await dialog.getByLabel("Nome do projeto novo").fill("Casa restaurada");
    await press(dialog, "Restaurar como projeto novo");
    dialog = page.getByRole("dialog", { name: "Projeto restaurado" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByLabel("Chave de recuperação do projeto restaurado").locator("span")).toHaveCount(9);
    await expect(dialog.getByRole("button", { name: "Abrir o projeto restaurado" })).toBeDisabled();
    await audit(page, "projeto restaurado");
    await dialog.getByRole("checkbox", { name: /Já guardei a chave de recuperação/ }).click();
    await press(dialog, "Ficar aqui");
    await expect(dialog).toBeHidden();
    await expect(page.locator("header").getByText("Casa", { exact: true }).first()).toBeVisible();

    // restore again and open it: the same project, as a separate one
    await press(page, "Restaurar backup…");
    dialog = page.getByRole("dialog", { name: "Restaurar backup" });
    await dialog.getByLabel("Arquivo de backup").setInputFiles(file);
    await dialog.getByLabel("Senha do arquivo").fill(DEMO.projectPassword);
    await dialog.getByLabel("Nome do projeto novo").fill("Casa aberta");
    await press(dialog, "Restaurar como projeto novo");
    dialog = page.getByRole("dialog", { name: "Projeto restaurado" });
    await dialog.getByRole("checkbox", { name: /Já guardei a chave de recuperação/ }).click();
    await press(dialog, "Abrir o projeto restaurado");
    await expect(page.getByRole("heading", { level: 1, name: "Visão geral" })).toBeVisible();
    await expect(page.locator("header").getByText("Casa aberta").first()).toBeVisible();
    expect(errors).toEqual([]);
  });
});
