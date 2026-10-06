/**
 * The whole path through the real services (docs/18 W12): sign up, create a project, add an expense, reload,
 * unlock and see it; then, when the test owns the server's data dir (`build/real-data`), the files on its disk
 * are scanned for any plaintext the person typed (docs/19 §12: the server stores only ciphertext).
 *
 * Run with `pnpm --filter @opesvault/app e2e:real` (starts the server) or against a deployment with REAL_BASE_URL.
 */
import { expect, test, type Page } from "@playwright/test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const unique = Date.now().toString(36);
const EMAIL = `carla.${unique}@example.com`;
const ACCOUNT_PASSWORD = "senha-da-conta-bem-secreta";
const PROJECT_NAME = "Apartamento Zeppelin";
const PROJECT_PASSWORD = "senha do projeto bem secreta";
const MEMBER = "Davi Quixote";
const BANK = "Banco Zarathustra";
const EXPENSE = "Supermercado Orquidea Negra";

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? filesUnder(path) : [path];
  });
}

async function openFromList(page: Page): Promise<void> {
  await page.getByRole("button", { name: /^Projeto de / }).click();
  const dialog = page.getByRole("dialog", { name: /^Abrir / });
  await dialog.getByLabel("Senha do projeto").fill(PROJECT_PASSWORD);
  await dialog.getByRole("button", { name: "Abrir projeto" }).click();
  await expect(page).toHaveURL(/\/visao-geral$/, { timeout: 60_000 });
}

test("sign up, create a project, add an expense, reload, unlock and see it; the server holds only ciphertext", async ({
  page,
}) => {
  const problems: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") problems.push(`console: ${message.text()}`);
  });
  page.on("pageerror", (error) => problems.push(`pageerror: ${error.message}`));

  await page.goto("/");
  await expect(page).toHaveURL(/\/boas-vindas$/);
  await page.getByRole("button", { name: "Criar conta" }).click();
  await page.getByLabel("Seu nome").fill("Carla Lima");
  await page.getByLabel("E-mail").fill(EMAIL);
  await page.getByLabel("Senha da conta").fill(ACCOUNT_PASSWORD);
  await page.getByLabel("Confirme a senha").fill(ACCOUNT_PASSWORD);
  await page.getByRole("button", { name: "Criar conta" }).click();

  await expect(page.getByRole("heading", { name: "Novo projeto" })).toBeVisible();
  await page.getByLabel("Nome do projeto").fill(PROJECT_NAME);
  await page.getByLabel("Senha do projeto", { exact: true }).fill(PROJECT_PASSWORD);
  await page.getByLabel("Confirme a senha do projeto").fill(PROJECT_PASSWORD);
  await page.getByRole("button", { name: "Criar projeto" }).click();

  await expect(page.getByRole("heading", { name: "Guarde a chave de recuperação" })).toBeVisible();
  const recoveryKey = ((await page.getByLabel("Chave de recuperação", { exact: true }).textContent()) ?? "").replace(
    /\s/g,
    "",
  );
  expect(recoveryKey).toMatch(/^[A-Z0-9]{36}$/);
  await page.getByLabel("Guardei a chave de recuperação num lugar seguro").check();
  await page.getByRole("button", { name: "Continuar" }).click();

  await expect(page.getByRole("heading", { name: "Primeiros passos" })).toBeVisible();
  await page.getByLabel("Nome do integrante").fill(MEMBER);
  await page.getByRole("button", { name: "Adicionar", exact: true }).click();
  await page.getByRole("button", { name: "Próximo: Contas" }).click();
  await page.getByLabel("Nome da conta").fill(BANK);
  await page.getByLabel("Saldo hoje").fill("1.500,00");
  await page.getByRole("button", { name: "Próximo: Cartões" }).click();
  await page.getByRole("button", { name: "Próximo: Conclusão" }).click();
  await page.getByRole("button", { name: "Abrir o projeto" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Visão geral" })).toBeVisible();

  // In-app navigation: a page load would drop the keys and lock the project.
  // (The first-run assistant does not create the accounts it collects yet: docs/18 W12 open issue.)
  await page
    .getByRole("link", { name: /^Contas/ })
    .first()
    .click();
  await page.getByRole("tab", { name: "Todas as contas" }).click();
  await page.getByRole("button", { name: "Nova conta…" }).click();
  const account = page.getByRole("dialog", { name: "Nova conta" });
  await account.getByLabel(/^Nome\s*\*?$/).fill(BANK);
  await account.getByLabel("Saldo de abertura").fill("1.500,00");
  await account.getByRole("button", { name: "Salvar conta" }).click();
  await expect(account).toBeHidden();
  await page.getByRole("link", { name: "Livro financeiro", exact: true }).first().click();
  await expect(page).toHaveURL(/\/livro/);
  await page.getByRole("button", { name: "Novo lançamento" }).click();
  await page.getByRole("menuitem", { name: "Despesa", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Despesa" });
  await dialog.getByLabel("Descrição", { exact: true }).fill(EXPENSE);
  await dialog.getByLabel("Valor", { exact: true }).fill("123,45");
  await dialog.getByRole("button", { name: "Registrar", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator("[data-row-id]").filter({ hasText: EXPENSE })).toHaveCount(1);
  await expect(page.getByRole("status").filter({ hasText: "Sincronizado" })).toBeVisible({ timeout: 30_000 });

  // A reload drops every key from memory. The server session (cookie) is still valid, so the account comes back
  // without the account password; the project is closed and needs its own password.
  await page.reload();
  await expect(page).toHaveURL(/\/projetos$/, { timeout: 30_000 });
  await openFromList(page);
  await page.getByRole("link", { name: "Livro financeiro", exact: true }).first().click();
  await expect(page.locator("[data-row-id]").filter({ hasText: EXPENSE })).toHaveCount(1, { timeout: 30_000 });
  await expect(page.getByRole("status").filter({ hasText: "Sincronizado" })).toBeVisible({ timeout: 30_000 });

  // Locking and unlocking with the project password.
  await page.getByRole("button", { name: "Bloquear o projeto" }).click();
  await expect(page.getByRole("heading", { name: `${PROJECT_NAME} está bloqueado` })).toBeVisible();
  await page.getByLabel("Senha do projeto").fill(PROJECT_PASSWORD);
  await page.getByRole("button", { name: "Desbloquear" }).click();
  await expect(page.locator("[data-row-id]").filter({ hasText: EXPENSE })).toHaveCount(1, { timeout: 30_000 });

  // The same account on a clean browser context (no cache, no cookie): the data really lives on the server.
  const fresh = await page.context().browser()!.newContext({ ignoreHTTPSErrors: true, locale: "pt-BR" });
  const other = await fresh.newPage();
  await other.goto(new URL("/entrar", page.url()).href);
  await other.getByLabel("E-mail").fill(EMAIL);
  await other.getByLabel("Senha da conta").fill(ACCOUNT_PASSWORD);
  await other.getByRole("button", { name: "Entrar", exact: true }).click();
  await openFromList(other);
  await other.getByRole("link", { name: "Livro financeiro", exact: true }).first().click();
  await expect(other.locator("[data-row-id]").filter({ hasText: EXPENSE })).toHaveCount(1, { timeout: 30_000 });
  await fresh.close();

  expect(problems).toEqual([]);

  const dataDir = process.env["REAL_BASE_URL"] ? null : resolve("build/real-data");
  if (dataDir && existsSync(dataDir)) {
    const disk = filesUnder(dataDir)
      .filter((path) => !path.endsWith("secret"))
      .map((path) => readFileSync(path).toString("latin1"))
      .join("\n");
    expect(disk).toContain(EMAIL); // the account email is the one personal datum the server keeps (docs/19 §3)
    for (const plaintext of [
      PROJECT_NAME,
      "Zeppelin",
      MEMBER,
      "Quixote",
      BANK,
      "Zarathustra",
      EXPENSE,
      "Orquidea",
      "Supermercado",
      "Despesa",
      "123,45",
      ACCOUNT_PASSWORD,
      PROJECT_PASSWORD,
      recoveryKey,
      "Carla Lima",
      "Alimenta",
    ]) {
      expect(disk, `plaintext on the server's disk: ${plaintext}`).not.toContain(plaintext);
    }
  }
});
