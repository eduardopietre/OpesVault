/** Helpers of the Assistente's end-to-end tests: a scripted stand-in for Ollama, answered by Playwright routes. */
import { expect, type Page } from "@playwright/test";

export interface Turn {
  content?: string;
  calls?: { name: string; arguments: unknown }[];
}

type ChatBody = { messages?: { role?: string; content?: string }[] };

/** How the stand-in behaves: a model that answers, a server that is off, one that refuses this origin, or a model without tools. */
export type Mode = "ok" | "down" | "origin" | "no-tools";

export interface Scripted {
  mode: Mode;
  /** One per `/api/chat`, in order; a function sees the request (to read ids from earlier tool results). */
  turns: (Turn | ((body: ChatBody) => Turn))[];
  /** Requests received on `/api/chat`. */
  chats: ChatBody[];
  /** When set, `/api/chat` waits for it. */
  hold(): () => void;
}

/** The 8-character id of the first operation a `search_operations` result lists. */
export function firstIdOf(body: ChatBody): string {
  const tool = [...(body.messages ?? [])].reverse().find((m) => m.role === "tool");
  const match = /"id":"([0-9a-f]{8})"/.exec(tool?.content ?? "");
  if (!match) throw new Error(`no operation id in the last tool result: ${tool?.content?.slice(0, 200)}`);
  return match[1] as string;
}

/**
 * Answers the requests to the local Ollama (127.0.0.1) like a scripted model. Nothing ever reaches a real
 * Ollama. Returns the script to push turns into and to inspect what the page sent.
 */
export async function scriptedOllama(page: Page, mode: Mode = "ok"): Promise<Scripted> {
  let gate: Promise<void> | null = null;
  const script: Scripted = {
    mode,
    turns: [],
    chats: [],
    hold() {
      let release!: () => void;
      gate = new Promise<void>((resolve) => (release = resolve));
      return () => {
        gate = null;
        release();
      };
    },
  };
  await page.route(/^http:\/\/(127\.0\.0\.1|localhost):11434\//, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (script.mode === "down") return route.abort("connectionrefused");
    // Ollama is running but this page's origin is not in OLLAMA_ORIGINS: it allows another origin only
    // (Playwright adds a permissive header to a response that has none, so the header must be there).
    const cors =
      script.mode === "origin"
        ? { "access-control-allow-origin": "https://outro-site.example", "access-control-allow-headers": "*" }
        : {
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
    switch (url.pathname) {
      case "/api/version":
        return json({ version: "0.35.1" });
      case "/api/tags":
        return json({ models: [{ name: "gemma4:12b", digest: "sha256:0123456789abcdef" }] });
      case "/api/show":
        return json({ capabilities: script.mode === "no-tools" ? ["completion"] : ["completion", "tools"] });
      case "/api/ps":
        return json({ models: [] });
      case "/api/generate":
        return json({ done: true });
      case "/api/chat": {
        const body = JSON.parse(request.postData() ?? "{}") as ChatBody;
        script.chats.push(body);
        while (gate) await gate;
        const next = script.turns.shift();
        const turn = typeof next === "function" ? next(body) : (next ?? { content: "Sem resposta roteirizada." });
        return json({
          message: {
            role: "assistant",
            content: turn.content ?? "",
            ...(turn.calls
              ? { tool_calls: turn.calls.map((c) => ({ function: { name: c.name, arguments: c.arguments } })) }
              : {}),
          },
        });
      }
      default:
        return route.fulfill({ status: 404, headers: cors, body: "{}" });
    }
  });
  return script;
}

/** Types a question and sends it. */
export async function ask(page: Page, text: string): Promise<void> {
  const box = page.getByRole("textbox", { name: "Pergunta ao assistente" });
  await box.fill(text);
  await page.getByRole("button", { name: "Enviar" }).click();
}

/** The model has finished: no "Cancelar" in the status row. */
export async function idle(page: Page): Promise<void> {
  await expect(page.getByRole("button", { name: "Cancelar" })).toHaveCount(0);
}
