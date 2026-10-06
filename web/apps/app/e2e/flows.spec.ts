/**
 * The flows before and around a project, end to end against the fake services: create an account, create a
 * project (recovery key shown once), the first-run assistant, lock and unlock, switch project, sign out.
 */
import { expect, test } from "@playwright/test";
import { DEMO, openDemo, watchErrors } from "./helpers.ts";

for (const viewport of [
  { width: 1280, height: 800 },
  { width: 390, height: 844 },
]) {
  test(`sign up, create a project, set it up, lock and unlock (${viewport.width})`, async ({ page }) => {
    await page.setViewportSize(viewport);
    const errors = watchErrors(page);
    await page.goto("/");
    await expect(page).toHaveURL(/\/boas-vindas$/);
    await page.getByRole("button", { name: "Criar conta" }).click();

    await page.getByLabel("Seu nome").fill("Carla Lima");
    await page.getByLabel("E-mail").fill("carla@example.com");
    await page.getByLabel("Senha da conta").fill("uma frase longa");
    const create = page.getByRole("button", { name: "Criar conta" });
    await page.getByLabel("Confirme a senha").fill("uma frase longX");
    await expect(page.getByText("As senhas não coincidem.")).toBeVisible();
    await expect(create).toBeDisabled();
    await page.getByLabel("Confirme a senha").fill("uma frase longa");
    await expect(create).toBeEnabled();
    await create.click();

    await expect(page.getByRole("heading", { name: "Novo projeto" })).toBeVisible();
    await page.getByLabel("Nome do projeto").fill("Apartamento");
    await page.getByLabel("Senha do projeto", { exact: true }).fill("senha do apartamento");
    await page.getByLabel("Confirme a senha do projeto").fill("senha do apartamento");
    await page.getByRole("button", { name: "Criar projeto" }).click();

    await expect(page.getByRole("heading", { name: "Guarde a chave de recuperação" })).toBeVisible();
    const key = await page.getByLabel("Chave de recuperação", { exact: true }).textContent();
    expect(key?.replace(/\s/g, "")).toMatch(/^[A-Z0-9]{32}$/);
    const proceed = page.getByRole("button", { name: "Continuar" });
    await expect(proceed).toBeDisabled();
    await page.getByLabel("Guardei a chave de recuperação num lugar seguro").check();
    await proceed.click();

    await expect(page.getByRole("heading", { name: "Primeiros passos" })).toBeVisible();
    await page.getByLabel("Nome do integrante").fill("Davi");
    await page.getByRole("button", { name: "Adicionar", exact: true }).click();
    await page.getByRole("button", { name: "Próximo: Contas" }).click();
    await page.getByLabel("Nome da conta").fill("Banco, corrente");
    await page.getByLabel("Saldo hoje").fill("1.500,00");
    await page.getByRole("button", { name: "Próximo: Cartões" }).click();
    await page.getByRole("button", { name: "Próximo: Conclusão" }).click();
    // A filled-in account counts without "Adicionar conta".
    await expect(page.locator("dd").nth(1)).toHaveText("1");
    await page.getByRole("button", { name: "Abrir o projeto" }).click();

    await expect(page).toHaveURL(/\/visao-geral$/);
    await expect(page.getByRole("heading", { level: 1, name: "Visão geral" })).toBeVisible();
    await expect(page.getByRole("status").filter({ hasText: "Sincronizado" })).toBeVisible();

    await page.getByRole("button", { name: "Bloquear o projeto" }).click();
    await expect(page.getByRole("heading", { name: "Apartamento está bloqueado" })).toBeVisible();
    await page.getByLabel("Senha do projeto").fill("errada errada");
    await page.getByRole("button", { name: "Desbloquear" }).click();
    await expect(page.getByText("Senha do projeto incorreta.")).toBeVisible();
    await page.getByLabel("Senha do projeto").fill("senha do apartamento");
    await page.getByRole("button", { name: "Desbloquear" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Visão geral" })).toBeVisible();
    expect(errors).toEqual([]);
  });
}

test("sign in, open the demo project with its password, switch project and sign out", async ({ page }) => {
  const errors = watchErrors(page);
  await page.goto("/visao-geral");
  await expect(page).toHaveURL(/\/entrar$/);
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await expect(page.getByText("Digite um e-mail válido.")).toBeVisible();
  await page.getByLabel("E-mail").fill(DEMO.email);
  await page.getByLabel("Senha da conta").fill("senha errada demais");
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await expect(page.getByText("E-mail ou senha não conferem.")).toBeVisible();
  await page.getByLabel("Senha da conta").fill(DEMO.password);
  await page.getByRole("button", { name: "Entrar", exact: true }).click();

  await page.getByRole("button", { name: /Casa/ }).click();
  const dialog = page.getByRole("dialog", { name: "Abrir Casa" });
  await dialog.getByLabel("Senha do projeto").fill("outra senha qualquer");
  await dialog.getByRole("button", { name: "Abrir projeto" }).click();
  await expect(dialog.getByText("Senha do projeto incorreta.")).toBeVisible();
  await dialog.getByLabel("Senha do projeto").fill(DEMO.projectPassword);
  await dialog.getByRole("button", { name: "Abrir projeto" }).click();
  await expect(page).toHaveURL(/\/visao-geral$/);

  // Attention counts are part of the link names.
  await expect(page.getByRole("link", { name: /^Importar e revisar, \d+ itens? pedem? atenção$/ })).toBeVisible();

  await page.getByRole("button", { name: "Conta de Ana Souza" }).click();
  await page.getByRole("menuitemradio", { name: "Bruno" }).click();
  await expect(page.getByText("Operando como Bruno")).toBeVisible();

  await page.getByRole("button", { name: "Conta de Ana Souza" }).click();
  await page.getByRole("menuitemradio", { name: "Escuro" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");

  await page.getByRole("button", { name: "Conta de Ana Souza" }).click();
  await page.getByRole("menuitem", { name: "Trocar de projeto" }).click();
  await expect(page).toHaveURL(/\/projetos$/);
  await page.getByRole("button", { name: "Sair da conta" }).click();
  await expect(page).toHaveURL(/\/boas-vindas$/);
  expect(errors).toEqual([]);
});

test("phone: bottom bar, Mais and dropped files", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openDemo(page, "/visao-geral");
  const bar = page.getByRole("navigation", { name: "Navegação principal" });
  await bar.getByRole("link", { name: "Livro" }).click();
  await expect(page).toHaveURL(/\/livro$/);
  await bar.getByRole("button", { name: /Mais seções/ }).click();
  await page.getByRole("dialog", { name: "Todas as seções" }).getByRole("link", { name: "Metas" }).click();
  await expect(page).toHaveURL(/\/metas$/);
  await expect(page.getByRole("dialog")).toHaveCount(0);

  const transfer = await page.evaluateHandle(() => {
    const data = new DataTransfer();
    data.items.add(new File(["x"], "extrato.csv", { type: "text/csv" }));
    return data;
  });
  await page.dispatchEvent("main", "dragover", { dataTransfer: transfer });
  await page.dispatchEvent("main", "drop", { dataTransfer: transfer });
  await expect(page).toHaveURL(/\/importar$/);
  await expect(page.getByRole("status").filter({ hasText: "1 arquivo recebido" })).toBeVisible();
});

test("offline is shown with text", async ({ page, context }) => {
  await openDemo(page, "/visao-geral");
  await context.setOffline(true);
  await expect(page.getByRole("status").filter({ hasText: "Sem conexão" })).toBeVisible();
  await context.setOffline(false);
  await expect(page.getByRole("status").filter({ hasText: "Sincronizado" })).toBeVisible();
});
