/**
 * A stand-in for the Ollama HTTP API as a `Transport` (the domain's `fake_ollama.ts`, trimmed): the tests of
 * the screens never talk to a real Ollama.
 */
import type { ai } from "@opesvault/domain";

type Transport = ai.ollama.Transport;

export class FakeOllama {
  /** Consumed in order before `answer`. */
  answers: string[] = [];
  answer = "";
  received: Record<string, unknown>[] = [];
  /** When set, builds the answer from the request (see `smart`). */
  handler: ((body: Record<string, unknown>) => unknown) | null = null;

  readonly transport: Transport = (url, init) => {
    const path = url.replace(/^http:\/\/[^/]+/, "");
    const send = (code: number, payload: unknown) =>
      Promise.resolve({ status: code, text: () => Promise.resolve(JSON.stringify(payload)) });
    if (init.method === "GET") {
      if (path === "/api/version") return send(200, { version: "0.35.1" });
      return send(200, { models: [{ name: "gemma4:12b", digest: "sha256:0123456789abcdef" }] });
    }
    const body = JSON.parse(init.body ?? "{}") as Record<string, unknown>;
    this.received.push(body);
    if (path === "/api/generate") return send(200, { done: true });
    const content = this.handler
      ? JSON.stringify(this.handler(body))
      : this.answers.length
        ? this.answers.shift()
        : this.answer;
    return send(200, { message: { role: "assistant", content } });
  };

  /**
   * Maps every description it is asked about to `category`, and gives every merchant a name made of its own
   * first word, like a model would.
   */
  smart(category: string): void {
    this.handler = (body) => {
      const messages = (body["messages"] as { content?: string }[] | undefined) ?? [];
      const prompt = messages.map((m) => m.content ?? "").join("\n");
      const lines = [...prompt.matchAll(/^(\d+): (.*)$/gm)].map((m) => ({ index: Number(m[1]), text: m[2] ?? "" }));
      const format = body["format"] as { properties?: Record<string, unknown> } | undefined;
      if (format?.properties?.["names"]) {
        return {
          names: lines.map(({ index, text }) => ({
            index,
            name: `${text.match(/[A-Za-zÀ-ú]{3,}/)?.[0] ?? "Loja"} Online`,
          })),
        };
      }
      return { suggestions: lines.map(({ index }) => ({ index, category })) };
    };
  }

  /** Answers every categories question with this category for each listed description. */
  say(value: unknown): void {
    this.answer = JSON.stringify(value);
  }
}
