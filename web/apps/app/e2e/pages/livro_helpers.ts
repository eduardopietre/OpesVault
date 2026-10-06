/** Helpers of the Livro's end-to-end tests. */
import { expect, type Page } from "@playwright/test";

/** Searches for a description and selects the first row with the keyboard. */
export async function pickRow(page: Page, text: string): Promise<void> {
  await page.getByRole("searchbox", { name: "Buscar lançamentos" }).fill(text);
  await expect(page.locator("[data-row-id]").first()).toContainText(text);
  await page.locator('[role="grid"], [role="listbox"]').first().focus();
  await page.keyboard.press("ArrowDown");
}

/**
 * Answers the requests to the local Ollama (127.0.0.1) like a model that maps every description to one
 * category and gives every merchant a name made of its own words; nothing ever reaches a real Ollama.
 */
export async function fakeOllama(page: Page, options: { category?: string } = {}): Promise<void> {
  const category = options.category ?? "Lazer";
  await page.route(/^http:\/\/(127\.0\.0\.1|localhost):11434\//, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const cors = {
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "*",
      "access-control-allow-methods": "GET, POST, OPTIONS",
    };
    if (request.method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
    const json = (body: unknown) =>
      route.fulfill({
        status: 200,
        headers: { ...cors, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    if (url.pathname === "/api/version") return json({ version: "0.35.1" });
    if (url.pathname === "/api/tags") {
      return json({ models: [{ name: "gemma4:12b", digest: "sha256:0123456789abcdef" }] });
    }
    if (url.pathname === "/api/ps") return json({ models: [] });
    if (url.pathname === "/api/generate") return json({ done: true });
    if (url.pathname === "/api/chat") {
      const body = JSON.parse(request.postData() ?? "{}") as {
        messages?: { content?: string }[];
        format?: { properties?: Record<string, unknown> };
      };
      const prompt = body.messages?.map((m) => m.content ?? "").join("\n") ?? "";
      const lines = [...prompt.matchAll(/^(\d+): (.*)$/gm)].map((m) => ({ index: Number(m[1]), text: m[2] ?? "" }));
      if (body.format?.properties?.["names"]) {
        // A name made of the description's own words, as the client requires.
        const names = lines.map(({ index, text }) => ({
          index,
          name: `${text.match(/[A-Za-zÀ-ú]{3,}/)?.[0] ?? "Loja"} Online`,
        }));
        return json({ message: { role: "assistant", content: JSON.stringify({ names }) } });
      }
      const suggestions = lines.map(({ index }) => ({ index, category }));
      return json({ message: { role: "assistant", content: JSON.stringify({ suggestions }) } });
    }
    return route.fulfill({ status: 404, headers: cors, body: "{}" });
  });
}
