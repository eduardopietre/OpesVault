/**
 * The main flows with the keyboard only (docs/18 §5.1, docs/16 §8; WCAG 2.1.1, 2.4.3, 2.4.7): sign in, open the
 * demonstration project, move between sections (Alt+number, `g` + letter), create an expense in the Livro,
 * approve an import item, pay a bill, undo and redo, run a command of the palette, lock and unlock. No pointer is
 * used after the page opens. Every Tab stop must show a focus ring, focus must never be lost to the document body,
 * and after a dialog closes focus returns to what opened it.
 */
import { expect, test, type Page } from "@playwright/test";
import { DEMO, watchErrors } from "./helpers.ts";

interface Focus {
  name: string;
  role: string;
  tag: string;
  id: string;
  ring: boolean;
  focusVisible: boolean;
  inView: boolean;
}

/** What has focus now (null when it is the document body or nothing). */
async function focusOf(page: Page): Promise<Focus | null> {
  return page.evaluate(() => {
    const element = document.activeElement as HTMLElement | null;
    if (!element || element === document.body || element === document.documentElement) return null;
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    const labels = (element as HTMLInputElement).labels;
    // Text a screen reader reads: what is hidden from it (icons, avatars) does not count.
    const clone = element.cloneNode(true) as HTMLElement;
    clone.querySelectorAll('[aria-hidden="true"], svg').forEach((hidden) => hidden.remove());
    const name = (
      element.getAttribute("aria-label") ??
      labels?.[0]?.textContent ??
      clone.textContent ??
      element.getAttribute("placeholder") ??
      element.getAttribute("title") ??
      ""
    )
      .replace(/\s+/g, " ")
      .trim();
    // A ring is an outline, or a box-shadow with a visible color (the fields draw theirs as a ring).
    const outline = style.outlineStyle !== "none" && style.outlineWidth !== "0px";
    const shadow = style.boxShadow
      .split(/,(?![^(]*\))/)
      .some((part) => part.trim() !== "none" && !/rgba\(0, 0, 0, 0\)/.test(part) && !/ 0px 0px 0px 0px/.test(part));
    return {
      name,
      role: element.getAttribute("role") ?? "",
      tag: element.tagName.toLowerCase(),
      id: element.id,
      // A menu entry or a list option shows focus as a highlighted row (Radix marks it), not as a ring.
      ring:
        outline ||
        shadow ||
        (element.hasAttribute("data-highlighted") && /^menuitem|^option$/.test(element.getAttribute("role") ?? "")),
      focusVisible: element.matches(":focus-visible"),
      inView:
        rect.width > 0 &&
        rect.height > 0 &&
        rect.bottom > 0 &&
        rect.right > 0 &&
        rect.top < innerHeight &&
        rect.left < innerWidth,
    };
  });
}

/**
 * Focus is on something that shows it (the page's main area, focused after a navigation, is the one exception:
 * it is a target, not a control).
 */
async function expectFocusVisible(page: Page, where: string): Promise<Focus> {
  const focus = await focusOf(page);
  expect(focus, `${where}: focus fell to the document body`).not.toBeNull();
  const info = focus as Focus;
  if (info.id === "conteudo") return info;
  expect(info.focusVisible, `${where}: "${info.name}" has focus without :focus-visible`).toBe(true);
  expect(info.ring, `${where}: "${info.name}" (${info.tag}) shows no focus ring`).toBe(true);
  expect(info.inView, `${where}: "${info.name}" is focused out of view`).toBe(true);
  return info;
}

/** Presses Tab until the focused control's name matches, checking the ring on every stop. */
async function tabTo(page: Page, name: RegExp | string | ((focus: Focus) => boolean), max = 80): Promise<Focus> {
  const seen: string[] = [];
  for (let step = 0; step < max; step++) {
    await page.keyboard.press("Tab");
    const info = await expectFocusVisible(page, `Tab stop ${step + 1} after ${seen.at(-1) ?? "start"}`);
    seen.push(info.name);
    if (
      typeof name === "function" ? name(info) : typeof name === "string" ? info.name === name : name.test(info.name)
    ) {
      return info;
    }
  }
  throw new Error(`Tab never reached ${String(name)}; stops: ${seen.join(" | ")}`);
}

/** Moves with the arrow keys to an entry of a menu or tab list and checks the focus ring on each. */
async function arrowTo(page: Page, key: string, name: RegExp | string, max = 12): Promise<void> {
  for (let step = 0; step < max; step++) {
    const info = await expectFocusVisible(page, `after ${key}`);
    if (typeof name === "string" ? info.name === name : name.test(info.name)) return;
    await page.keyboard.press(key);
    // Focus moves on the next task: wait for it instead of reading the control we just left.
    await expect.poll(async () => (await focusOf(page))?.name, { timeout: 2000 }).not.toBe(info.name);
  }
  throw new Error(`${key} never reached ${String(name)}`);
}

async function expectFocusOn(page: Page, name: RegExp | string, where: string): Promise<void> {
  await expect
    .poll(async () => (await focusOf(page))?.name ?? null, {
      message: `${where}: focus should return to ${String(name)}`,
    })
    .toMatch(typeof name === "string" ? new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`) : name);
  await expectFocusVisible(page, where);
}

const notice = (page: Page, text: string | RegExp) => page.getByRole("status").filter({ hasText: text }).first();

test.describe("keyboard only", () => {
  test.use({ viewport: { width: 1280, height: 800 }, contextOptions: { reducedMotion: "reduce" } });

  test("sign in, open the project (and cancel once), sections, expense, import, bill, undo, palette, lock", async ({
    page,
  }) => {
    test.setTimeout(180_000);
    const errors = watchErrors(page);

    // ── sign in ───────────────────────────────────────────────────────────────
    await page.goto("/");
    await expect(page).toHaveURL(/\/boas-vindas$/);
    await tabTo(page, /^Entrar/);
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/entrar$/);
    const email = await expectFocusVisible(page, "sign-in form");
    expect(email.name).toMatch(/E-mail/);
    await page.keyboard.type(DEMO.email);
    await page.keyboard.press("Tab");
    await expect.poll(async () => (await focusOf(page))?.name).toMatch(/Senha da conta/);
    await page.keyboard.type("senha errada demais");
    await page.keyboard.press("Enter");
    await expect(page.getByText("E-mail ou senha não conferem.")).toBeVisible();
    await page.keyboard.press("Control+a");
    await page.keyboard.type(DEMO.password);
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/projetos$/);

    // ── TA-03: a cancelled password opens nothing and focus goes back to the project ──
    await expect(page.getByRole("button", { name: /^Casa/ })).toBeVisible();
    await tabTo(page, /^Casa/);
    await page.keyboard.press("Enter");
    const open = page.getByRole("dialog", { name: "Abrir Casa" });
    await expect(open).toBeVisible();
    await expect.poll(async () => (await focusOf(page))?.name).toMatch(/Senha do projeto/);
    await page.keyboard.press("Escape");
    await expect(open).toHaveCount(0);
    await expectFocusOn(page, /^Casa/, "after cancelling the password");
    await expect(page).toHaveURL(/\/projetos$/);

    // ── open it with the password ────────────────────────────────────────────
    await page.keyboard.press("Enter");
    await expect(open).toBeVisible();
    await page.keyboard.type("outra senha qualquer");
    await page.keyboard.press("Enter");
    await expect(open.getByText("Senha do projeto incorreta.")).toBeVisible();
    await page.keyboard.press("Control+a");
    await page.keyboard.type(DEMO.projectPassword);
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/visao-geral$/);
    await expect(page.getByRole("heading", { level: 1, name: "Visão geral" })).toBeVisible();
    await expect.poll(async () => (await focusOf(page)) !== null, { message: "focus after opening" }).toBe(true);

    // ── sections: Alt+number and g + letter ──────────────────────────────────
    await page.locator("#conteudo").focus();
    await page.keyboard.press("Alt+2");
    await expect(page).toHaveURL(/\/orcamento$/);
    await page.keyboard.press("g");
    await page.keyboard.press("l");
    await expect(page).toHaveURL(/\/livro$/);
    await expect(page.getByRole("heading", { level: 1, name: "Livro financeiro" })).toBeVisible();
    await expect
      .poll(async () => (await focusOf(page)) !== null, { message: "focus after a section change" })
      .toBe(true);

    // ── an expense in the Livro ──────────────────────────────────────────────
    const trigger = await tabTo(page, /^Novo lançamento/);
    expect(trigger.name).toMatch(/^Novo lançamento/);
    await page.keyboard.press("Enter");
    await expect(page.getByRole("menu")).toBeVisible();
    await arrowTo(page, "ArrowDown", "Despesa");
    await page.keyboard.press("Enter");
    const dialog = page.getByRole("dialog", { name: "Despesa" });
    await expect(dialog).toBeVisible();
    await expectFocusVisible(page, "expense dialog");
    await dialog.getByLabel("Descrição", { exact: true }).focus();
    await page.keyboard.type("Livraria pelo teclado");
    await tabTo(page, /^Valor/);
    await page.keyboard.type("89,90");
    await page.keyboard.press("Enter");
    await expect(dialog).toHaveCount(0);
    await expectFocusOn(page, /^Novo lançamento/, "after the expense dialog");

    // ── undo and redo ────────────────────────────────────────────────────────
    await page.keyboard.press("Control+z");
    await expect(notice(page, /Desfeito/)).toBeVisible();
    await page.keyboard.press("Control+Shift+z");
    await expect(notice(page, /Refeito/)).toBeVisible();
    await expectFocusVisible(page, "after undo and redo");

    // ── approve an import item ───────────────────────────────────────────────
    await page.keyboard.press("Alt+5");
    await expect(page).toHaveURL(/\/importar$/);
    await expect(page.getByRole("heading", { level: 1, name: "Importar e revisar" })).toBeVisible();
    await tabTo(page, /^Itens extraídos/);
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Control+Enter");
    // A partial approval asks for its reason; the dialog is answered by keyboard too.
    const reason = page.getByRole("dialog", { name: "Aprovação parcial" });
    await expect(reason).toBeVisible();
    await expectFocusVisible(page, "approval reason dialog");
    await page.keyboard.type("Conferi este item pelo teclado");
    await page.keyboard.press("Enter");
    await expect(reason).toHaveCount(0);
    await expect(notice(page, /operação\(ões\) criada\(s\)/)).toBeVisible();
    await expectFocusVisible(page, "after approving");

    // ── pay a bill ───────────────────────────────────────────────────────────
    await page.keyboard.press("g");
    await page.keyboard.press("a");
    await expect(page).toHaveURL(/\/contas$/);
    await expect(page.getByRole("heading", { level: 1, name: "Contas e cartões" })).toBeVisible();
    await tabTo(page, (focus) => focus.role === "tab");
    await arrowTo(page, "ArrowRight", "Faturas");
    await expect(page.getByRole("tab", { name: "Faturas", exact: true })).toHaveAttribute("aria-selected", "true");
    await tabTo(page, /^Pagar…$/);
    await page.keyboard.press("Enter");
    const pay = page.getByRole("dialog", { name: /^Pagar fatura/ });
    await expect(pay).toBeVisible();
    await expectFocusVisible(page, "payment dialog");
    await pay.getByLabel("Valor", { exact: true }).focus();
    await page.keyboard.press("Control+a");
    await page.keyboard.type("100,00");
    await page.keyboard.press("Enter");
    await expect(pay).toHaveCount(0);
    await expect(notice(page, /Pagamento da fatura de .* registrado\./)).toBeVisible();
    await expectFocusOn(page, /^Pagar…$/, "after the payment dialog");

    // ── the command palette ──────────────────────────────────────────────────
    const before = await expectFocusVisible(page, "before the palette");
    await page.keyboard.press("Control+k");
    const input = page.getByRole("combobox", { name: "Buscar comando ou seção" });
    await expect(input).toBeFocused();
    await page.keyboard.type("escuro");
    await expect(page.getByRole("option", { name: /Aparência escura/ })).toHaveAttribute("aria-selected", "true");
    await page.keyboard.press("Enter");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expectFocusOn(page, before.name, "after the palette command");
    await page.keyboard.press("Control+k");
    await page.keyboard.type("aparência clara");
    await page.keyboard.press("Enter");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");

    // ── lock and unlock ──────────────────────────────────────────────────────
    await page.keyboard.press("Control+Shift+l");
    await expect(page.getByRole("heading", { name: "Casa está bloqueado" })).toBeVisible();
    await expect(page.getByLabel("Senha do projeto")).toBeFocused();
    await page.keyboard.type("senha errada demais");
    await page.keyboard.press("Enter");
    await expect(page.getByText("Senha do projeto incorreta.")).toBeVisible();
    await expectFocusVisible(page, "after a wrong unlock password");
    await page.keyboard.press("Control+a");
    await page.keyboard.type(DEMO.projectPassword);
    await page.keyboard.press("Enter");
    await expect(page.getByRole("heading", { level: 1, name: "Contas e cartões" })).toBeVisible();
    await expect.poll(async () => (await focusOf(page)) !== null, { message: "focus after unlocking" }).toBe(true);
    await expectFocusVisible(page, "after unlocking");

    expect(errors).toEqual([]);
  });
});
