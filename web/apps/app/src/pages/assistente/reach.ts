/**
 * Why the local model did not answer, in words the person can act on (docs/18 §3.6). From a page, a server
 * that is off and a server that refuses this page's origin look the same to `fetch` (a network error), so
 * the failure is told apart by a second, opaque request: with `no-cors` it succeeds when something answers
 * at the address, whatever the CORS headers say. Answering means Ollama is running and `OLLAMA_ORIGINS`
 * does not list this origin.
 */
import { ai } from "@opesvault/domain";

export type ProblemKind = "unreachable" | "origin" | "no-tools" | "model-missing" | "timeout" | "other";

export interface Problem {
  kind: ProblemKind;
  title: string;
  /** The words of the domain when there are no better ones. */
  detail: string;
  /** The address asked (`http://127.0.0.1:11434`). */
  url: string;
  /** The origin to allow, for `origin`. */
  origin?: string;
}

export type Probe = (url: string, signal: AbortSignal) => Promise<boolean>;

/** True when something answers at `url` (even a page that is not allowed to read the answer). */
export const browserProbe: Probe = async (url, signal) => {
  try {
    await fetch(`${url}/api/version`, { mode: "no-cors", signal, cache: "no-store" });
    return true;
  } catch {
    return false;
  }
};

let override: Probe | null = null;

/** Replaces the probe (tests); null puts the real one back. */
export function setServerProbe(probe: Probe | null): void {
  override = probe;
}

/** The origin of this page, as `OLLAMA_ORIGINS` wants it. */
export function pageOrigin(): string {
  return window.location.origin;
}

const PROBE_TIMEOUT_MS = 3000;

async function answers(url: string): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    return await (override ?? browserProbe)(url, controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

/** Reads the failure of the model's client. `url` is the address it asked. */
export async function explain(error: ai.ollama.AiUnavailable, url: string): Promise<Problem> {
  const text = error.message;
  if (/não aceita ferramentas/.test(text)) {
    return { kind: "no-tools", title: "O modelo não aceita ferramentas", detail: text, url };
  }
  if (/não está instalado/.test(text)) {
    return { kind: "model-missing", title: "O modelo não está instalado", detail: text, url };
  }
  if (/demorou demais/.test(text)) {
    return { kind: "timeout", title: "O Ollama demorou para responder", detail: text, url };
  }
  if (/indispon/.test(text)) {
    if (await answers(url)) {
      return {
        kind: "origin",
        title: "O Ollama não aceita este endereço do aplicativo",
        detail: text,
        url,
        origin: pageOrigin(),
      };
    }
    return { kind: "unreachable", title: "Não foi possível falar com o Ollama", detail: text, url };
  }
  return { kind: "other", title: "A IA local não respondeu", detail: text, url };
}
