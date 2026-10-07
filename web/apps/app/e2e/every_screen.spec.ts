/**
 * Every screen, end to end (successor of the desktop's `tests/test_every_screen.py`, docs/15 TA-31):
 *   - each destination and each print view, with the demonstration project, at four sizes (`pnpm e2e:full`;
 *     1280x800 only in the fast `pnpm e2e`): every enabled button, tab, switch, combo box and menu item is
 *     clicked, every dialog that opens is filled and submitted (or closed), and after each action there is no
 *     console error, no horizontal overflow, at most one undo step (reverted by Ctrl+Z) and no stuck modal
 *     (`e2e/walk.ts`);
 *   - the states without a project: signed out, signed in without a project, locked and after closing the
 *     project, every route redirects or stays locked without errors and without data of the previous project.
 * The local AI is answered by the test (`fakeOllama`): a real Ollama is never contacted.
 */
import { expect, test, type Page } from "@playwright/test";
import { PAGES } from "../src/pages.tsx";
import { DEMO, FULL, SIZES, openDemo, settle, watchErrors } from "./helpers.ts";
import { fakeOllama } from "./pages/livro_helpers.ts";
import { Walker } from "./walk.ts";

// Four sizes in the full suite, 1280x800 in the fast one.
const WALK_SIZES = FULL ? [SIZES[0], SIZES[1], SIZES[2], SIZES[4]] : [SIZES[1]];

/** Values that exist only in the demonstration project: none may be on screen without it. */
/**
 * Waits for the Livro to show its first entry, as a table row or (narrow) as a list option, and returns its
 * description: the entry on top depends on today's date and on the demo data, so the tests read it here.
 */
async function firstEntry(page: Page): Promise<string> {
  const row = page
    .getByRole("row")
    .nth(1)
    .or(page.getByRole("listbox", { name: "Lançamentos" }).getByRole("option").first());
  await expect(row.first()).toBeVisible();
  const text = (await row.first().innerText()).split("\n").map((part) => part.trim());
  // the description: the longest part that is not a date or an amount
  const description =
    text
      .filter((part) => part && !/^\d{2}\/\d{2}\/\d{4}$/.test(part) && !/R\$/.test(part))
      .sort((a, b) => b.length - a.length)[0] ?? "";
  expect(description.length, "the first entry has a description").toBeGreaterThan(2);
  return description;
}

const CANARIES = [
  "Pão de Açúcar",
  "Farmácia São Paulo",
  "CDB Banco X",
  "Itaú da Ana",
  "Reserva de emergência",
  "7.800,00",
];

const PRINT_VIEWS = [
  { path: "/imprimir/relatorio-mensal", query: "" },
  { path: "/imprimir/relatorio-anual", query: "" },
  { path: "/imprimir/imposto", query: "?ano=2026" },
] as const;

/**
 * Requests that leave the app's own origin (TA-30, docs/19: nothing external is needed, nothing visual is
 * fetched from outside). The local AI on 127.0.0.1:11434 is the one allowed exception, by the user's choice.
 */
function watchForeignRequests(page: Page): string[] {
  const foreign: string[] = [];
  const own = new URL(String(test.info().project.use.baseURL)).origin;
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (["data:", "blob:", "about:"].includes(url.protocol)) return;
    if (url.origin === own) return;
    if (/^(127\.0\.0\.1|localhost)$/.test(url.hostname) && url.port === "11434") return;
    foreign.push(`${request.method()} ${url.origin}${url.pathname}`);
  });
  return foreign;
}

test.describe("the walk", () => {
  test.setTimeout(420_000);
  for (const size of WALK_SIZES) {
    for (const entry of PAGES) {
      test(`${entry.title} at ${size.width}x${size.height}`, async ({ page }, testInfo) => {
        await page.setViewportSize(size);
        await fakeOllama(page);
        const errors = watchErrors(page);
        const foreign = watchForeignRequests(page);
        const walker = new Walker(page, errors, entry.path);
        await openDemo(page, entry.path);
        await settle(page, 600);
        expect(errors, "errors while loading").toEqual([]);
        expect(walker.downloads, "an export starts only when the user asks (TA-34)").toEqual([]);
        await walker.walk();
        testInfo.annotations.push({ type: "walk", description: walker.summary() });
        process.stdout.write(`[walk] ${entry.title} ${size.width}: ${walker.summary()}` + "\n");
        expect(walker.problems).toEqual([]);
        expect(foreign, "requests outside the app's own origin (TA-30)").toEqual([]);
      });
    }
    for (const view of PRINT_VIEWS) {
      test(`print view ${view.path} at ${size.width}x${size.height}`, async ({ page }, testInfo) => {
        await page.setViewportSize(size);
        const errors = watchErrors(page);
        await page.addInitScript(() => {
          const store = window as unknown as { __prints: number };
          store.__prints = 0;
          window.print = () => {
            store.__prints += 1;
          };
        });
        const walker = new Walker(page, errors, view.path, { root: "body", limit: 40 });
        await page.goto(`${view.path}${view.query ? `${view.query}&demo` : "?demo"}`);
        await expect(page.locator("h1").first()).toBeVisible();
        await settle(page, 600);
        expect(errors).toEqual([]);
        expect(walker.downloads, "an export starts only when the user asks (TA-34)").toEqual([]);
        expect(
          await page.evaluate(() => (window as unknown as { __prints: number }).__prints),
          "no print dialog on load",
        ).toBe(0);
        await walker.walk();
        testInfo.annotations.push({ type: "walk", description: walker.summary() });
        process.stdout.write(`[walk] ${view.path} ${size.width}: ${walker.summary()}` + "\n");
        expect(walker.problems).toEqual([]);
      });
    }
  }
});

/** Goes to a path inside the running app without reloading (a reload would drop the in-memory session). */
async function goInApp(page: Page, path: string): Promise<void> {
  await page.evaluate((target) => {
    history.pushState({}, "", target);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }, path);
  await page.waitForTimeout(150);
}

const ROUTES = [
  ...PAGES.map((entry) => entry.path as string),
  ...PRINT_VIEWS.map((view) => `${view.path}${view.query}`),
  "/comecar",
];

async function screenText(page: Page): Promise<string> {
  return page.evaluate(() => document.body.innerText);
}

test.describe("without a project (TA-31)", () => {
  test.setTimeout(180_000);
  for (const size of WALK_SIZES) {
    test(`signed out: every route redirects to the sign-in (${size.width})`, async ({ page }) => {
      await page.setViewportSize(size);
      const errors = watchErrors(page);
      for (const route of [...ROUTES, "/projetos", "/projetos/novo", "/rota-inexistente"]) {
        await page.goto(route);
        await expect(page.locator("h1, h2").first()).toBeVisible();
        const path = new URL(page.url()).pathname;
        expect(["/entrar", "/boas-vindas"], `${route} -> ${path}`).toContain(path);
        expect(await screenText(page)).not.toContain("Pão de Açúcar");
      }
      expect(errors).toEqual([]);
    });

    test(`signed in without a project: every route goes to the project list (${size.width})`, async ({ page }) => {
      await page.setViewportSize(size);
      const errors = watchErrors(page);
      await page.goto("/entrar");
      await page.getByLabel("E-mail").fill(DEMO.email);
      await page.getByLabel("Senha da conta").fill(DEMO.password);
      await page.getByRole("button", { name: "Entrar", exact: true }).click();
      await expect(page).toHaveURL(/\/projetos$/);
      for (const route of ROUTES) {
        await goInApp(page, route);
        await expect(page, route).toHaveURL(/\/projetos$/);
        await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible();
        const text = await screenText(page);
        for (const canary of CANARIES) expect(text, `${route} shows ${canary}`).not.toContain(canary);
      }
      expect(errors).toEqual([]);
    });

    test(`locked: no route shows data, the password brings it back (${size.width})`, async ({ page }) => {
      await page.setViewportSize(size);
      const errors = watchErrors(page);
      await openDemo(page, "/livro");
      const shown = await firstEntry(page);
      await page.getByRole("button", { name: "Bloquear o projeto" }).click();
      await expect(page.getByRole("heading", { name: /está bloqueado/ })).toBeVisible();
      for (const route of ROUTES) {
        await goInApp(page, route);
        await expect(page.getByRole("heading", { name: /está bloqueado/ }), route).toBeVisible();
        const text = await screenText(page);
        for (const canary of [...CANARIES, shown])
          expect(text, `${route} shows ${canary} while locked`).not.toContain(canary);
      }
      await page.getByLabel("Senha do projeto").fill(DEMO.projectPassword);
      await page.getByRole("button", { name: "Desbloquear" }).click();
      await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible();
      expect(errors).toEqual([]);
    });

    test(`after switching project nothing of the previous one stays (${size.width})`, async ({ page }) => {
      await page.setViewportSize(size);
      const errors = watchErrors(page);
      await openDemo(page, "/livro");
      const shown = await firstEntry(page);
      await page.getByRole("button", { name: "Conta de Ana Souza" }).click();
      await page.getByRole("menuitem", { name: "Trocar de projeto" }).click();
      await expect(page).toHaveURL(/\/projetos$/);
      for (const route of ROUTES) {
        await goInApp(page, route);
        await expect(page, route).toHaveURL(/\/projetos$/);
        const text = await screenText(page);
        for (const canary of [...CANARIES, shown]) expect(text, `${route} shows ${canary}`).not.toContain(canary);
      }
      expect(errors).toEqual([]);
    });
  }

  test("browser storage and cookies hold no data of the project (TA-05, TA-31)", async ({ page }) => {
    const errors = watchErrors(page);
    await openDemo(page, "/livro");
    await firstEntry(page);
    for (const route of ["/contas", "/investimentos", "/importar", "/livro"]) await goInApp(page, route);
    const held = await page.evaluate(() => {
      const entries: string[] = [];
      for (const store of [localStorage, sessionStorage]) {
        for (let i = 0; i < store.length; i++) {
          const key = store.key(i) ?? "";
          entries.push(`${key}=${store.getItem(key)}`);
        }
      }
      return entries.join("\n") + "\n" + document.cookie;
    });
    for (const canary of [...CANARIES, "Casa"]) expect(held, `storage holds ${canary}`).not.toContain(canary);
    expect(errors).toEqual([]);
  });
});
