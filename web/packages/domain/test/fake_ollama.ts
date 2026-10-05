/**
 * A local stand-in for the Ollama HTTP API, as a `Transport`. Port of `tests/fake_ollama.py`:
 * the same routes and switches, without a socket. Tests never talk to a real Ollama.
 */
import type { Transport, TransportInit } from "../src/ai/ollama.ts";

export class FakeOllama {
  answer = "";
  /** Consumed in order before `answer`. */
  answers: string[] = [];
  /** Request bodies received (POST only), parsed. */
  received: Record<string, unknown>[] = [];
  /** URLs called, in order. */
  urls: string[] = [];
  rejectThink = false;
  missingModel = false;
  gpuShare = 100; // percent of the loaded model in the GPU, reported by /api/ps
  /** Assistant messages (tool calls) consumed in order by /api/chat with tools. */
  messages: Record<string, unknown>[] = [];
  capabilities: string[] | null = ["completion", "tools"];
  /** The raw text of the next /api/chat answer body, when set (malformed bodies). */
  rawBody: string | null = null;

  readonly transport: Transport = async (url: string, init: TransportInit) => {
    this.urls.push(url);
    if (
      !url.startsWith("http://127.0.0.1:") &&
      !url.startsWith("http://localhost:") &&
      !url.startsWith("http://[::1]:")
    )
      throw new TypeError("fetch failed"); // nothing else exists for this fake
    const path = url.replace(/^http:\/\/[^/]+/, "");
    if (init.signal.aborted) throw new DOMException("aborted", "AbortError");
    if (init.method === "GET") return this.get(path);
    const body = JSON.parse(init.body ?? "{}") as Record<string, unknown>;
    this.received.push(body);
    return this.post(path, body);
  };

  private send(code: number, payload: unknown) {
    const text = typeof payload === "string" ? payload : JSON.stringify(payload);
    return { status: code, text: () => Promise.resolve(text) };
  }

  private get(path: string) {
    if (path === "/api/version") return this.send(200, { version: "0.35.1" });
    if (path === "/api/ps") {
      const size = 8 * 2 ** 30;
      const vram = Math.floor((size * this.gpuShare) / 100);
      return this.send(200, { models: [{ name: "gemma4:12b", size, size_vram: vram }] });
    }
    const models = [{ name: "gemma4:12b", digest: "sha256:0123456789abcdef" }, { name: "gpt-oss:120b-cloud" }];
    return this.send(200, { models: [...models, { name: "qwen3.5:9b" }] });
  }

  private post(path: string, body: Record<string, unknown>) {
    if (this.missingModel) return this.send(404, { error: `model '${String(body["model"])}' not found` });
    if (path === "/api/show")
      return this.send(200, this.capabilities === null ? {} : { capabilities: this.capabilities });
    if (path === "/api/chat" && "tools" in body && this.messages.length) {
      if (this.rawBody !== null) {
        const raw = this.rawBody;
        this.rawBody = null;
        return this.send(200, raw);
      }
      return this.send(200, { message: { role: "assistant", ...this.messages.shift() } });
    }
    if (path === "/api/generate") return this.send(200, { model: body["model"], done: true }); // load or unload
    if (this.rejectThink && "think" in body)
      return this.send(400, { error: `${String(body["model"])} does not support thinking` });
    const content = this.answers.length ? this.answers.shift()! : this.answer;
    return this.send(200, { message: { role: "assistant", content } });
  }
}

/** Nothing listening: every call fails as `fetch` does when the connection is refused. */
export const offline: Transport = () => Promise.reject(new TypeError("fetch failed"));

/** A server that never answers: the client's timeout must abort it. */
export const silent: Transport = (_url, init) =>
  new Promise((_resolve, reject) => {
    init.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
  });
