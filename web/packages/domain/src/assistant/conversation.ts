/**
 * One conversation with the local model and its tools, step by step (no UI, no threads).
 * Port of `assistant/conversation.py`.
 *
 * The page drives it the same way as every other AI task (docs/05 §5):
 *
 * 1. `ask` adds the user's question; `request` copies the messages to send (UI thread);
 * 2. the model answers in the background (`OllamaClient.chatTools`), never touching the ledger;
 * 3. `receive` reads the answer on the UI thread: reads run at once, edits come back as `Pending`
 *    for the user to approve or refuse (`resolve`), and a final text is the answer.
 *
 * An invalid answer (unknown tool, wrong arguments, an empty reply, a tool call written as text)
 * goes back to the model as an error, so it can correct itself. After `MAX_ATTEMPTS` invalid answers
 * in a row the question is interrupted; a valid answer resets the count. `MAX_STEPS` bounds how many
 * times the model is asked for one question, so a loop cannot run forever. Nothing of the
 * conversation is stored: it lives in memory and goes away with the vault.
 */
import type { ModelTurn } from "../ai/ollama.ts";
import { DomainError, type Ledger } from "../domain/ledger.ts";
import { type IsoDate, today as localToday } from "../lib/dates.ts";
import { strip } from "../lib/py.ts";
import * as edits from "./edits.ts";
import * as reads from "./reads.ts";
import { type PreparedEdit, Registry, ToolError, resultText } from "./tools.ts";

export const MAX_ATTEMPTS = 3;
export const MAX_STEPS = 12;
export const MAX_MESSAGES = 60; // older turns are dropped (whole questions), so the context stays small

export function defaultRegistry(): Registry {
  const registry = new Registry();
  reads.register(registry);
  edits.register(registry);
  return registry;
}

/** An edit waiting for the user: approve runs it, refuse tells the model it was refused. */
export interface Pending {
  readonly tool: string;
  readonly edit: PreparedEdit;
  resolved: boolean;
}

/** What the page does after one answer of the model. */
export interface Step {
  /** The final text for the user. */
  answer: string | null;
  /** One line per tool used, shown in the transcript. */
  activity: string[];
  pending: Pending[];
  /** (label, Livro filter) to offer. */
  links: [string, reads.LedgerLink][];
  /** The question was interrupted, and why. */
  stop: string | null;
}

/** The model must be asked again (after the pending edits are resolved). */
export function again(step: Step): boolean {
  return step.answer === null && step.stop === null;
}

export type Message = Record<string, unknown>;

export class Conversation {
  readonly registry: Registry;
  messages: Message[] = [];
  invalid = 0; // invalid answers in a row
  steps = 0; // answers received for the current question
  private readonly clock: () => IsoDate;

  /** `today` is Python's `date.today()`: tools that look at the calendar read it through here. */
  constructor(registry: Registry | null = null, today: () => IsoDate = () => localToday()) {
    this.registry = registry ?? defaultRegistry();
    this.clock = today;
  }

  reset(): void {
    this.messages.length = 0;
    this.invalid = this.steps = 0;
  }

  ask(text: string): void {
    this.trim();
    this.messages.push({ role: "user", content: strip(text) });
    this.invalid = this.steps = 0;
  }

  request(): Message[] {
    return this.messages.map((m) => ({ ...m }));
  }

  tools(): Record<string, unknown>[] {
    return this.registry.ollamaList();
  }

  private trim(): void {
    while (this.messages.length > MAX_MESSAGES) {
      this.messages.shift();
      while (this.messages.length && this.messages[0]!["role"] !== "user") this.messages.shift();
    }
  }

  private toolMessage(name: string, data: unknown): void {
    this.messages.push({ role: "tool", tool_name: name, content: resultText(data) });
  }

  private invalidAnswer(step: Step, reason: string): Step {
    this.invalid += 1;
    step.activity.push(`Resposta inválida do modelo (${this.invalid} de ${MAX_ATTEMPTS}): ${reason}`);
    if (this.invalid >= MAX_ATTEMPTS) {
      step.pending.length = 0;
      step.stop = `A IA local errou ${MAX_ATTEMPTS} vezes seguidas e a pergunta foi interrompida. ${reason}`;
    }
    return step;
  }

  receive(turn: ModelTurn, ledger: Ledger, origin: string): Step {
    this.steps += 1;
    const step: Step = { answer: null, activity: [], pending: [], links: [], stop: null };
    if (!turn.tool_calls.length) {
      const content = strip(turn.content);
      let reason: string | null = null;
      if (!content) reason = "resposta vazia; responda ao usuário ou chame uma ferramenta.";
      else if (looksLikeCall(content))
        reason = "chamada de ferramenta escrita como texto; use o mecanismo de ferramentas.";
      if (reason === null) {
        this.messages.push({ role: "assistant", content });
        this.invalid = 0;
        step.answer = content;
        return step;
      }
      if (content) this.messages.push({ role: "assistant", content });
      this.messages.push({ role: "user", content: `Erro do aplicativo (não do usuário): ${reason}` });
      return this.limit(this.invalidAnswer(step, reason));
    }

    this.messages.push({ ...turn.raw });
    const errors: string[] = [];
    const ctx = { today: this.clock() };
    for (const call of turn.tool_calls) {
      try {
        const [tool, args] = this.registry.parse(call.name, call.arguments);
        if (tool.run !== null) {
          let data: unknown = run(() => tool.run!(ledger, args, ctx));
          if (call.name === "show_in_ledger") {
            const shown = data as { link: reads.LedgerLink; rotulo: string };
            step.links.push([shown.rotulo, shown.link]);
            data = { resultado: "botão oferecido ao usuário", rotulo: shown.rotulo };
          }
          this.toolMessage(call.name, data);
          step.activity.push(`Consultou ${call.name}${count(data)}`);
        } else if (tool.prepare !== null) {
          const edit = run(() => tool.prepare!(ledger, args, origin, ctx));
          step.pending.push({ tool: call.name, edit, resolved: false });
        }
      } catch (error) {
        if (!(error instanceof ToolError)) throw error;
        errors.push(`${call.name || "?"}: ${error.message}`);
        this.toolMessage(call.name || "?", { erro: error.message });
      }
    }
    if (errors.length) return this.limit(this.invalidAnswer(step, errors.join(" ")));
    this.invalid = 0;
    return this.limit(step);
  }

  private limit(step: Step): Step {
    if (again(step) && this.steps >= MAX_STEPS) {
      step.pending.length = 0;
      step.stop = `A IA local passou de ${MAX_STEPS} passos nesta pergunta e foi interrompida.`;
    }
    return step;
  }

  /** Runs (or refuses) one edit and tells the model what happened. Returns the transcript line. */
  resolve(pending: Pending, approved: boolean): string {
    pending.resolved = true;
    if (!approved) {
      this.toolMessage(pending.tool, { resultado: "recusado pelo usuário; nada mudou" });
      return `Você recusou: ${pending.edit.summary}`;
    }
    let outcome: unknown;
    try {
      outcome = run(pending.edit.apply);
    } catch (error) {
      if (!(error instanceof ToolError)) throw error;
      this.toolMessage(pending.tool, { erro: error.message });
      return `Não foi possível aplicar: ${error.message}`;
    }
    this.toolMessage(pending.tool, outcome);
    return `Aplicado: ${pending.edit.summary}`;
  }
}

/** Domain refusals become ToolErrors, as `_run` does on the desktop. */
function run<T>(action: () => T): T {
  try {
    return action();
  } catch (error) {
    if (error instanceof DomainError) throw new ToolError(error.message);
    throw error;
  }
}

function looksLikeCall(text: string): boolean {
  // `text.lstrip("`").lstrip().lower()`
  const left = text
    .replace(/^`+/, "")
    // eslint-disable-next-line no-control-regex -- Python counts U+001C..U+001F as whitespace
    .replace(/^[\s\u001c-\u001f\u0085]+/u, "")
    .toLowerCase();
  return (
    (left.startsWith("{") && left.includes('"name"')) || left.startsWith("<tool_call>") || left.startsWith("[tool_call")
  );
}

function count(data: unknown): string {
  if (data !== null && typeof data === "object" && !Array.isArray(data)) {
    const total = (data as Record<string, unknown>)["total"];
    if (typeof total === "number" && Number.isInteger(total)) return ` (${total} encontrado(s))`;
  }
  return "";
}
