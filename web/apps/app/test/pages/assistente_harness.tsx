/** Mounts the Assistente with the demonstration project and a scripted model that stands in for Ollama. */
import type { ai, Operation } from "@opesvault/domain";
import { screen, waitFor, within } from "@testing-library/react";
import { expect } from "vitest";
import { setAiTransport } from "../../src/data/ai.ts";
import { setServerProbe } from "../../src/pages/assistente/reach.ts";
import { mountApp, type MountOptions } from "../mount.tsx";

type Transport = ai.ollama.Transport;

export interface Turn {
  content?: string;
  calls?: { name: string; arguments: unknown }[];
}

/** The Ollama HTTP API as a `Transport`: the model answers the scripted turns, one per `/api/chat`. */
export class ScriptedModel {
  turns: (Turn | (() => Turn))[] = [];
  /** `/api/show` declares tool calling. */
  tools = true;
  /** The server does not answer (a network error, as `fetch` raises it). */
  down = false;
  /** When set, `/api/chat` waits for it (a slow model). */
  gate: Promise<void> | null = null;
  chats: Record<string, unknown>[] = [];

  readonly transport: Transport = async (url, init) => {
    if (this.down) throw new TypeError("Failed to fetch");
    const path = url.replace(/^http:\/\/[^/]+/, "");
    const send = (payload: unknown, status = 200) => ({ status, text: () => Promise.resolve(JSON.stringify(payload)) });
    if (init.method === "GET") {
      if (path === "/api/version") return send({ version: "0.35.1" });
      return send({ models: [{ name: "gemma4:12b", digest: "sha256:0123456789abcdef" }] });
    }
    const body = JSON.parse(init.body ?? "{}") as Record<string, unknown>;
    if (path === "/api/show") return send({ capabilities: this.tools ? ["completion", "tools"] : ["completion"] });
    if (path === "/api/generate") return send({ done: true });
    this.chats.push(body);
    if (this.gate) await this.gate;
    const next = this.turns.shift();
    const turn = typeof next === "function" ? next() : (next ?? { content: "Sem resposta roteirizada." });
    return send({
      message: {
        role: "assistant",
        content: turn.content ?? "",
        ...(turn.calls
          ? { tool_calls: turn.calls.map((c) => ({ function: { name: c.name, arguments: c.arguments } })) }
          : {}),
      },
    });
  };

  /** Every request of the conversation, as text (to check what reached the model). */
  sent(): string {
    return JSON.stringify(this.chats);
  }
}

export function useScriptedModel(): ScriptedModel {
  const model = new ScriptedModel();
  setAiTransport(model.transport);
  setServerProbe(() => Promise.resolve(false));
  return model;
}

export function resetModel(): void {
  setAiTransport(null);
  setServerProbe(null);
}

export async function openAssistente(options: MountOptions & { path?: string } = {}) {
  const { path, ...mount } = options;
  return mountApp(path ?? "/assistente", { width: 1600, heading: "Assistente", ...mount });
}

export type Opened = Awaited<ReturnType<typeof openAssistente>>;

/** Types a question and sends it with the button. */
export async function ask(o: Opened, text: string) {
  const box = screen.getByRole("textbox", { name: "Pergunta ao assistente" });
  await o.user.clear(box);
  await o.user.type(box, text);
  await o.user.click(screen.getByRole("button", { name: "Enviar" }));
}

export const log = () => screen.getByRole("log", { name: "Conversa com o assistente" });
export const said = (text: string | RegExp) => within(log()).findByText(text);

/** The model is not working any more. */
export async function idle() {
  await waitFor(() => expect(screen.queryByRole("button", { name: "Cancelar" })).toBeNull());
}

export const opsNamed = (o: Opened, description: string): Operation[] =>
  [...o.workspace.ledger.operations.values()].filter((op) => op.description === description);

/** The 8-character id the tools use for an operation. */
export const shortId = (op: { id: string }) => op.id.replaceAll("-", "").slice(0, 8);
