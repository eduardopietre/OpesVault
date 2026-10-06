/**
 * The local AI (Ollama) from the browser (docs/18 §3.6, desktop `ui/local_ai.py`): the transport is `fetch`
 * to 127.0.0.1 (the CSP allows only loopback; Ollama needs OLLAMA_ORIGINS set to this app's origin), the
 * client comes from the project's settings (Configurações › IA local) and this device's port, and a
 * failure is always a message for the user. Tests and the e2e build never talk to a real Ollama: they
 * replace the transport (`setAiTransport`) or answer the requests themselves.
 */
import { ai, importing, type Ledger } from "@opesvault/domain";
import { usePreferences } from "@opesvault/ui";
import { useLedger } from "./react.tsx";

type Transport = ai.ollama.Transport;

/** Preference key of the Ollama port on this device (docs/16 §4 rule 8: it is not project data). */
export const AI_PORT_KEY = "ia/porta";

export const AI_OFF = "A IA local está desligada ou sem modelo escolhido (Configurações › IA local).";

/** `fetch` as the client needs it. */
export const browserTransport: Transport = async (url, init) => {
  const response = await fetch(url, {
    method: init.method,
    headers: { ...init.headers },
    ...(init.body !== undefined ? { body: init.body } : {}),
    signal: init.signal,
  });
  return { status: response.status, text: () => response.text() };
};

let override: Transport | null = null;

/** Replaces the transport (tests); null puts `fetch` back. */
export function setAiTransport(transport: Transport | null): void {
  override = transport;
}

export function aiTransport(): Transport {
  return override ?? browserTransport;
}

export function portFrom(value: string | null): number {
  const port = Number(value);
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : ai.ollama.DEFAULT_PORT;
}

/** The model this project asks, on this device's port; null when the AI is off. */
export function aiClientFor(
  ledger: Ledger,
  port: number = ai.ollama.DEFAULT_PORT,
  transport: Transport = aiTransport(),
): ai.ollama.OllamaClient | null {
  try {
    return importing.aiSuggestions.clientFromSettings(ledger, transport, ai.ollama.localUrl(port));
  } catch (error) {
    if (error instanceof ai.ollama.AiUnavailable) return null;
    throw error;
  }
}

/** The client of the open project, recomputed when the settings change. Null: the AI is off. */
export function useAiClient(): ai.ollama.OllamaClient | null {
  const port = portFrom(usePreferences().get(AI_PORT_KEY));
  return useLedger((ledger) => aiClientFor(ledger, port), port);
}

/** Records the model as used in this session (it is unloaded when the project closes). */
export function rememberModel(client: ai.ollama.OllamaClient): void {
  importing.aiSuggestions.rememberUsed(client, aiTransport());
}

export function failureText(result: unknown): string {
  return result instanceof ai.ollama.AiUnavailable ? result.message : "A consulta à IA local falhou.";
}

/** 'ollama:gemma4:12b:p4@…' → 'gemma4:12b'. */
export function modelLabel(source: string | null | undefined): string {
  if (!source || !source.startsWith("ollama:")) return "";
  const parts = (source.split("@")[0] ?? "").split(":");
  return parts.slice(1, -1).join(":") || (parts.at(-1) ?? "");
}

export function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}
