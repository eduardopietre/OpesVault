/**
 * Security end to end (docs/18 W12, docs/19 §12), on the production build:
 *
 * - the built page: Subresource Integrity on every script and style, the one CSP as a <meta>, no inline code;
 * - hostile strings (markup, script URLs, formulas, bidirectional and zero-width characters, very long text) typed
 *   into every free-text field reachable through the dialogs of every page: nothing executes, nothing is requested
 *   from an unexpected address, nothing is logged as an error; the CSV export keeps its structure;
 * - a hostile PDF (JavaScript and launch actions, an embedded file, a long page tree with a loop) goes through
 *   Importar without executing or hanging.
 */
import { expect, test, type Locator, type Page } from "@playwright/test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cspMeta } from "../../../packages/vault/src/csp.ts";
import { openDemo, settle, watchErrors } from "./helpers.ts";
import { hostilePdf } from "./hostile_pdf.ts";
import { chooseFiles } from "./pages/importar_helpers.ts";
import { fakeOllama } from "./pages/livro_helpers.ts";
import { attach } from "./pages/sharing_helpers.ts";

const HOSTILE = [
  `<img src=x onerror="window.__pwned=1">`,
  `<img src="https://evil.test/p.png" onerror="window.__pwned=2">`,
  `"><svg/onload=window.__pwned=3>`,
  `javascript:window.__pwned=4`,
  `=HYPERLINK("https://evil.test/x";"clique")`,
  `+1+1`,
  `-2+3`,
  `@SUM(1+1)`,
  "‮elcaps‬​‍⁦x⁩",
  `'; DROP TABLE operations; --`,
  "x".repeat(4000),
  "tab\there\u0007bell",
  `</script><script>window.__pwned=5</script>`,
  `{{constructor.constructor("window.__pwned=6")()}}`,
];

// ── the built page ───────────────────────────────────────────────────────────────────────────────

test.describe("the built page", () => {
  const dist = resolve("build/dist-e2e");
  const html = () => readFileSync(resolve(dist, "index.html"), "utf8");

  test("every script, style and preload carries a matching integrity hash", () => {
    const tags = [...html().matchAll(/<(script|link)\b([^>]*)>/g)].filter(([, , attrs]) =>
      /\b(?:src|href)="\/assets\//.test(attrs ?? ""),
    );
    expect(tags.length).toBeGreaterThan(3);
    for (const [tag, name, attrs] of tags) {
      if (name === "link" && !/rel="(?:stylesheet|modulepreload)"/.test(attrs ?? "")) continue;
      const file = /\b(?:src|href)="\/(assets\/[^"]+)"/.exec(attrs ?? "")![1]!;
      const integrity = /\bintegrity="(sha384-[^"]+)"/.exec(attrs ?? "")?.[1];
      expect(integrity, `no integrity on ${tag}`).toBeDefined();
      const digest = createHash("sha384")
        .update(readFileSync(resolve(dist, file)))
        .digest("base64");
      expect(integrity, file).toBe(`sha384-${digest}`);
    }
  });

  test("the page has no inline script, and its CSP is the one policy", () => {
    const page = html();
    const inline = [...page.matchAll(/<script\b([^>]*)>/g)].filter(([, attrs]) => !/\bsrc=/.test(attrs ?? ""));
    expect(inline).toEqual([]);
    expect(page).not.toMatch(/\son[a-z]+=/);
    const meta = /http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(page)![1]!;
    expect(meta.replaceAll("&#39;", "'")).toBe(cspMeta());
  });

  test("the service worker precaches the shell (pwa.spec.ts runs it with the integrity hashes in place)", () => {
    const worker = readFileSync(resolve(dist, "sw.js"), "utf8");
    expect(worker).toContain("precacheAndRoute");
    expect(worker).toMatch(/index\.html/);
  });
});

// ── hostile strings in every free-text field ─────────────────────────────────────────────────────

async function guard(page: Page): Promise<{ problems: string[]; check: () => Promise<void> }> {
  // The local AI answers from the test: no real Ollama, and no refused connection logged as an error.
  await fakeOllama(page);
  const problems: string[] = [];
  const quiet = watchErrors(page);
  page.on("dialog", (dialog) => {
    problems.push(`dialog: ${dialog.message()}`);
    void dialog.dismiss();
  });
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (!/^https?:$/.test(url.protocol)) return;
    if (!["localhost", "127.0.0.1"].includes(url.hostname) || /\/(x|evil|pwned)\b/.test(url.pathname)) {
      problems.push(`request: ${request.url()}`);
    }
  });
  return {
    problems,
    async check() {
      const state = await page.evaluate(() => ({
        pwned: (window as unknown as { __pwned?: unknown }).__pwned,
        handlers: document.querySelectorAll("[onerror],[onload],[onclick],script:not([src])").length,
        scriptLinks: [...document.querySelectorAll("a[href]")].filter((a) =>
          /^\s*javascript:/i.test(a.getAttribute("href") ?? ""),
        ).length,
        images: [...document.images].filter((img) => /evil|^x$/.test(img.getAttribute("src") ?? "")).length,
      }));
      expect(state, "something executed or was injected").toEqual({
        pwned: undefined,
        handlers: 0,
        scriptLinks: 0,
        images: 0,
      });
      expect(problems).toEqual([]);
      expect(quiet).toEqual([]);
    },
  };
}

const OPENER = /^(Nov[oa]s?\b|Adicionar|Criar|Cadastrar|Editar|Renomear|Nomear|Ações|Marcadores|Corrigir|Mais ações)/;
const ITEM =
  /^(Despesa|Receita|Compra no cartão|Nov[oa]s?\b|Adicionar|Criar|Corrigir…|Marcadores|Nomear|Reembolso|Reclassificar|Detalhar|Editar|Renomear|Anexar)/;
const DESTRUCTIVE = /Estornar|Excluir|Remover|Apagar|Cancelar lançamento|Limpar|Zerar|Esquecer/;
const CANCEL = /^(Cancelar|Fechar|Voltar)/;

let counter = 0;
const next = () => HOSTILE[counter++ % HOSTILE.length]!;

/** Types a hostile string into every free-text field of the open dialog (not money, dates or lists). */
async function fillText(dialog: Locator): Promise<number> {
  const fields = dialog.locator('input:not([type]), input[type="text"], input[type="search"], textarea');
  let filled = 0;
  for (let i = 0; i < (await fields.count()); i++) {
    const field = fields.nth(i);
    if (!(await field.isVisible()) || !(await field.isEditable())) continue;
    const info = await field.evaluate((element) => ({
      role: element.getAttribute("role"),
      mode: element.getAttribute("inputmode"),
      placeholder: element.getAttribute("placeholder") ?? "",
    }));
    if (info.role === "combobox" || info.mode || /\d|dd\//.test(info.placeholder)) continue;
    await field.fill(next());
    filled += 1;
  }
  return filled;
}

/** Submits the open dialog with its last enabled button (the primary one); leaves with Escape if it stays open. */
async function submit(page: Page, dialog: Locator): Promise<void> {
  const buttons = dialog.getByRole("button");
  const names = await buttons.evaluateAll((els) =>
    els.map((el) => ({
      name: el.getAttribute("aria-label") ?? el.textContent ?? "",
      off: (el as HTMLButtonElement).disabled,
    })),
  );
  const index = names
    .map((b) => !b.off && !CANCEL.test(b.name.trim()) && !/Fechar|Close/.test(b.name))
    .lastIndexOf(true);
  if (index >= 0)
    await buttons
      .nth(index)
      .click({ timeout: 3000 })
      .catch(() => undefined);
  await page.waitForTimeout(250);
  for (let attempt = 0; attempt < 3 && (await page.getByRole("dialog").count()) > 0; attempt++) {
    await page.keyboard.press("Escape");
    await page.waitForTimeout(250);
    const ask = page.getByRole("alertdialog");
    if ((await ask.count()) > 0) {
      await ask
        .getByRole("button", { name: /Descartar|Sair|Continuar sem|Fechar/ })
        .first()
        .click()
        .catch(() => undefined);
      await page.waitForTimeout(250);
    }
  }
}

async function buttonNames(page: Page): Promise<string[]> {
  const names = await page
    .locator("main")
    .getByRole("button")
    .evaluateAll((els) =>
      els
        .filter((el) => (el as HTMLElement).offsetParent !== null)
        .map((el) => (el.getAttribute("aria-label") ?? el.textContent ?? "").trim()),
    );
  return [...new Set(names)].filter((name) => OPENER.test(name) && !DESTRUCTIVE.test(name));
}

/** Opens every dialog an opener button (or one of its menu items) leads to, fills it with hostile text, submits it. */
async function crawl(page: Page, route: string, prepare?: () => Promise<void>): Promise<number> {
  await openDemo(page, route);
  await settle(page, 300);
  await prepare?.();
  // every tab of the page, one after the other (a page with no tabs has one pass)
  const tabs = (await page.getByRole("tab").allInnerTexts()).map((text) => text.trim()).filter(Boolean);
  let dialogs = await crawlButtons(page);
  for (const tab of [...new Set(tabs)]) {
    await page
      .getByRole("tab", { name: tab })
      .first()
      .click({ timeout: 3000 })
      .catch(() => undefined);
    await settle(page, 200);
    dialogs += await crawlButtons(page);
  }
  return dialogs;
}

async function crawlButtons(page: Page): Promise<number> {
  let dialogs = 0;
  for (const name of await buttonNames(page)) {
    const opener = () => page.locator("main").getByRole("button", { name, exact: true }).first();
    if (
      !(await opener()
        .isVisible()
        .catch(() => false))
    )
      continue;
    await opener()
      .click({ timeout: 3000 })
      .catch(() => undefined);
    const menu = page.getByRole("menu");
    if ((await menu.count()) > 0) {
      const items = (await menu.getByRole("menuitem").allInnerTexts())
        .map((text) => text.trim())
        .filter((text) => ITEM.test(text) && !DESTRUCTIVE.test(text));
      await page.keyboard.press("Escape");
      for (const item of items) {
        await opener()
          .click({ timeout: 3000 })
          .catch(() => undefined);
        await page
          .getByRole("menuitem", { name: item, exact: true })
          .first()
          .click({ timeout: 3000 })
          .catch(() => undefined);
        dialogs += await fillAndSubmit(page);
      }
    } else {
      dialogs += await fillAndSubmit(page);
    }
  }
  return dialogs;
}

async function fillAndSubmit(page: Page): Promise<number> {
  await page.waitForTimeout(200);
  const dialog = page.getByRole("dialog").last();
  if ((await dialog.count()) === 0) return 0;
  const filled = await fillText(dialog);
  await submit(page, dialog);
  return filled > 0 ? 1 : 0;
}

const ROUTES: [string, number][] = [
  ["/livro", 6],
  ["/contas", 8],
  ["/recorrencias", 1],
  ["/metas", 1],
  ["/reembolsos", 0],
  ["/investimentos", 1],
  ["/imposto", 0],
  ["/orcamento", 0],
  ["/documentos", 0],
  ["/calendario", 0],
];

test.describe("hostile strings in the dialogs of every page", () => {
  test.use({ viewport: { width: 1920, height: 1080 }, contextOptions: { reducedMotion: "reduce" } });
  test.setTimeout(240_000);

  for (const [route, minimum] of ROUTES) {
    test(`${route}: nothing executes, nothing is requested, nothing is logged`, async ({ page }) => {
      const watch = await guard(page);
      const dialogs = await crawl(page, route, async () => {
        // an entry must be selected for the commands that act on one
        const row = page.locator("[data-row-id]").first();
        if (await row.isVisible().catch(() => false)) await row.click();
      });
      test.info().annotations.push({ type: "dialogs filled", description: String(dialogs) });
      expect(dialogs, `dialogs filled on ${route}`).toBeGreaterThanOrEqual(minimum);
      await watch.check();
      // what was saved is drawn again by the pages that show it
      for (const path of ["/livro", "/visao-geral", "/orcamento", "/relatorios"]) {
        await page
          .getByRole("link", {
            name: new RegExp(
              `^${{ "/livro": "Livro", "/visao-geral": "Visão", "/orcamento": "Orçamento", "/relatorios": "Relat" }[path]!}`,
            ),
          })
          .first()
          .click()
          .catch(() => undefined);
        await settle(page, 300);
      }
      await watch.check();
    });
  }
});

test.describe("hostile strings in the other free-text places", () => {
  test.use({ viewport: { width: 1280, height: 800 }, contextOptions: { reducedMotion: "reduce" } });

  test("the project name and the search box are text, and the CSV keeps its shape", async ({ page }) => {
    const watch = await guard(page);
    await openDemo(page, "/configuracoes");
    const name = page.getByLabel("Nome do projeto");
    await name.fill(HOSTILE[0]!);
    await page.getByRole("button", { name: "Renomear", exact: true }).click();
    await expect(page.getByText(HOSTILE[0]!, { exact: false }).first()).toBeVisible();
    await watch.check();

    await page
      .getByRole("link", { name: /^Livro/ })
      .first()
      .click();
    await expect(page.locator("[data-row-id]").first()).toBeVisible();
    for (const text of HOSTILE.slice(0, 5)) {
      await page.getByRole("searchbox", { name: "Buscar lançamentos" }).fill(text);
      await page.waitForTimeout(250);
    }
    await watch.check();

    // an entry with every formula prefix and quotes and semicolons, then the book as CSV
    const descriptions = ['=1+1;"a"', "+SUM(1)", "-2+3", '@cmd "q"; next'];
    await page.getByRole("searchbox", { name: "Buscar lançamentos" }).fill("");
    for (const description of descriptions) {
      await page.getByRole("button", { name: "Novo lançamento" }).click();
      await page.getByRole("menuitem", { name: "Despesa", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: "Despesa" });
      await dialog.getByLabel("Descrição", { exact: true }).fill(description);
      await dialog.getByLabel("Valor", { exact: true }).fill("1,00");
      await dialog.getByRole("button", { name: "Registrar", exact: true }).click();
      await expect(dialog).toHaveCount(0);
    }
    const download = page.waitForEvent("download");
    await page.getByRole("button", { name: "Exportar", exact: true }).click();
    await page.getByRole("menuitem", { name: /^Livro completo/ }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Exportar CSV" }).click();
    const text = readFileSync(await (await download).path(), "utf8");
    const records = parseCsv(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
    expect(records.length).toBeGreaterThan(10);
    // every record has the 14 columns: no cell broke out of its field into another row or column
    expect(records.filter((record) => record.length !== 14)).toEqual([]);
    // the descriptions survive intact (the desktop writes them the same way: docs/19 §12, accepted limitation)
    for (const description of descriptions) expect(records.some((record) => record[4] === description)).toBe(true);
    await watch.check();
  });

  test("a file with a hostile name and hostile CSV rows is shown as text", async ({ page }) => {
    const watch = await guard(page);
    await openDemo(page, "/importar");
    const rows = HOSTILE.slice(0, 8)
      .map((text, i) => `2026-03-${String(i + 1).padStart(2, "0")},"${text.replaceAll('"', '""')}",${10 + i}.00`)
      .join("\n");
    await chooseFiles(page, [
      {
        name: `<img src=x onerror=window.__pwned=7>.csv`,
        mimeType: "text/csv",
        buffer: Buffer.from(`date,title,amount\n${rows}\n`),
      },
    ]);
    await expect(page.getByText(/item\(ns\) para revisar|não foi possível|Não foi possível/i).first()).toBeVisible({
      timeout: 30_000,
    });
    await settle(page, 500);
    await watch.check();
  });
});

// ── a hostile PDF ────────────────────────────────────────────────────────────────────────────────

test.describe("a hostile PDF", () => {
  test.use({ viewport: { width: 1920, height: 1080 } });
  test.setTimeout(180_000);

  test("goes through Importar without executing, requesting anything or hanging", async ({ page }) => {
    const watch = await guard(page);
    const started = Date.now();
    await openDemo(page, "/importar");
    const buffer = await hostilePdf();
    await chooseFiles(page, [{ name: "fatura-hostil.pdf", mimeType: "application/pdf", buffer }]);
    // Either it is read (and nothing recognizes the layout) or it is refused with a message: never a spinner forever.
    await expect(
      page
        .getByText(/fatura-hostil\.pdf: /)
        .or(page.getByText(/não foi possível|nenhum leitor|Não reconhecemos|não reconhec/i))
        .first(),
    ).toBeVisible({ timeout: 120_000 });
    expect(Date.now() - started).toBeLessThan(150_000);
    // The same file as a receipt: the viewer draws its first pages (pdf.js without eval, XFA or fetches).
    await page
      .getByRole("link", { name: /^Livro/ })
      .first()
      .click();
    await attach(page, "Aluguel", { name: "hostil.pdf", mimeType: "application/pdf", buffer });
    await page.getByRole("button", { name: "Abrir comprovante" }).click();
    const viewer = page.getByRole("dialog", { name: "Comprovante" });
    await expect(viewer.getByLabel("Páginas do comprovante").locator("canvas").first()).toBeVisible({
      timeout: 60_000,
    });
    await viewer.getByRole("button", { name: "Fechar" }).first().click();
    // still alive: the page answers and the project still opens a dialog
    await page
      .getByRole("link", { name: /^Importar/ })
      .first()
      .click();
    await expect(page.getByRole("button", { name: "Importar arquivos…" }).first()).toBeEnabled();
    await settle(page, 500);
    await watch.check();
  });
});

/** A semicolon-separated CSV with quoted fields (RFC 4180 quoting), as the exports write it. */
function parseCsv(text: string): string[][] {
  const records: string[][] = [];
  let record: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (char === '"') quoted = false;
      else field += char;
    } else if (char === '"') quoted = true;
    else if (char === ";") {
      record.push(field);
      field = "";
    } else if (char === "\n") {
      record.push(field);
      records.push(record);
      record = [];
      field = "";
    } else field += char;
  }
  if (field !== "" || record.length) {
    record.push(field);
    records.push(record);
  }
  return records;
}
