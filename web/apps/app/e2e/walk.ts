/**
 * The generic page walker of the every-screen test (successor of the desktop's `tests/test_every_screen.py`):
 * on a page it finds every enabled button, tab, switch, combo box and menu item by role, clicks each one,
 * answers the dialogs it opens (fills them with valid data when it can and submits, otherwise closes them) and
 * checks after every action:
 *   - no console error, warning or uncaught exception;
 *   - no horizontal overflow;
 *   - at most one undo step per action, and Ctrl+Z reverts it (read through `window.__opesvaultTest`, which
 *     only the development and e2e builds install);
 *   - no dialog stays open (no stuck modal).
 * Actions that leave the app or download are performed and recorded, not skipped: a download is caught by
 * Playwright, a new tab is closed, a navigation inside the app is undone with the browser's back button.
 */
import { type Locator, type Page } from "@playwright/test";
import { DEMO, animationsDone } from "./helpers.ts";

interface TestHook {
  undoDepth(): number;
  redoDepth(): number;
  version(): number;
}

interface Candidate {
  index: number;
  role: string;
  name: string;
  /** Opens a menu. */
  menu: boolean;
}

export interface WalkOptions {
  /** CSS selector of the area to walk (the shell's main area, or the whole body of a print view). */
  root?: string;
  /** Most clicks of one page (a bound for pages that keep producing new buttons). */
  limit?: number;
}

const SELECTOR =
  'button, [role="button"], [role="tab"], [role="switch"], [role="combobox"], summary, input[type="checkbox"], input[type="radio"]';

/** Buttons that close or cancel without doing the dialog's work. */
const CANCEL = /^(Cancelar|Fechar|Agora não|Dispensar|Voltar|Não)\b/i;

/** Decisions that would end the walk itself (the project or the session disappears): cancelled and recorded. */
const DESTRUCTIVE =
  /excluir (o )?projeto|esquecer|apagar (todos )?os dados|encerrar a sess|sair da conta|restaurar (o )?backup|substituir (o )?projeto/i;

export class Walker {
  clicks = 0;
  menuItems = 0;
  submitted: string[] = [];
  closed: string[] = [];
  left: string[] = [];
  downloads: string[] = [];
  skipped: string[] = [];
  undone = 0;
  redone = 0;
  problems: string[] = [];

  readonly #page: Page;
  readonly #errors: string[];
  readonly #path: string;
  readonly #root: string;
  readonly #limit: number;
  readonly #seen = new Map<string, number>();
  #redoProved = false;

  constructor(page: Page, errors: string[], path: string, options: WalkOptions = {}) {
    this.#page = page;
    this.#errors = errors;
    this.#path = path;
    this.#root = options.root ?? "#conteudo";
    this.#limit = options.limit ?? 260;
    page.on("download", (download) => {
      this.downloads.push(download.suggestedFilename());
    });
    page.on("filechooser", () => {
      // Nothing is chosen: the page must cope with a cancelled file dialog.
      this.skipped.push("file chooser (cancelled)");
    });
    page.on("popup", (popup) => {
      this.left.push(`new tab ${popup.url()}`);
      void popup.close();
    });
    page.on("dialog", (dialog) => {
      // A native alert, confirm or prompt: the app uses none; answer and record.
      this.problems.push(`native ${dialog.type()} dialog: ${dialog.message().slice(0, 80)}`);
      void dialog.dismiss();
    });
  }

  /** Clicks everything on the page: each tab in turn, and in each view once more with a row selected. */
  async walk(depth = 0): Promise<void> {
    const view = await this.#viewKey();
    await this.#pass(view);
    if (await this.#selectRow(view)) await this.#pass(view);
    if (depth >= 2) return;
    const tabs = (await this.#snapshot(this.#root)).filter((c) => c.role === "tab");
    for (const tab of tabs) {
      if (this.clicks >= this.#limit) break;
      const key = `${view}|tab|${tab.name}`;
      if (this.#seen.has(key)) continue;
      this.#seen.set(key, 1);
      let opened = false;
      await this.#action(`tab "${tab.name}"`, async () => {
        const target = await this.#locate(tab);
        if (!target) return;
        await target.click({ timeout: 4000 });
        opened = true;
      });
      if (opened) await this.walk(depth + 1);
    }
  }

  /** What identifies the view now: the selected tabs (the same button in two tabs is two controls). */
  async #viewKey(): Promise<string> {
    const tabs = await this.#page
      .locator(`${this.#root} [role="tab"][aria-selected="true"]`)
      .evaluateAll((items) => items.map((item) => (item.textContent ?? "").trim()));
    return tabs.join(">");
  }

  /** Selects the first row of the view once (the inspector and the row commands appear). */
  async #selectRow(view: string): Promise<boolean> {
    const key = `${view}|row`;
    if (this.#seen.has(key)) return false;
    this.#seen.set(key, 1);
    const rows = this.#page.locator(`${this.#root} [data-row-id]`);
    if ((await rows.count()) === 0) return false;
    let selected = false;
    await this.#guard("select the first row", async () => {
      await rows.first().click({ timeout: 4000 });
      selected = true;
    });
    return selected;
  }

  async #pass(view: string): Promise<void> {
    while (this.clicks < this.#limit) {
      const next = await this.#next(view);
      if (!next) return;
      await this.#visit(next);
    }
    if (!this.skipped.some((line) => line.startsWith("stopped at"))) {
      this.skipped.push(`stopped at the limit of ${this.#limit} clicks`);
    }
  }

  /** The first visible, enabled control (other than a tab) not clicked twice already in this view. */
  async #next(view: string): Promise<Candidate | null> {
    const list = await this.#snapshot(this.#root);
    for (const candidate of list) {
      if (candidate.role === "tab") continue;
      const key = `${view}|${candidate.role}|${candidate.name}`;
      if ((this.#seen.get(key) ?? 0) >= 2) continue;
      this.#seen.set(key, (this.#seen.get(key) ?? 0) + 1);
      return candidate;
    }
    return null;
  }

  /**
   * The control now: by its tag, or, when the page drew it again since the snapshot (new nodes, no tag), by
   * its role and name. Null when it is no longer there (an earlier action changed the page).
   */
  async #locate(candidate: Candidate): Promise<Locator | null> {
    const tagged = this.#page.locator(`[data-walk="${candidate.index}"]`);
    if ((await tagged.count()) === 1) return tagged;
    const fresh = (await this.#snapshot(this.#root)).find(
      (c) => c.role === candidate.role && c.name === candidate.name,
    );
    if (!fresh) {
      this.skipped.push(`${candidate.role} "${candidate.name}" (no longer on the page)`);
      return null;
    }
    candidate.index = fresh.index;
    return this.#page.locator(`[data-walk="${fresh.index}"]`);
  }

  /** Clicks a control; one more try with a fresh handle when the page replaced it while Playwright waited. */
  async #click(candidate: Candidate): Promise<boolean> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const target = await this.#locate(candidate);
      if (!target) return false;
      try {
        await target.click({ timeout: attempt === 0 ? 2500 : 4000 });
        return true;
      } catch (error) {
        if (attempt === 1 || !/detached|resolved to 0|Timeout/.test((error as Error).message)) throw error;
        await this.#page.waitForTimeout(150);
      }
    }
    return false;
  }

  async #snapshot(root: string, inDialog = false): Promise<Candidate[]> {
    return this.#page.evaluate(
      ({ root: scopeSelector, selector, inDialog: allowDialog }) => {
        document.querySelectorAll("[data-walk]").forEach((element) => element.removeAttribute("data-walk"));
        const scope = document.querySelector(scopeSelector) ?? document.body;
        const out: Candidate[] = [];
        for (const element of scope.querySelectorAll<HTMLElement>(selector)) {
          const skip = allowDialog
            ? '[inert], [aria-hidden="true"], [role="menu"], [role="listbox"], [role="status"], [role="alert"]'
            : '[inert], [aria-hidden="true"], dialog, [role="menu"], [role="listbox"], [role="status"], [role="alert"]';
          if (element.closest(skip)) continue;
          if (element.matches(":disabled") || element.getAttribute("aria-disabled") === "true") continue;
          const style = getComputedStyle(element);
          if (style.visibility === "hidden" || style.display === "none") continue;
          const rect = element.getBoundingClientRect();
          if (rect.width === 0 || rect.height === 0) continue;
          const role =
            element.getAttribute("role") ??
            (element instanceof HTMLInputElement ? element.type : element.tagName.toLowerCase());
          const labelled = element instanceof HTMLInputElement ? (element.labels?.[0]?.textContent ?? "") : "";
          const name = (
            element.getAttribute("aria-label") ??
            (labelled || null) ??
            element.getAttribute("title") ??
            element.textContent ??
            ""
          )
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, 80);
          const index = out.length;
          element.setAttribute("data-walk", String(index));
          out.push({ index, role, name, menu: element.getAttribute("aria-haspopup") === "menu" });
        }
        return out;
      },
      { root, selector: SELECTOR, inDialog },
    ) as Promise<Candidate[]>;
  }

  async #visit(candidate: Candidate): Promise<void> {
    const label = `${candidate.role} "${candidate.name}"`;
    if (candidate.menu) {
      await this.#visitMenu(candidate, label);
      return;
    }
    if (candidate.role === "combobox") {
      await this.#action(label, async () => {
        if (!(await this.#click(candidate))) return;
        const option = this.#page.getByRole("option").last();
        if (await option.isVisible().catch(() => false)) await option.click({ timeout: 3000 });
        else await this.#page.keyboard.press("Escape");
      });
      return;
    }
    await this.#action(label, async () => {
      await this.#click(candidate);
    });
  }

  async #visitMenu(candidate: Candidate, label: string): Promise<void> {
    let names: string[] = [];
    await this.#guard(`${label} (open menu)`, async () => {
      if (!(await this.#click(candidate))) return;
      const menu = this.#page.locator('[role="menu"]').last();
      await menu.waitFor({ state: "visible", timeout: 3000 });
      names = (
        await menu
          .locator('[role^="menuitem"]:not([data-disabled]):not([aria-disabled="true"])')
          .evaluateAll((items) => items.map((item) => (item.textContent ?? "").replace(/\s+/g, " ").trim()))
      ).slice(0, 25);
      await this.#page.keyboard.press("Escape");
      await this.#page.locator('[role="menu"]').waitFor({ state: "detached", timeout: 3000 });
    });
    for (let k = 0; k < names.length; k++) {
      const item = names[k] ?? "";
      if (DESTRUCTIVE.test(item)) {
        this.skipped.push(`${label} › ${item} (ends the project or session)`);
        continue;
      }
      this.menuItems += 1;
      await this.#action(`${label} › ${item}`, async () => {
        if (!(await this.#click(candidate))) return;
        const entry = this.#page
          .locator('[role="menu"] [role^="menuitem"]:not([data-disabled]):not([aria-disabled="true"])')
          .filter({ hasText: item })
          .first();
        await entry.waitFor({ state: "visible", timeout: 1500 }).catch(() => undefined);
        if ((await entry.count()) === 0) {
          // An earlier action changed what the menu offers (the row it acted on is gone, a state changed).
          this.skipped.push(`${label} › ${item} (no longer offered)`);
          await this.#page.keyboard.press("Escape");
          return;
        }
        await entry.click({ timeout: 4000 });
      });
    }
  }

  /** One user action: run it, answer what it opens, then check the rules. */
  async #action(label: string, run: () => Promise<void>): Promise<void> {
    this.clicks += 1;
    if (process.env["WALK_TRACE"]) process.stdout.write(`[trace] ${label}` + "\n");
    // A dialog an earlier background job opened late is answered first, as an action of its own.
    if ((await this.#page.locator("dialog[open]").count()) > 0) {
      const lateBefore = { errors: this.#errors.length, undo: await this.#depth() };
      await this.#afterClick(`${label} (late dialog)`).catch(() => undefined);
      await this.#verify(`${label} (late dialog)`, lateBefore);
    }
    const before = { errors: this.#errors.length, undo: await this.#depth() };
    try {
      await run();
      await this.#afterClick(label);
    } catch (error) {
      this.problems.push(`${label}: ${brief(error)}`);
      await this.#recover();
    }
    await this.#verify(label, before);
  }

  /** A step that is not itself an action to verify (opening a menu to read it). */
  async #guard(label: string, run: () => Promise<void>): Promise<void> {
    try {
      await run();
    } catch (error) {
      this.problems.push(`${label}: ${brief(error)}`);
      await this.#recover();
    }
  }

  async #depth(): Promise<number> {
    return this.#page.evaluate(
      () => (window as unknown as { __opesvaultTest?: TestHook }).__opesvaultTest?.undoDepth() ?? -1,
    );
  }

  async #afterClick(label: string): Promise<void> {
    await this.#page.waitForTimeout(120);
    // Work started in the background (the local AI, a file being read) ends with a dialog of its own.
    await this.#page
      .waitForFunction(() => !document.querySelector('[aria-busy="true"], [role="progressbar"]'), null, {
        timeout: 4000,
      })
      .catch(() => undefined);
    await this.#backIfLeft(label);
    for (let round = 0; round < 8; round++) {
      const dialog = this.#page.locator("dialog[open]").last();
      if ((await dialog.count()) === 0) break;
      await this.#dialog(dialog, label);
      await this.#page.waitForTimeout(120);
      await this.#backIfLeft(label);
    }
    await this.#unlockIfLocked();
  }

  async #backIfLeft(label: string): Promise<void> {
    const url = new URL(this.#page.url());
    const here = url.pathname;
    if (here === this.#path) return;
    this.left.push(`${label} → ${here}`);
    if (/^\/(boas-vindas|entrar|projetos|criar-conta)/.test(here)) {
      // The session ended (the walk restarts from the demonstration project).
      await this.#page.goto(`${this.#path}?demo`);
      await this.#page.locator("h1").first().waitFor({ state: "visible", timeout: 10_000 });
      return;
    }
    await this.#page.goBack();
    await this.#page.locator("h1").first().waitFor({ state: "visible", timeout: 10_000 });
    if (new URL(this.#page.url()).pathname !== this.#path) {
      await this.#page.goto(`${this.#path}?demo`);
      await this.#page.locator("h1").first().waitFor({ state: "visible", timeout: 10_000 });
    }
  }

  async #unlockIfLocked(): Promise<void> {
    const locked = this.#page.getByRole("heading", { name: /está bloqueado/ });
    if (!(await locked.isVisible().catch(() => false))) return;
    this.left.push("locked the project (unlocked again)");
    await this.#page.getByLabel("Senha do projeto").fill(DEMO.projectPassword);
    await this.#page.getByRole("button", { name: "Desbloquear" }).click();
    await this.#page.locator("h1").first().waitFor({ state: "visible", timeout: 10_000 });
  }

  /** Answers one open dialog: a decision, a form (filled and submitted) or a panel (walked, then closed). */
  async #dialog(dialog: Locator, label: string): Promise<void> {
    const title = (
      (await dialog
        .locator("h2")
        .first()
        .textContent({ timeout: 2000 })
        .catch(() => null)) ?? ""
    ).trim();
    const where = `${label} → "${title}"`;
    const role = await dialog.getAttribute("role");
    const buttons = await dialog.locator("button").evaluateAll((items) =>
      items.map((item, index) => ({
        index,
        name: (item.getAttribute("aria-label") ?? item.textContent ?? "").replace(/\s+/g, " ").trim(),
        disabled: (item as HTMLButtonElement).disabled || item.getAttribute("aria-disabled") === "true",
      })),
    );

    if (role === "alertdialog") {
      const text = `${title} ${(await dialog.textContent()) ?? ""}`;
      const choice = buttons.find((b) => !b.disabled && !CANCEL.test(b.name) && b.name !== "");
      if (!choice || DESTRUCTIVE.test(text)) {
        this.skipped.push(`${where} (decision cancelled)`);
        await this.#press(dialog, buttons.find((b) => CANCEL.test(b.name))?.name);
        return;
      }
      this.submitted.push(`${where} (decision: ${choice.name})`);
      await dialog.locator("button").nth(choice.index).click({ timeout: 3000 });
      return;
    }

    const isForm = (await dialog.locator("form").count()) > 0;
    const hasFooter = (await dialog.locator("div.border-t.border-separator").count()) > 0;
    if (!isForm && !hasFooter) {
      // A panel (the inspector as a sheet, the drawer, "Mais", the help): its controls are walked once.
      await this.#panel(dialog, where);
      return;
    }

    await this.#fill(dialog);
    const submit = [...buttons].reverse().find((b) => !b.disabled && !CANCEL.test(b.name) && b.name !== "");
    if (submit && !DESTRUCTIVE.test(`${title} ${submit.name}`)) {
      await dialog.locator("button").nth(submit.index).click({ timeout: 3000 });
      await this.#page.waitForTimeout(200);
      if ((await dialog.count()) === 0 || !(await dialog.isVisible().catch(() => false))) {
        if (process.env["WALK_TRACE"])
          process.stdout.write(`[trace]   dialog ${where} submitted via ${submit.name}` + "\n");
        this.submitted.push(`${where} (${submit.name})`);
        return;
      }
    }
    // Not submittable with the data we have (or refused): close it.
    const why = (
      (await dialog
        .locator('[role="alert"], [id$="-error"], .text-negative')
        .allTextContents()
        .catch(() => [] as string[])) as string[]
    )
      .map((text) => text.trim())
      .filter(Boolean)
      .join("; ")
      .slice(0, 160);
    this.closed.push(`${where} (${submit ? `refused: ${why || "no message"}` : "nothing to submit"})`);
    if (process.env["WALK_TRACE"]) process.stdout.write(`[trace]   dialog ${this.closed.at(-1)}` + "\n");
    await this.#close(dialog);
  }

  async #panel(dialog: Locator, where: string): Promise<void> {
    const list = await this.#snapshot("dialog[open]", true);
    this.closed.push(`${where} (panel with ${list.length} controls)`);
    for (const candidate of list.filter((c) => !CANCEL.test(c.name) && !c.menu && c.role !== "combobox").slice(0, 8)) {
      const control = this.#page.locator(`dialog[open] [data-walk="${candidate.index}"]`);
      if ((await control.count()) === 0) break;
      this.clicks += 1;
      const before = { errors: this.#errors.length, undo: await this.#depth() };
      try {
        await control.click({ timeout: 3000 });
        await this.#page.waitForTimeout(120);
        // A command in a panel opens a form of its own: answer it, as for any other click.
        for (let round = 0; round < 6; round++) {
          const inner = this.#page.locator("dialog[open]").last();
          if ((await inner.count()) === 0 || (await inner.getAttribute("data-panel")) === "1") break;
          const isInner =
            (await inner.locator("form").count()) > 0 || (await inner.getAttribute("role")) === "alertdialog";
          if (!isInner) break;
          await this.#dialog(inner, `${where} › ${candidate.name}`);
          await this.#page.waitForTimeout(120);
        }
      } catch (error) {
        this.problems.push(`${where} › ${candidate.name}: ${brief(error)}`);
      }
      await this.#verifyQuiet(`${where} › ${candidate.name}`, before);
      if ((await dialog.count()) === 0) return;
    }
    await this.#close(dialog);
  }

  /** Fills the empty fields of a dialog with plausible, valid values. */
  async #fill(dialog: Locator): Promise<void> {
    const fields = await dialog.evaluate((element) => {
      const out: { index: number; kind: string; label: string; type: string; combo: boolean; mode: string }[] = [];
      let index = 0;
      for (const field of element.querySelectorAll<HTMLElement>(
        'input:not([type="checkbox"]):not([type="radio"]):not([type="file"]):not([type="hidden"]), textarea, [role="combobox"]',
      )) {
        const input = field as HTMLInputElement;
        if (input.disabled || input.readOnly) continue;
        if (field.getAttribute("role") === "combobox" && field.tagName !== "INPUT") {
          const text = (field.textContent ?? "").trim();
          if (!/^(selecione|escolha|—|-|)$/i.test(text) && !/^selecion|^escolh/i.test(text)) continue;
        } else if (input.value !== "") continue;
        const label =
          field.getAttribute("aria-label") ?? input.labels?.[0]?.textContent ?? field.getAttribute("placeholder") ?? "";
        field.setAttribute("data-fill", String(index));
        out.push({
          index,
          kind: field.tagName.toLowerCase(),
          label: label.trim(),
          type: input.type ?? "",
          mode: field.getAttribute("inputmode") ?? "",
          combo: field.getAttribute("role") === "combobox" && field.tagName !== "INPUT",
        });
        index += 1;
      }
      return out;
    });
    const files = dialog.locator('input[type="file"]');
    for (let i = 0; i < (await files.count()); i++) {
      const accept = (await files.nth(i).getAttribute("accept")) ?? "";
      if (/csv|text/.test(accept) || accept === "") {
        await files
          .nth(i)
          .setInputFiles({
            name: "serie.csv",
            mimeType: "text/csv",
            buffer: Buffer.from("data;valor\n2026-01-31;1,00\n2026-02-28;1,01\n2026-03-31;1,02\n"),
          })
          .catch(() => undefined);
      }
    }
    for (const field of fields) {
      const target = dialog.locator(`[data-fill="${field.index}"]`);
      try {
        if (field.combo) {
          await target.click({ timeout: 2000 });
          const option = this.#page.getByRole("option").first();
          if (await option.isVisible().catch(() => false)) await option.click({ timeout: 2000 });
          else await this.#page.keyboard.press("Escape");
          continue;
        }
        await target.fill(valueFor(field), { timeout: 2000 });
      } catch {
        // A field that cannot be filled keeps its value; the submit decides.
      }
    }
  }

  async #press(dialog: Locator, name: string | undefined): Promise<void> {
    if (name) {
      await dialog.getByRole("button", { name, exact: true }).first().click({ timeout: 3000 });
    } else {
      await this.#page.keyboard.press("Escape");
    }
  }

  /** Closes a dialog the way a person would: Escape, then its own Cancelar or Fechar. */
  async #close(dialog: Locator): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt++) {
      await this.#page.keyboard.press("Escape");
      await this.#page.waitForTimeout(150);
      const open = this.#page.locator("dialog[open]");
      if ((await open.count()) === 0) return;
      // A "discard the changes?" decision on top of the form: discard.
      const top = open.last();
      if ((await top.getAttribute("role")) === "alertdialog") {
        const choices = await top
          .locator("button")
          .evaluateAll((items) => items.map((i) => i.textContent?.trim() ?? ""));
        const first = choices.find((c) => !CANCEL.test(c));
        if (first) await top.getByRole("button", { name: first, exact: true }).click({ timeout: 2000 });
        await this.#page.waitForTimeout(150);
      }
    }
    void dialog;
  }

  async #recover(): Promise<void> {
    for (let i = 0; i < 4; i++) {
      if ((await this.#page.locator("dialog[open]").count()) === 0) break;
      await this.#page.keyboard.press("Escape");
      await this.#page.waitForTimeout(150);
    }
    await this.#backIfLeft("recover").catch(() => undefined);
    await this.#unlockIfLocked().catch(() => undefined);
  }

  async #verifyQuiet(label: string, before: { errors: number; undo: number }): Promise<void> {
    await this.#verify(label, before);
  }

  /** The rules after one action. */
  async #verify(label: string, before: { errors: number; undo: number }): Promise<void> {
    const page = this.#page;
    const errors = this.#errors.slice(before.errors);
    if (errors.length) this.problems.push(`${label}: console or page errors: ${errors.join(" | ").slice(0, 300)}`);

    if ((await page.locator("dialog[open]").count()) > 0) {
      this.problems.push(`${label}: a modal stayed open`);
      await this.#recover();
    }

    const overflow = await page.evaluate(() => {
      const root = document.documentElement;
      const wide = [...document.querySelectorAll<HTMLElement>("body *")]
        .filter((element) => {
          const rect = element.getBoundingClientRect();
          return rect.width > 0 && rect.right > root.clientWidth + 1 && getComputedStyle(element).position !== "fixed";
        })
        .slice(0, 3)
        .map((element) => `${element.tagName.toLowerCase()}.${element.className.toString().slice(0, 50)}`);
      return { scroll: root.scrollWidth - root.clientWidth, wide };
    });
    if (overflow.scroll > 0) {
      this.problems.push(`${label}: horizontal overflow of ${overflow.scroll}px (${overflow.wide.join(" | ")})`);
    }

    const after = await this.#depth();
    if (before.undo >= 0 && after >= 0) {
      if (after - before.undo > 1) {
        this.problems.push(`${label}: ${after - before.undo} undo steps for one action`);
      } else if (after - before.undo === 1) {
        await this.#proveUndo(label, before.undo, after);
      }
    }
  }

  /** Ctrl+Z reverts the step the action added; the first time on a page, Ctrl+Shift+Z brings it back. */
  async #proveUndo(label: string, depth: number, grown: number): Promise<void> {
    const page = this.#page;
    const read = () => this.#depth();
    await page.keyboard.press("Control+z");
    await page
      .waitForFunction(
        (target) => (window as unknown as { __opesvaultTest?: TestHook }).__opesvaultTest?.undoDepth() === target,
        depth,
        { timeout: 2000 },
      )
      .catch(() => undefined);
    const reverted = await read();
    if (reverted !== depth) {
      this.problems.push(`${label}: Ctrl+Z left ${reverted} undo steps, expected ${depth}`);
      return;
    }
    this.undone += 1;
    if (this.#redoProved) return;
    this.#redoProved = true;
    await page.keyboard.press("Control+Shift+z");
    await page
      .waitForFunction(
        (target) => (window as unknown as { __opesvaultTest?: TestHook }).__opesvaultTest?.undoDepth() === target,
        grown,
        { timeout: 2000 },
      )
      .catch(() => undefined);
    if ((await read()) !== grown) {
      this.problems.push(`${label}: Ctrl+Shift+Z did not bring the step back`);
      return;
    }
    this.redone += 1;
    await page.keyboard.press("Control+z");
    await animationsDone(page);
  }

  /** One line for the test report. */
  summary(): string {
    return (
      `${this.clicks} actions (${this.menuItems} menu items), ${this.submitted.length} dialogs submitted, ` +
      `${this.closed.length} closed, ${this.undone} undone, ${this.redone} redone, ${this.downloads.length} downloads, ` +
      `${this.left.length} left the page, ${this.skipped.length} skipped`
    );
  }
}

function valueFor(field: { label: string; type: string; kind: string; mode: string }): string {
  const text = field.label.toLowerCase();
  if (/cpf/.test(text) && /cnpj/.test(text)) return "11.222.333/0001-81";
  if (/cnpj/.test(text)) return "11.222.333/0001-81";
  if (/cpf/.test(text)) return "529.982.247-25";
  if (field.mode === "decimal" && /%|alíquota|taxa/.test(text)) return "7,5";
  if (field.mode === "decimal") return "100,00";
  if (field.type === "password" || /senha/.test(text)) return DEMO.projectPassword;
  if (field.type === "date") return "2026-10-05";
  if (field.type === "email") return "teste@example.com";
  if (/data|vencimento|competência|início|fim/.test(text)) return "05/10/2026";
  if (/parcelas|prazo|meses|dia\b|dia do/.test(text)) return "12";
  if (/\bano\b/.test(text)) return "2026";
  if (field.type === "number") return "10";
  if (
    /valor|preço|saldo|quantidade|cotas|taxa|%|total|limite|juros|renda|custo|montante|aporte|resgate|meta|orçado|previsto/.test(
      text,
    )
  ) {
    return "100,00";
  }
  if (field.kind === "textarea") return "Teste e2e, motivo registrado.";
  return "Teste e2e";
}

/** The first lines of an error, with the locator call log (what Playwright was waiting for). */
function brief(error: unknown): string {
  return (error as Error).message
    .split("\n")
    .filter((line) => line.trim() !== "")
    .slice(0, 14)
    .map((line) => line.trim())
    .join(" / ")
    .slice(0, 1400);
}
