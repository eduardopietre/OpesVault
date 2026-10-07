/** The shell by keyboard only (docs/18 §5.1): skip link, sidebar, Alt+N, g + letter, Ctrl+K, F1, undo. */
import { expect, test } from "@playwright/test";
import { openDemo, watchErrors } from "./helpers.ts";

test.use({ viewport: { width: 1280, height: 800 } });

test("tab order starts with the skip link and reaches the sidebar", async ({ page }) => {
  await openDemo(page, "/visao-geral");
  await page.keyboard.press("Tab");
  const skip = page.getByRole("link", { name: "Pular para o conteúdo" });
  await expect(skip).toBeFocused();
  await expect(skip).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(page.locator("#conteudo")).toBeFocused();

  // Walking forward from the top reaches every sidebar link, each with a visible focus ring.
  await openDemo(page, "/visao-geral");
  const reached: string[] = [];
  for (let i = 0; i < 40; i++) {
    await page.keyboard.press("Tab");
    const info = await page.evaluate(() => {
      const element = document.activeElement as HTMLElement | null;
      if (!element) return null;
      const style = getComputedStyle(element);
      return {
        name: element.getAttribute("aria-label") ?? element.textContent?.trim() ?? "",
        nav: Boolean(element.closest("nav")),
        outline: style.outlineStyle !== "none" && style.outlineWidth !== "0px",
      };
    });
    if (info?.nav) {
      reached.push(info.name);
      expect(info.outline, `focus ring on ${info.name}`).toBe(true);
    }
  }
  expect(reached.some((name) => name.startsWith("Livro financeiro"))).toBe(true);
  expect(reached.some((name) => name.startsWith("Configurações"))).toBe(true);
});

test("Alt+number, g + letter and Enter on a sidebar link navigate", async ({ page }) => {
  const errors = watchErrors(page);
  await openDemo(page, "/visao-geral");
  await page.keyboard.press("Alt+2");
  await expect(page).toHaveURL(/\/orcamento$/);
  await expect(page.getByRole("heading", { level: 1, name: "Orçamento" })).toBeVisible();
  await page.keyboard.press("g");
  await page.keyboard.press("l");
  await expect(page).toHaveURL(/\/livro$/);
  await page.keyboard.press("g");
  await page.keyboard.press("f");
  await expect(page).toHaveURL(/\/configuracoes$/);
  await expect(page.getByRole("link", { name: "Configurações" })).toHaveAttribute("aria-current", "page");
  await page.getByRole("link", { name: "Metas" }).focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/metas$/);
  expect(errors).toEqual([]);
});

test("single-key sequences do not fire while typing", async ({ page }) => {
  await openDemo(page, "/visao-geral");
  await page.keyboard.press("Control+k");
  const input = page.getByRole("combobox", { name: "Buscar comando ou seção" });
  await input.pressSequentially("gl");
  await expect(page).toHaveURL(/\/visao-geral$/);
  await expect(input).toHaveValue("gl");
});

test("Ctrl+K finds a destination without accents and Enter goes there", async ({ page }) => {
  await openDemo(page, "/visao-geral");
  await page.keyboard.press("Control+k");
  const input = page.getByRole("combobox", { name: "Buscar comando ou seção" });
  await expect(input).toBeFocused();
  await input.fill("orcamento");
  await expect(page.getByRole("option", { name: /Orçamento/ })).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/orcamento$/);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  // Focus goes back to the page, not lost.
  await expect(page.locator("body")).not.toBeFocused();
});

test("F1 opens the help of the screen and Escape returns focus", async ({ page }) => {
  await openDemo(page, "/livro");
  const help = page.getByRole("button", { name: "Ajuda desta tela" });
  await help.focus();
  await page.keyboard.press("F1");
  const dialog = page.getByRole("dialog", { name: "Ajuda: Livro financeiro" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText("⌘K")).toBeVisible();
  await expect(dialog.getByText("Buscar nos lançamentos")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(help).toBeFocused();
});

test("? opens the keyboard shortcuts, but not while typing", async ({ page }) => {
  const errors = watchErrors(page);
  await openDemo(page, "/livro");
  // typing "?" in a field is text, not a shortcut
  const search = page.getByRole("searchbox", { name: "Buscar lançamentos" });
  await search.focus();
  await page.keyboard.type("?");
  await expect(page.getByRole("dialog", { name: "Atalhos de teclado" })).toHaveCount(0);
  await expect(search).toHaveValue("?");
  await search.fill("");
  await page.locator("#conteudo").focus();
  await page.keyboard.press("Shift+?");
  const sheet = page.getByRole("dialog", { name: "Atalhos de teclado" });
  await expect(sheet).toBeVisible();
  await expect(sheet.getByText("Ctrl+Shift+L")).toBeVisible();
  await expect(sheet.getByText("Ctrl+Y")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(sheet).toHaveCount(0);
  // the shortcuts are also in the buttons' tooltips
  await expect(page.getByRole("button", { name: "Bloquear o projeto" })).toHaveAttribute(
    "title",
    "Bloquear o projeto (Ctrl+Shift+L)",
  );
  expect(errors).toEqual([]);
});

test("Ctrl+Z and Ctrl+Shift+Z reach the undo context", async ({ page }) => {
  await openDemo(page, "/livro");
  await page.locator("#conteudo").focus();
  await page.keyboard.press("Control+z");
  await expect(page.getByRole("status").filter({ hasText: "Nada a desfazer." })).toBeVisible();
  await page.keyboard.press("Control+Shift+z");
  await expect(page.getByRole("status").filter({ hasText: "Nada a refazer." })).toBeVisible();
});

test("Ctrl+Shift+B collapses the sidebar into an icon rail that keeps names", async ({ page }) => {
  await openDemo(page, "/visao-geral");
  await page.locator("#conteudo").focus();
  await page.keyboard.press("Control+Shift+b");
  const link = page.getByRole("link", { name: "Orçamento" });
  await expect(link).toBeVisible();
  await expect(page.getByRole("button", { name: "Expandir barra lateral" })).toBeVisible();
  await page.keyboard.press("Control+Shift+b");
  await expect(page.getByRole("button", { name: "Recolher barra lateral" })).toBeVisible();
});
